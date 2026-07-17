import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOffset, writeOffset } from "./offset.js";

const ENV = ["TG_OFFSET_FILE", "TG_TOKEN_FILE", "TELEGRAM_BOT_TOKEN", "TG_INBOX_DIR"];
const saved: Record<string, string | undefined> = {};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tg-axi-offset-"));
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

describe("readOffset", () => {
  it("returns 0 when the store does not exist", () => {
    expect(readOffset(join(dir, "missing"))).toBe(0);
  });

  it("reads the persisted offset", () => {
    const f = join(dir, "offset");
    writeFileSync(f, "1101\n");
    expect(readOffset(f)).toBe(1101);
  });

  it("returns 0 for a malformed store rather than crashing", () => {
    const f = join(dir, "offset");
    writeFileSync(f, "garbage\n");
    expect(readOffset(f)).toBe(0);
  });

  it("clamps negative garbage to 0", () => {
    const f = join(dir, "offset");
    writeFileSync(f, "-5\n");
    expect(readOffset(f)).toBe(0);
  });
});

describe("writeOffset", () => {
  it("writes the offset value", () => {
    const f = join(dir, "offset");
    writeOffset(42, f);
    expect(readFileSync(f, "utf8").trim()).toBe("42");
  });

  it("overwrites the previous value", () => {
    const f = join(dir, "offset");
    writeOffset(10, f);
    writeOffset(99, f);
    expect(readOffset(f)).toBe(99);
  });

  it("writes atomically — no temp file left behind", () => {
    const f = join(dir, "offset");
    writeOffset(7, f);
    expect(readdirSync(dir)).toEqual(["offset"]);
  });

  it("writes atomically — the store file is never absent after a successful write", () => {
    const f = join(dir, "offset");
    writeOffset(300, f);
    expect(existsSync(f)).toBe(true);
  });

  it("refuses to write an invalid offset", () => {
    const f = join(dir, "offset");
    expect(() => writeOffset(-1, f)).toThrow(/invalid offset/);
    expect(() => writeOffset(Number.NaN, f)).toThrow(/invalid offset/);
    expect(existsSync(f)).toBe(false);
  });
});
