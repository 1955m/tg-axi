import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiveCommand, RECEIVE_HELP } from "./receive.js";
import type { TgContext } from "../context.js";
import type { TgUpdate } from "../tg.js";

const ENV = [
  "TG_OFFSET_FILE",
  "TG_INBOX_DIR",
  "TG_ACCESS_FILE",
  "TG_ALLOW_FROM",
  "TG_TOKEN_FILE",
  "TELEGRAM_BOT_TOKEN",
];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

let dir: string;
const CTX: TgContext = { token: "test-token", chatId: "123456789" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-axi-recv-cmd-"));
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env["TG_OFFSET_FILE"] = join(dir, "offset");
  process.env["TG_INBOX_DIR"] = join(dir, "inbox");
  process.env["TG_ACCESS_FILE"] = join(dir, "access.json");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

interface MockResp {
  status: number;
  json?: unknown;
  bytes?: Buffer;
  okEnvelope?: boolean;
  errorDescription?: string;
}
function mockResponse(r: MockResp): Response {
  const isFile = r.bytes !== undefined;
  const body = isFile
    ? ""
    : JSON.stringify(
        r.okEnvelope === false
          ? { ok: false, error_code: r.status, description: r.errorDescription ?? "err" }
          : { ok: true, result: r.json },
      );
  const ab = new ArrayBuffer(r.bytes?.length ?? 0);
  if (r.bytes) new Uint8Array(ab).set(r.bytes);
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(ab),
  } as Response;
}
function ok(json: unknown): MockResp {
  return { status: 200, json };
}
function fail(code: number, desc: string): MockResp {
  return { status: code, okEnvelope: false, errorDescription: desc };
}
function mockFetch(handler: (url: string, init: RequestInit) => MockResp): void {
  globalThis.fetch = ((url: string, init: RequestInit) =>
    Promise.resolve(mockResponse(handler(url, init)))) as unknown as typeof fetch;
}

const UPDATES: TgUpdate[] = [
  {
    update_id: 50,
    message: {
      message_id: 1,
      from: { id: 1, username: "alice", first_name: "A" },
      chat: { id: 123456789, type: "private" },
      date: 1700,
      text: "hello",
    },
  },
];

describe("receiveCommand", () => {
  it("returns a plain object the runtime TOON-serializes (received/offset/messages)", async () => {
    mockFetch(() => ok(UPDATES));
    const out = await receiveCommand([], CTX);
    expect(out).not.toBeTypeOf("string");
    const obj = out as Record<string, unknown>;
    expect(obj["received"]).toBe(1);
    expect(obj["offset"]).toBe(51);
    expect(Array.isArray(obj["messages"])).toBe(true);
    expect(obj["allow"]).toBe("default"); // no access.json present → default source
    expect(Array.isArray(obj["help"])).toBe(true);
  });

  it("--json returns a JSON string", async () => {
    mockFetch(() => ok(UPDATES));
    const out = await receiveCommand(["--json"], CTX);
    expect(out).toBeTypeOf("string");
    const parsed = JSON.parse(out as string) as Record<string, unknown>;
    expect(parsed["received"]).toBe(1);
    expect(parsed["offset"]).toBe(51);
  });

  it("--drop-pending-webhook calls deleteWebhook then drains (webhook: deleted)", async () => {
    const calls: string[] = [];
    mockFetch((url) => {
      calls.push(url.includes("/deleteWebhook") ? "deleteWebhook" : "getUpdates");
      return url.includes("/deleteWebhook") ? ok(true) : ok(UPDATES);
    });
    const out = await receiveCommand(["--drop-pending-webhook"], CTX);
    const obj = out as Record<string, unknown>;
    expect(calls).toContain("deleteWebhook");
    expect(calls).toContain("getUpdates");
    expect(obj["webhook"]).toBe("deleted");
    expect(obj["received"]).toBe(1);
  });

  it("rejects an invalid --limit with VALIDATION_ERROR", async () => {
    await expect(receiveCommand(["--limit", "0"], CTX)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(receiveCommand(["--limit", "101"], CTX)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("rejects an invalid --timeout with VALIDATION_ERROR", async () => {
    await expect(receiveCommand(["--timeout", "-1"], CTX)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(receiveCommand(["--timeout", "51"], CTX)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("--help returns the RECEIVE_HELP text", async () => {
    const out = await receiveCommand(["--help"], CTX);
    expect(out).toBe(RECEIVE_HELP);
  });

  it("rejects an unknown flag with VALIDATION_ERROR (P6: fail loud)", async () => {
    await expect(receiveCommand(["--bogus"], CTX)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("surfaces a 409 conflict as a structured AxiError (VALIDATION_ERROR)", async () => {
    mockFetch(() => fail(409, "Conflict: terminated by other getUpdates request"));
    await expect(receiveCommand([], CTX)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("throws AUTH_REQUIRED when no token is present", async () => {
    await expect(
      receiveCommand([], { token: undefined, chatId: "123456789" }),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("honor --inbox / --offset-file overrides", async () => {
    const inbox = join(dir, "custom-inbox");
    const off = join(dir, "custom-offset");
    mockFetch(() => ok(UPDATES));
    const out = (await receiveCommand(["--inbox", inbox, "--offset-file", off], CTX)) as Record<
      string,
      unknown
    >;
    expect(out["inbox"]).toBe(inbox);
    expect(out["offset"]).toBe(51);
  });
});
