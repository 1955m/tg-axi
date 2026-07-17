import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReceiveOutput,
  drainUpdates,
  normalizeUpdate,
  type ReceiveOptions,
} from "./receive.js";
import { isAllowed, type AllowList } from "./access.js";
import type { TgMessage, TgUpdate } from "./tg.js";

const ENV = [
  "TG_OFFSET_FILE",
  "TG_INBOX_DIR",
  "TG_ACCESS_FILE",
  "TG_ALLOW_FROM",
  "TG_TOKEN_FILE",
  "TELEGRAM_BOT_TOKEN",
];
const saved: Record<string, string | undefined> = {};

let dir: string;
let inbox: string;
let offsetFile: string;
const CTX = { token: "test-token", chatId: "123456789" };

const ALLOW: AllowList = {
  set: new Set(["123456789"]),
  source: "access.json",
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-axi-recv-"));
  inbox = join(dir, "inbox");
  offsetFile = join(dir, "offset");
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
    inboxDir: inbox,
    offsetFile,
    limit: 100,
    timeout: 0,
    ...over,
  };
}

// ── fetch mock: route by URL (getUpdates / getFile) or /file/ for downloads ──
interface MockResp {
  status: number;
  json?: unknown; // Bot API envelope value for `result`
  bytes?: Buffer; // raw file bytes for /file/ downloads
  okEnvelope?: boolean; // default true; set false to emulate a Bot API error
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

type RouteHandler = (url: string, init: RequestInit) => MockResp | Promise<MockResp>;

function mockFetch(handler: RouteHandler): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    return Promise.resolve(handler(url, init)).then(mockResponse);
  }) as unknown as typeof fetch;
  return calls;
}

function okResult(json: unknown): MockResp {
  return { status: 200, json };
}
function failResult(code: number, description: string): MockResp {
  return { status: code, okEnvelope: false, errorDescription: description };
}

/** Build a getUpdates response that routes by the offset in the POST body. */
function updatesByOffset(map: Record<number, TgUpdate[]>): RouteHandler {
  return (_url, init) => {
    const body = JSON.parse(String(init.body)) as { offset?: number };
    const off = body.offset ?? 0;
    return okResult(map[off] ?? []);
  };
}

const USER = { id: 1, is_bot: false, first_name: "Alice", last_name: "Q", username: "alice" };
const CHAT = { id: 123456789, type: "private", username: "exampleuser", first_name: "Alice" };

function msg(over: Partial<TgMessage> & { message_id: number }): TgMessage {
  return { message_id: over.message_id, from: USER, chat: CHAT, date: 1700000000, ...over } as TgMessage;
}

describe("drainUpdates — offset advance + idempotency", () => {
  it("fetches from offset 0, normalizes, advances offset to last_update_id + 1", async () => {
    const updates: TgUpdate[] = [
      { update_id: 10, message: msg({ message_id: 1, text: "hi" }) },
      { update_id: 11, message: msg({ message_id: 2, text: "yo" }) },
    ];
    mockFetch(updatesByOffset({ 0: updates }));

    const r = await drainUpdates(CTX, opts());
    expect(r.updatesCount).toBe(2);
    expect(r.newOffset).toBe(12);
    expect(r.messages.length).toBe(2);
    expect(r.messages[0]).toMatchObject({ update_id: 10, type: "text", text: "hi" });
    expect(r.messages[1]).toMatchObject({ update_id: 11, type: "text", text: "yo" });
  });

  it("re-running from the persisted offset never re-fetches already-acked updates", async () => {
    const updates: TgUpdate[] = [{ update_id: 100, message: msg({ message_id: 1, text: "x" }) }];
    const seen: number[] = [];
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { offset?: number };
      seen.push(body.offset ?? 0);
      return okResult(body.offset === 0 ? updates : []);
    });

    const r1 = await drainUpdates(CTX, opts());
    const r2 = await drainUpdates(CTX, opts());
    expect(r1.newOffset).toBe(101);
    expect(r2.newOffset).toBeNull();
    expect(seen).toEqual([0, 101]); // second call requested offset=101, not 0
  });

  it("passes --limit through to getUpdates", async () => {
    let capturedLimit: unknown;
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { limit?: number };
      capturedLimit = body.limit;
      return okResult([]);
    });
    await drainUpdates(CTX, opts({ limit: 25 }));
    expect(capturedLimit).toBe(25);
  });

  it("does not advance the offset when there are no updates", async () => {
    mockFetch(updatesByOffset({ 0: [] }));
    const r = await drainUpdates(CTX, opts());
    expect(r.newOffset).toBeNull();
    expect(r.updatesCount).toBe(0);
  });

  it("pagination: two sequential drains move the offset forward across batches", async () => {
    const map: Record<number, TgUpdate[]> = {
      0: [{ update_id: 5, message: msg({ message_id: 1, text: "a" }) }],
      6: [{ update_id: 6, message: msg({ message_id: 2, text: "b" }) }],
    };
    mockFetch(updatesByOffset(map));
    const r1 = await drainUpdates(CTX, opts());
    const r2 = await drainUpdates(CTX, opts());
    expect(r1.newOffset).toBe(6);
    expect(r2.newOffset).toBe(7);
    expect(r1.messages[0].text).toBe("a");
    expect(r2.messages[0].text).toBe("b");
  });
});

