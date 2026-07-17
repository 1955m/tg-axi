import { describe, expect, it } from "vitest";
import { TOP_HELP, DESCRIPTION, DEFAULT_CHAT } from "./cli.js";

describe("top-level help", () => {
  it("lists all 5 commands", () => {
    expect(TOP_HELP).toMatch(/^commands\[5\]:/m);
    for (const cmd of ["send", "status", "receive", "listen"]) {
      expect(TOP_HELP).toContain(cmd);
    }
  });

  it("documents the --chat flag and default chat", () => {
    expect(TOP_HELP).toContain("--chat");
    expect(TOP_HELP).toContain(DEFAULT_CHAT);
  });

  it("documents token auth from the .env file", () => {
    expect(TOP_HELP).toContain("TELEGRAM_BOT_TOKEN");
    expect(TOP_HELP).toContain("never committed");
  });

  it("has a Telegram-focused description", () => {
    expect(DESCRIPTION).toMatch(/Telegram/i);
  });
});
