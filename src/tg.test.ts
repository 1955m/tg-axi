import { describe, expect, it } from "vitest";
import { chunkMessage, computeRetryDelay, tgRequest, sendChunks } from "./tg.js";
import { TG_TEXT_LIMIT } from "./config.js";

const CTX = { token: "test-token", chatId: "123456789" };

interface MockResponse {
  status: number;
  body: string;
}

type FetchSpec =
  | MockResponse
  | ((url: string, init: RequestInit) => MockResponse | Promise<MockResponse>);

function makeResponse(spec: MockResponse): Response {
  return {
    status: spec.status,
    text: () => Promise.resolve(spec.body),
  } as Response;
}

function mockFetch(spec: FetchSpec): typeof fetch {
  const fn = (url: string, init: RequestInit): Promise<Response> => {
    const result = typeof spec === "function" ? spec(url, init) : spec;
    return Promise.resolve(result).then((r) => makeResponse(r));
  };
  return fn as unknown as typeof fetch;
}

function ok(body: unknown, status = 200): MockResponse {
  return { status, body: JSON.stringify({ ok: true, result: body }) };
}

function fail(code: number, description: string, parameters?: Record<string, unknown>): MockResponse {
  return {
    status: code,
    body: JSON.stringify({ ok: false, error_code: code, description, parameters }),
  };
}

const realFetch = globalThis.fetch;

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

describe("chunkMessage", () => {
  it("returns a single chunk under the limit", () => {
    expect(chunkMessage("short", TG_TEXT_LIMIT)).toEqual(["short"]);
  });

  it("returns a single chunk at exactly the limit", () => {
    const text = "a".repeat(TG_TEXT_LIMIT);
    expect(chunkMessage(text)).toEqual([text]);
  });

  it("splits over the limit into two chunks", () => {
    const text = "a".repeat(TG_TEXT_LIMIT + 50);
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(TG_TEXT_LIMIT);
    expect(chunks[1].length).toBe(50);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers newline boundaries when splitting", () => {
    const line = "x".repeat(TG_TEXT_LIMIT - 100) + "\n";
    const text = line + "y".repeat(200);
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line);
  });

  it("hard-splits when no newline is near the boundary", () => {
    const text = "a".repeat(TG_TEXT_LIMIT + 10);
    const chunks = chunkMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(TG_TEXT_LIMIT);
  });
});

describe("computeRetryDelay", () => {
  it("honors retry_after seconds (capped)", () => {
    expect(computeRetryDelay(5, 1)).toBe(5000);
    expect(computeRetryDelay(60, 1)).toBe(10_000);
  });

  it("uses exponential backoff without retry_after", () => {
    expect(computeRetryDelay(undefined, 1)).toBe(1000);
    expect(computeRetryDelay(undefined, 2)).toBe(2000);
    expect(computeRetryDelay(undefined, 3)).toBe(4000);
  });

  it("caps the exponential backoff", () => {
    expect(computeRetryDelay(undefined, 99)).toBeLessThanOrEqual(30_000);
  });
});