describe("409 conflict", () => {
  it("surfaces a 409 as VALIDATION_ERROR with a clear webhook/poller message", async () => {
    mockFetch((_url) =>
      _url.includes("/getUpdates")
        ? failResult(409, "Conflict: terminated by other getUpdates request")
        : okResult({}),
    );
    await expect(drainUpdates(CTX, opts())).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("the 409 error message + suggestions mention webhook and the drop flag", async () => {
    mockFetch((_url) => failResult(409, "Conflict: can't get updates while a webhook is active"));
    let caught: { code: string; message: string; suggestions: string[] } | undefined;
    try {
      await drainUpdates(CTX, opts());
    } catch (e) {
      caught = e as { code: string; message: string; suggestions: string[] };
    }
    expect(caught?.code).toBe("VALIDATION_ERROR");
    expect(caught?.message).toContain("conflict");
    expect(caught?.suggestions.some((s) => s.includes("drop-pending-webhook"))).toBe(true);
    expect(caught?.suggestions.some((s) => s.includes("ONE"))).toBe(true);
  });
});

describe("allowlist reject", () => {
  it("records a non-allowed sender as rejected and does NOT download media", async () => {
    const foreignChat = { id: 999, type: "private" };
    const updates: TgUpdate[] = [
      {
        update_id: 20,
        message: {
          message_id: 7,
          from: { id: 999, first_name: "Stranger" },
          chat: foreignChat,
          date: 1700000001,
          document: { file_id: "DOC1", file_name: "malware.pdf", mime_type: "application/pdf" },
        },
      },
    ];
    let getFileCalls = 0;
    let fileDlCalls = 0;
    mockFetch((_url) => {
      if (_url.includes("/getFile")) {
        getFileCalls++;
        return okResult({ file_id: "DOC1", file_path: "documents/file_1.pdf" });
      }
      if (_url.includes("/file/bot")) {
        fileDlCalls++;
        return { status: 200, bytes: Buffer.from("%PDF-1.4") };
      }
      return okResult(updates);
    });

    const r = await drainUpdates(CTX, opts());
    expect(r.rejected.length).toBe(1);
    expect(r.messages.length).toBe(0);
    expect(r.rejected[0]).toMatchObject({
      update_id: 20,
      chat_id: 999,
      from_id: 999,
      type: "rejected",
      decision: "rejected",
    });
    expect(getFileCalls).toBe(0);
    expect(fileDlCalls).toBe(0);
    expect(r.newOffset).toBe(21); // rejected updates are still acked
  });
});

describe("unsupported update types", () => {
  it("emits type=unsupported with the raw subtype for a callback_query", async () => {
    const updates: TgUpdate[] = [
      { update_id: 30, callback_query: { id: "cq1", from: USER, data: "btn" } },
    ];
    mockFetch(updatesByOffset({ 0: updates }));
    const r = await drainUpdates(CTX, opts());
    expect(r.unsupported.length).toBe(1);
    expect(r.unsupported[0]).toMatchObject({
      update_id: 30,
      type: "unsupported",
      decision: "unsupported",
      subtype: "callback_query",
    });
  });
});

describe("message type normalization", () => {
  async function normalizeOne(message: TgMessage): Promise<Record<string, unknown>> {
    const update: TgUpdate = { update_id: 1, message };
    mockFetch(() => okResult([])); // text/location/contact make no fetches
    return normalizeUpdate(update, CTX, opts()) as unknown as Record<string, unknown>;
  }

  it("normalizes a text message", async () => {
    const r = await normalizeOne(msg({ message_id: 1, text: "hello" }));
    expect(r).toMatchObject({ type: "text", text: "hello", decision: "allowed" });
    expect(r.from_username).toBe("alice");
    expect(r.from_name).toBe("Alice Q");
    expect(r.chat_id).toBe(123456789);
    expect(r.date).toBe(1700000000);
  });

  it("normalizes a location", async () => {
    const r = await normalizeOne(msg({ message_id: 2, location: { longitude: 12.34, latitude: 56.78 } }));
    expect(r).toMatchObject({ type: "location", longitude: 12.34, latitude: 56.78 });
  });

  it("normalizes a contact", async () => {
    const r = await normalizeOne(msg({ message_id: 3, contact: { phone_number: "+15551234", first_name: "Bob", user_id: 42 } }));
    expect(r).toMatchObject({ type: "contact", phone: "+15551234", first_name: "Bob", user_id: 42 });
  });

  it("picks the LARGEST photo size and downloads it", async () => {
    const photos = [
      { file_id: "SM", width: 128, height: 128, file_size: 1024 },
      { file_id: "LG", width: 1024, height: 1024, file_size: 8192 },
      { file_id: "MD", width: 512, height: 512, file_size: 4096 },
    ];
    let gotFileId: string | undefined;
    mockFetch((url, init) => {
      if (url.includes("/getFile")) {
        const body = JSON.parse(String(init.body)) as { file_id?: string };
        gotFileId = body.file_id;
        return okResult({ file_id: "LG", file_path: "photos/file_big.jpg" });
      }
      if (url.includes("/file/bot")) return { status: 200, bytes: Buffer.from([0xff, 0xd8, 0xff]) };
      return okResult([]);
    });
    const r = (await normalizeUpdate(
      { update_id: 5, message: msg({ message_id: 4, photo: photos, caption: "look" }) },
      CTX,
      opts(),
    )) as unknown as Record<string, unknown>;
    expect(gotFileId).toBe("LG");
    expect(r).toMatchObject({ type: "photo", mime: "image/jpeg", downloaded: true, caption: "look" });
    expect(typeof r["file"]).toBe("string");
  });

  it("normalizes voice (opus/.oga) with duration + mime and downloads the file", async () => {
    mockFetch((_url) => {
      if (_url.includes("/getFile")) return okResult({ file_id: "V1", file_path: "voice/file_1.oga" });
      if (_url.includes("/file/bot")) return { status: 200, bytes: Buffer.from("OPUS") };
      return okResult([]);
    });
    const r = await normalizeUpdate(
      { update_id: 7, message: msg({ message_id: 5, voice: { file_id: "V1", duration: 9, mime_type: "audio/ogg", file_size: 1234 } }) },
      CTX,
      opts(),
    );
    expect(r).toMatchObject({ type: "voice", duration: 9, mime: "audio/ogg", size: 1234, downloaded: true });
    expect(String((r as Record<string, unknown>).file)).toMatch(/\.oga$/);
  });

  it("normalizes a document of ANY mime (application/pdf) and downloads it", async () => {
    mockFetch((_url) => {
      if (_url.includes("/getFile")) return okResult({ file_id: "D1", file_path: "documents/file_1.pdf" });
      if (_url.includes("/file/bot")) return { status: 200, bytes: Buffer.from("%PDF") };
      return okResult([]);
    });
    const r = await normalizeUpdate(
      { update_id: 8, message: msg({ message_id: 6, document: { file_id: "D1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 999 } }) },
      CTX,
      opts(),
    );
    expect(r).toMatchObject({ type: "document", mime: "application/pdf", name: "report.pdf", downloaded: true });
  });

  it("normalizes audio, video, video_note, animation, sticker", async () => {
    mockFetch((_url) => {
      if (_url.includes("/getFile")) return okResult({ file_id: "X", file_path: "x/file.bin" });
      if (_url.includes("/file/bot")) return { status: 200, bytes: Buffer.from([0]) };
      return okResult([]);
    });
    const audio = await normalizeUpdate(
      { update_id: 1, message: msg({ message_id: 1, audio: { file_id: "A1", duration: 30, mime_type: "audio/mpeg", file_name: "song.mp3" } }) },
      CTX,
      opts(),
    );
    expect(audio.type).toBe("audio");
    expect(audio).toMatchObject({ duration: 30, mime: "audio/mpeg", name: "song.mp3", downloaded: true });

    const video = await normalizeUpdate(
      { update_id: 2, message: msg({ message_id: 2, video: { file_id: "V", duration: 5, mime_type: "video/mp4", width: 640, height: 480, file_name: "clip.mp4" } }) },
      CTX,
      opts(),
    );
    expect(video.type).toBe("video");
    expect(video).toMatchObject({ width: 640, height: 480 });

    const vn = await normalizeUpdate(
      { update_id: 3, message: msg({ message_id: 3, video_note: { file_id: "VN", duration: 7, length: 240 } }) },
      CTX,
      opts(),
    );
    expect(vn.type).toBe("video_note");
    expect(vn).toMatchObject({ duration: 7, length: 240 });

    const anim = await normalizeUpdate(
      { update_id: 4, message: msg({ message_id: 4, animation: { file_id: "AN", duration: 2, mime_type: "video/mp4", file_name: "giphy.mp4" } }) },
      CTX,
      opts(),
    );
    expect(anim.type).toBe("animation");

    const sticker = await normalizeUpdate(
      { update_id: 5, message: msg({ message_id: 5, sticker: { file_id: "S", emoji: "🚀", set_name: "set1", width: 512, height: 512, is_animated: false, is_video: false, type: "regular" } }) },
      CTX,
      opts(),
    );
    expect(sticker.type).toBe("sticker");
    expect(sticker).toMatchObject({ emoji: "🚀", set_name: "set1" });
  });
});

describe("media download — graceful failure for >20MB / getFile errors", () => {
  it("emits downloaded=false with a reason when getFile fails (file too big) and never crashes", async () => {
    mockFetch((_url) => {
      if (_url.includes("/getFile")) return failResult(400, "file is too big");
      if (_url.includes("/file/bot")) return { status: 200, bytes: Buffer.from("nope") };
      return okResult([]);
    });
    const r = await normalizeUpdate(
      { update_id: 9, message: msg({ message_id: 8, document: { file_id: "BIG", file_name: "huge.zip", mime_type: "application/zip", file_size: 99_999_999 } }) },
      CTX,
      opts(),
    );
    expect(r).toMatchObject({ type: "document", downloaded: false, name: "huge.zip", mime: "application/zip", file_id: "BIG", size: 99_999_999 });
    expect(typeof (r as Record<string, unknown>).reason).toBe("string");
    expect(String((r as Record<string, unknown>).reason)).toContain("too big");
    expect((r as Record<string, unknown>).file).toBeNull();
  });

  it("emits downloaded=false when the /file/ download HTTP fails", async () => {
    mockFetch((_url) => {
      if (_url.includes("/getFile")) return okResult({ file_id: "F", file_path: "docs/file.bin" });
      if (_url.includes("/file/bot")) return { status: 500, bytes: undefined };
      return okResult([]);
    });
    const r = await normalizeUpdate(
      { update_id: 10, message: msg({ message_id: 9, document: { file_id: "F", file_name: "f.bin" } }) },
      CTX,
      opts(),
    );
    expect(r).toMatchObject({ type: "document", downloaded: false });
    expect(String((r as Record<string, unknown>).reason)).toContain("500");
  });

  it("--no-download skips writes but keeps metadata", async () => {
    let dlCalls = 0;
    mockFetch((_url) => {
      if (_url.includes("/getFile")) return okResult({ file_id: "F", file_path: "x.bin" });
      if (_url.includes("/file/bot")) { dlCalls++; return { status: 200, bytes: Buffer.from("x") }; }
      return okResult([]);
    });
    const r = await normalizeUpdate(
      { update_id: 11, message: msg({ message_id: 10, voice: { file_id: "F", duration: 1, mime_type: "audio/ogg" } }) },
      CTX,
      opts({ noDownload: true }),
    );
    expect(r).toMatchObject({ type: "voice", downloaded: false });
    expect(String((r as Record<string, unknown>).reason)).toContain("no-download");
    expect(dlCalls).toBe(0);
  });

  it("writes the downloaded bytes to the inbox path via writeFile", async () => {
    const written: Record<string, Buffer> = {};
    mockFetch((_url) => {
      if (_url.includes("/getFile")) return okResult({ file_id: "F", file_path: "voice/file_1.oga" });
      if (_url.includes("/file/bot")) return { status: 200, bytes: Buffer.from("OPUSDAT") };
      return okResult([]);
    });
    const r = await normalizeUpdate(
      { update_id: 12, message: msg({ message_id: 11, voice: { file_id: "F", duration: 1, mime_type: "audio/ogg" } }) },
      CTX,
      opts({ writeFile: (p, b) => { written[p] = b; } }),
    );
    const file = (r as Record<string, unknown>).file as string;
    expect(file).toContain("12_11_file_1.oga");
    expect(written[file].toString()).toBe("OPUSDAT");
  });
});

describe("buildReceiveOutput", () => {
  it("includes counts + offset + non-empty arrays, omits empty arrays", () => {
    const out = buildReceiveOutput({
      messages: [{ update_id: 1, message_id: 1, chat_id: 123456789, from_id: 1, from_username: "u", from_name: "U", date: 1, type: "text", decision: "allowed", text: "x" }],
      rejected: [],
      unsupported: [],
      offsetBefore: 0,
      newOffset: 2,
      updatesCount: 1,
    });
    expect(out).toEqual({ received: 1, offset: 2, messages: expect.any(Array) });
  });

  it("surfaces rejected + unsupported arrays when present, plus audit fields", () => {
    const out = buildReceiveOutput(
      {
        messages: [],
        rejected: [{ update_id: 2, message_id: 2, chat_id: 9, from_id: 9, from_username: null, from_name: null, date: 1, type: "rejected", decision: "rejected" }],
        unsupported: [{ update_id: 3, message_id: null, chat_id: null, from_id: null, from_username: null, from_name: null, date: null, type: "unsupported", decision: "unsupported", subtype: "poll" }],
        offsetBefore: 2,
        newOffset: 4,
        updatesCount: 2,
      },
      { allow: "access.json", inbox: "/x/inbox", webhook: "deleted" },
    );
    expect(out).toMatchObject({
      received: 0,
      offset: 4,
      rejected: expect.any(Array),
      unsupported: expect.any(Array),
      allow: "access.json",
      inbox: "/x/inbox",
      webhook: "deleted",
    });
  });
});

describe("isAllowed via normalizeUpdate integration", () => {
  it("uses the injected allowlist (default chat allowed, foreign rejected)", async () => {
    mockFetch(() => okResult([]));
    const allowed = await normalizeUpdate(
      { update_id: 1, message: msg({ message_id: 1, text: "ok" }) },
      CTX,
      opts(),
    );
    expect(allowed.decision).toBe("allowed");
    const blocked = await normalizeUpdate(
      { update_id: 2, message: { message_id: 2, from: { id: 5, first_name: "X" }, chat: { id: 5, type: "private" }, date: 1, text: "blocked" } },
      CTX,
      opts(),
    );
    expect(blocked.decision).toBe("rejected");
    expect(isAllowed("5", "5", ALLOW)).toBe(false);
  });
});
