import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseContextArgs,
  requireToken,
  resolveChatId,
  type TgContext,
} from "./context.js";

const savedToken = process.env["TELEGRAM_BOT_TOKEN"];

beforeAll(() => {
  delete process.env["TELEGRAM_BOT_TOKEN"];
  delete process.env["TG_TOKEN_FILE"];
});

afterAll(() => {
  if (savedToken !== undefined) process.env["TELEGRAM_BOT_TOKEN"] = savedToken;
});

describe("parseContextArgs", () => {
  it("strips --chat in space form", () => {
    const r = parseContextArgs(["send", "--chat", "123", "--stdin"]);
    expect(r.chatFlag).toBe("123");
    expect(r.strippedArgs).toEqual(["send", "--stdin"]);
  });

  it("strips --chat= equals form", () => {
    const r = parseContextArgs(["send", "--chat=99", "--stdin"]);
    expect(r.chatFlag).toBe("99");
    expect(r.strippedArgs).toEqual(["send", "--stdin"]);
  });

  it("leaves non-chat flags untouched", () => {
    const r = parseContextArgs(["send", "--title", "x", "--text-file", "f.txt"]);
    expect(r.chatFlag).toBeUndefined();
    expect(r.strippedArgs).toEqual(["send", "--title", "x", "--text-file", "f.txt"]);
  });
});

describe("resolveChatId", () => {
  it("returns the flag chat id", () => {
    expect(resolveChatId("4242")).toBe("4242");
  });

  it("falls back to the default chat when flag is empty", () => {
    expect(resolveChatId(undefined)).toBe("123456789");
    expect(resolveChatId("")).toBe("123456789");
  });
});

describe("requireToken", () => {
  it("throws AUTH_REQUIRED when no token is present", () => {
    const ctx: TgContext = { token: undefined, chatId: "123456789" };
    expect(() => requireToken(ctx)).toThrow(/token/);
  });

  it("returns a validated {token, chatId} when a token is present", () => {
    const ctx: TgContext = { token: "tok", chatId: "9" };
    expect(requireToken(ctx)).toEqual({ token: "tok", chatId: "9" });
  });
});
