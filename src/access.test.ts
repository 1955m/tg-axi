import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowed, loadAllowList } from "./access.js";
import { DEFAULT_CHAT, DEFAULT_ALLOW_FROM } from "./config.js";

const ENV = ["TG_ACCESS_FILE", "TG_ALLOW_FROM", "TG_TOKEN_FILE", "TELEGRAM_BOT_TOKEN"];
const saved: Record<string, string | undefined> = {};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-axi-access-"));
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("loadAllowList", () => {
  it("falls back to the default chat with source=default", () => {
    const allow = loadAllowList(join(dir, "missing-access.json"));
    expect(allow.source).toBe("default");
    expect([...allow.set]).toEqual([DEFAULT_CHAT]);
  });

  it("loads allowFrom ids from access.json (numbers and strings)", () => {
    const f = join(dir, "access.json");
    writeFileSync(f, JSON.stringify({ allowFrom: ["123456789", 4242, "999"] }));
    const allow = loadAllowList(f);
    expect(allow.source).toBe("access.json");
    expect(allow.set.has("123456789")).toBe(true);
    expect(allow.set.has("4242")).toBe(true);
    expect(allow.set.has("999")).toBe(true);
  });

  it("falls through to env/default when allowFrom is empty", () => {
    const f = join(dir, "access.json");
    writeFileSync(f, JSON.stringify({ allowFrom: [] }));
    const allow = loadAllowList(f);
    expect(allow.source).toBe("default");
  });

  it("falls through to env/default when access.json is malformed", () => {
    const f = join(dir, "access.json");
    writeFileSync(f, "{ not valid json");
    const allow = loadAllowList(f);
    expect(allow.source).toBe("default");
  });

  it("honors the TG_ALLOW_FROM env override (comma-separated)", () => {
    process.env["TG_ALLOW_FROM"] = "123456789, 111, 222";
    const allow = loadAllowList(join(dir, "missing-access.json"));
    expect(allow.source).toBe("env");
    expect(allow.set.has("111")).toBe(true);
    expect(allow.set.has("222")).toBe(true);
    expect(allow.set.has("123456789")).toBe(true);
  });

  it("access.json wins over the env override", () => {
    process.env["TG_ALLOW_FROM"] = "111";
    const f = join(dir, "access.json");
    writeFileSync(f, JSON.stringify({ allowFrom: [DEFAULT_CHAT] }));
    const allow = loadAllowList(f);
    expect(allow.source).toBe("access.json");
    expect(allow.set.has("111")).toBe(false);
  });

  it("DEFAULT_ALLOW_FROM contains the default chat", () => {
    expect(DEFAULT_ALLOW_FROM).toContain(DEFAULT_CHAT);
  });
});

describe("isAllowed", () => {
  const allow = { set: new Set(["123456789", "4242"]), source: "access.json" as const };

  it("allows a matching chat id", () => {
    expect(isAllowed("123456789", "999", allow)).toBe(true);
  });

  it("allows a matching sender id even when the chat is foreign", () => {
    expect(isAllowed("999", "4242", allow)).toBe(true);
  });

  it("rejects when neither chat nor sender is on the list", () => {
    expect(isAllowed("999", "888", allow)).toBe(false);
  });

  it("rejects everything when the allowlist is empty", () => {
    const empty = { set: new Set<string>(), source: "default" as const };
    expect(isAllowed("123456789", "1", empty)).toBe(false);
  });

  it("treats null/undefined ids as not on the list", () => {
    expect(isAllowed(null, undefined, allow)).toBe(false);
  });

  it("matches numeric ids against the string set", () => {
    expect(isAllowed(123456789, undefined, allow)).toBe(true);
    expect(isAllowed(123456789, 4242, allow)).toBe(true);
  });
});