describe("tgRequest", () => {
  it("returns the result on ok", async () => {
    globalThis.fetch = mockFetch(ok({ message_id: 42 }));
    try {
      const result = await tgRequest<{ message_id: number }>("sendMessage", { chat_id: "1" }, CTX);
      expect(result.message_id).toBe(42);
    } finally {
      restoreFetch();
    }
  });

  it("retries 429 then succeeds (no-op sleep)", async () => {
    let calls = 0;
    const spec = (): MockResponse => {
      calls++;
      return calls === 1 ? fail(429, "Too Many Requests", { retry_after: 1 }) : ok({ message_id: 7 });
    };
    globalThis.fetch = mockFetch(spec);
    try {
      const result = await tgRequest<{ message_id: number }>("sendMessage", {}, CTX, {
        sleep: async () => undefined,
        maxRetries: 3,
      });
      expect(result.message_id).toBe(7);
      expect(calls).toBe(2);
    } finally {
      restoreFetch();
    }
  });

  it("throws RATE_LIMITED when retries are exhausted", async () => {
    globalThis.fetch = mockFetch(fail(429, "Too Many Requests", { retry_after: 1 }));
    try {
      await expect(
        tgRequest("sendMessage", {}, CTX, { sleep: async () => undefined, maxRetries: 1 }),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      restoreFetch();
    }
  });

  it("throws AUTH_REQUIRED on 401", async () => {
    globalThis.fetch = mockFetch(fail(401, "Unauthorized"));
    try {
      await expect(tgRequest("getMe", {}, CTX)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    } finally {
      restoreFetch();
    }
  });

  it("does NOT retry non-429 errors", async () => {
    let calls = 0;
    const spec = (): MockResponse => {
      calls++;
      return fail(401, "Unauthorized");
    };
    globalThis.fetch = mockFetch(spec);
    try {
      await expect(tgRequest("getMe", {}, CTX, { sleep: async () => undefined })).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
      expect(calls).toBe(1);
    } finally {
      restoreFetch();
    }
  });

  it("maps a network fetch failure to NETWORK_ERROR", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    try {
      await expect(tgRequest("getMe", {}, CTX)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    } finally {
      restoreFetch();
    }
  });

  it("maps an aborted request (timeout) to TIMEOUT", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as unknown as typeof fetch;
    try {
      await expect(
        tgRequest("getMe", {}, CTX, { timeoutMs: 50 }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
    } finally {
      restoreFetch();
    }
  });
});

describe("sendChunks", () => {
  it("sends a short message as a single chunk", async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return Promise.resolve(makeResponse(ok({ message_id: 1 })));
    }) as unknown as typeof fetch;
    try {
      const result = await sendChunks("hello", CTX, { sleep: async () => undefined });
      expect(result.chunks).toBe(1);
      expect(result.message_ids).toEqual([1]);
      expect(calls.length).toBe(1);
      expect(calls[0].body).toContain('"chat_id":"123456789"');
      expect(calls[0].body).toContain('"text":"hello"');
    } finally {
      restoreFetch();
    }
  });

  it("splits an over-limit message into multiple sends", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      calls.push(String(init.body));
      return Promise.resolve(makeResponse(ok({ message_id: calls.length })));
    }) as unknown as typeof fetch;
    try {
      const text = "a".repeat(TG_TEXT_LIMIT + 20);
      const result = await sendChunks(text, CTX, { sleep: async () => undefined });
      expect(result.chunks).toBe(2);
      expect(result.message_ids).toEqual([1, 2]);
      expect(calls.length).toBe(2);
    } finally {
      restoreFetch();
    }
  });

  it("prepends a title", async () => {
    let captured: string = "";
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      captured = String(init.body);
      return Promise.resolve(makeResponse(ok({ message_id: 1 })));
    }) as unknown as typeof fetch;
    try {
      await sendChunks("body", CTX, { title: "ALERT", sleep: async () => undefined });
      expect(captured).toContain('"text":"ALERT\\n\\nbody"');
    } finally {
      restoreFetch();
    }
  });

  it("sets disable_notification true for priority low", async () => {
    let captured = "";
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      captured = String(init.body);
      return Promise.resolve(makeResponse(ok({ message_id: 1 })));
    }) as unknown as typeof fetch;
    try {
      await sendChunks("body", CTX, { priority: "low", sleep: async () => undefined });
      expect(captured).toContain('"disable_notification":true');
    } finally {
      restoreFetch();
    }
  });

  it("sets disable_notification false for priority high", async () => {
    let captured = "";
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      captured = String(init.body);
      return Promise.resolve(makeResponse(ok({ message_id: 1 })));
    }) as unknown as typeof fetch;
    try {
      await sendChunks("body", CTX, { priority: "high", sleep: async () => undefined });
      expect(captured).toContain('"disable_notification":false');
    } finally {
      restoreFetch();
    }
  });
});
