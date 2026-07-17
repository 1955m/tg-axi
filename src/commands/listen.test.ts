import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenCommand, LISTEN_HELP } from "./listen.js";
import { listenUpdates, type DrainResult, type ReceiveOptions } from "../receive.js";
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
const CTX = { token: "test-token", chatId: "123456789" };
const ALLOW = { set: new Set(["123456789"]), source: "access.json" as const };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-axi-listen-"));
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function opts(over: Partial<ReceiveOptions> = {}): ReceiveOptions {
  return {
    allow: ALLOW,
    inboxDir: join(dir, "inbox"),
    offsetFile: join(dir, "offset"),
    limit: 100,
    timeout: 0,
    ...over,
  };
}

interface MockResp { status: number; json?: unknown; bytes?: Buffer; okEnvelope?: boolean; errorDescription?: string; }
function mockResponse(r: MockResp): Response {
  const isFile = r.bytes !== undefined;
  const body = isFile ? "" : JSON.stringify(
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
function ok(json: unknown): MockResp { return { status: 200, json }; }
function fail(code: number, desc: string): MockResp { return { status: code, okEnvelope: false, errorDescription: desc }; }
function mockFetch(handler: (url: string, init: RequestInit) => MockResp | Promise<MockResp>): void {
  globalThis.fetch = ((url: string, init: RequestInit) =>
    Promise.resolve(handler(url, init)).then(mockResponse)) as unknown as typeof fetch;
}

function update(id: number, text: string): TgUpdate {
  return { update_id: id, message: { message_id: id, from: { id: 1, username: "u", first_name: "U" }, chat: { id: 123456789, type: "private" }, date: 1700, text } };
}

describe("listenUpdates", () => {
  it("emits each non-empty batch and advances the offset per batch", async () => {
    const emitted: DrainResult[] = [];
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { offset?: number };
      const off = body.offset ?? 0;
      return off === 0 ? ok([update(10, "a")]) : ok([]);
    });
    let stop = false;
    const summary = await listenUpdates(
      CTX,
      opts(),
      (r) => { emitted.push(r); stop = true; },
      () => stop,
    );
    expect(summary.batches).toBe(1);
    expect(summary.messages).toBe(1);
    expect(emitted.length).toBe(1);
    expect(emitted[0].messages[0].text).toBe("a");
  });

  it("terminates an all-empty short-poll loop when shouldStop flips", async () => {
    let calls = 0;
    mockFetch(() => ok([]));
    const summary = await listenUpdates(
      CTX,
      opts(),
      () => undefined,
      () => { calls++; return calls > 1; }, // run 1 empty batch, then stop
    );
    expect(summary.batches).toBe(1);
    expect(summary.messages).toBe(0);
  });

  it("retries a transient (5xx) drain with backoff, then succeeds and stops after emit", async () => {
    let getUpdatesCalls = 0;
    let sleepCalls = 0;
    mockFetch((url) => {
      if (url.includes("/getUpdates")) {
        getUpdatesCalls++;
        if (getUpdatesCalls === 1) return fail(503, "Internal Server Error"); // 5xx → UNKNOWN → transient
        return ok([update(30, "c")]);
      }
      return ok([]);
    });
    let stop = false;
    const summary = await listenUpdates(
      CTX,
      opts({ requestOpts: { sleep: async () => { sleepCalls++; } } }),
      () => { stop = true; },
      () => stop,
    );
    expect(getUpdatesCalls).toBe(2);
    expect(sleepCalls).toBe(1);
    expect(summary.batches).toBe(1);
    expect(summary.messages).toBe(1);
  });

  it("propagates a 409 conflict (operator action), does not retry", async () => {
    let getUpdatesCalls = 0;
    mockFetch((url) => {
      if (url.includes("/getUpdates")) { getUpdatesCalls++; return fail(409, "Conflict: terminated"); }
      return ok([]);
    });
    await expect(
      listenUpdates(
        CTX,
        opts({ requestOpts: { sleep: async () => undefined } }),
        () => undefined,
        () => false,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(getUpdatesCalls).toBe(1);
  });

  it("aborts the in-flight long-poll on stopSignal for a clean shutdown", async () => {
    const abortErr = (): Error => {
      const e = new Error("aborted");
      e.name = "AbortError";
      return e;
    };
    let polls = 0;
    mockFetch((url, init) => {
      if (url.includes("/getUpdates")) {
        polls++;
        return new Promise<Response>((_resolve, reject) => {
          const sig = init.signal as AbortSignal | undefined;
          if (!sig) return;
          if (sig.aborted) reject(abortErr());
          else sig.addEventListener("abort", () => reject(abortErr()), { once: true });
        });
      }
      return ok([]);
    });
    const stop = new AbortController();
    let stopped = false;
    setTimeout(() => { stopped = true; stop.abort(); }, 5);
    const summary = await listenUpdates(
      CTX,
      opts({ timeout: 30 }),
      () => undefined,
      () => stopped,
      stop.signal,
    );
    expect(polls).toBe(1);
    expect(summary.batches).toBe(0); // in-flight batch aborted, no emit
  });
});

describe("listenCommand (glue)", () => {
  it("--help returns the LISTEN_HELP text", async () => {
    const out = await listenCommand(["--help"], { token: "t", chatId: "1" });
    expect(out).toBe(LISTEN_HELP);
  });

  it("rejects an invalid --limit / --timeout", async () => {
    await expect(listenCommand(["--limit", "0"], { token: "t", chatId: "1" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(listenCommand(["--timeout", "99"], { token: "t", chatId: "1" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("throws AUTH_REQUIRED when no token is present", async () => {
    await expect(listenCommand([], { token: undefined, chatId: "1" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
