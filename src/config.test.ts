import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHAT, loadToken, tokenFilePath } from "./config.js";

const ENV_VARS = ["TELEGRAM_BOT_TOKEN", "TG_TOKEN_FILE"];
const saved: Record<string, string | undefined> = {};
// A path that never exists, so loadToken() cannot read the real ~/.claude
// .env during tests (keeps the real token out of test output).
const NO_TOKEN_FILE = join(tmpdir(), "tg-axi-nonexistent-test.env");

beforeEach(() => {
  for (const key of ENV_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env["TG_TOKEN_FILE"] = NO_TOKEN_FILE;
});

afterAll(() => {
  for (const key of ENV_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("loadToken", () => {
  it("reads the token from TELEGRAM_BOT_TOKEN env", () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "env-token-123";
    expect(loadToken()).toBe("env-token-123");
  });

  it("returns undefined when no env and no file", () => {
    expect(loadToken()).toBeUndefined();
  });

  it("reads the token from the .env file pointed to by TG_TOKEN_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-axi-"));
    try {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, "# comment\nTELEGRAM_BOT_TOKEN=file-token-456\nOTHER=x\n");
      process.env["TG_TOKEN_FILE"] = envFile;
      expect(loadToken()).toBe("file-token-456");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips surrounding quotes from the token value", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-axi-"));
    try {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, 'TELEGRAM_BOT_TOKEN="quoted-token"\n');
      process.env["TG_TOKEN_FILE"] = envFile;
      expect(loadToken()).toBe("quoted-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the .env file has no TELEGRAM_BOT_TOKEN line", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-axi-"));
    try {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, "OTHER=value\n");
      process.env["TG_TOKEN_FILE"] = envFile;
      expect(loadToken()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("env var wins over the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-axi-"));
    try {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=file-token\n");
      process.env["TG_TOKEN_FILE"] = envFile;
      process.env["TELEGRAM_BOT_TOKEN"] = "env-wins";
      expect(loadToken()).toBe("env-wins");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tokenFilePath", () => {
  it("honors TG_TOKEN_FILE override", () => {
    process.env["TG_TOKEN_FILE"] = "/custom/path/.env";
    expect(tokenFilePath()).toBe("/custom/path/.env");
  });
});

describe("DEFAULT_CHAT", () => {
  it("is the configured away-mode chat", () => {
    expect(DEFAULT_CHAT).toBe("123456789");
  });
});
