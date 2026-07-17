import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, DESCRIPTION } from "./cli.js";
import { createSkillMarkdown } from "./skill.js";

const ENV_VARS = ["TELEGRAM_BOT_TOKEN", "TG_TOKEN_FILE"];
const saved: Record<string, string | undefined> = {};
// A path that never exists, so the real ~/.claude .env is never read during
// tests — keeping the real bot token out of test output and keeping the
// no-token tests fully offline.
const NO_TOKEN_FILE = join(tmpdir(), "tg-axi-nonexistent-test.env");

beforeAll(() => {
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

afterEach(() => {
  delete process.env["TELEGRAM_BOT_TOKEN"];
  process.env["TG_TOKEN_FILE"] = NO_TOKEN_FILE;
});

function capture(): { chunks: string[]; stdout: { write: (c: string) => unknown } } {
  const chunks: string[] = [];
  return { chunks, stdout: { write: (c: string) => chunks.push(c) } };
}

describe("main (in-process)", () => {
  it("prints version for -v", async () => {
    const out = capture();
    await main({ argv: ["-v"], stdout: out.stdout });
    expect(out.chunks.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints --version for --version", async () => {
    const out = capture();
    await main({ argv: ["--version"], stdout: out.stdout });
    expect(out.chunks.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints top-level help for --help", async () => {
    const out = capture();
    await main({ argv: ["--help"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("usage:");
    expect(text).toContain("commands[6]:");
    expect(text).toContain("--chat");
    expect(text).toContain("built-in");
  });

  it("lists receive/listen/setup in the top-level commands and examples", async () => {
    const out = capture();
    await main({ argv: ["--help"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("receive");
    expect(text).toContain("listen");
    expect(text).toContain("setup");
    expect(text).toContain("tg-axi receive --json --timeout 30");
    expect(text).toContain("tg-axi setup hooks");
  });

  it("renders per-command help for `setup --help`", async () => {
    const out = capture();
    await main({ argv: ["setup", "--help"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("tg-axi setup hooks");
    expect(text).toContain("Claude Code, Codex, and OpenCode");
  });

  it("renders the session digest header (offline, no token)", async () => {
    const out = capture();
    await main({ argv: [], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("bin:");
    expect(text).toContain(DESCRIPTION);
    expect(text).toContain("token: no");
    expect(text).toContain("reachable: no");
    expect(text).toContain("default_chat:");
  });

  it("rejects a leading flag with VALIDATION_ERROR", async () => {
    const out = capture();
    await main({ argv: ["--chat", "123"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain("after the command");
  });

  it("reports an unknown command", async () => {
    const out = capture();
    await main({ argv: ["bogus"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("Unknown command: bogus");
  });

  it("prints SKILL.md for --skill", async () => {
    const out = capture();
    await main({ argv: ["--skill"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("name: tg-axi");
    expect(text).toContain("user-invocable: false");
    expect(text).toContain("## Commands");
  });
});

describe("send validation (in-process, offline)", () => {
  it("requires a text source", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "fake-token";
    const out = capture();
    await main({ argv: ["send"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain("text source");
  });

  it("rejects both --stdin and --text-file", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "fake-token";
    const out = capture();
    await main({ argv: ["send", "--stdin", "--text-file", "x.txt"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain("only one");
  });

  it("rejects an invalid --priority", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "fake-token";
    const out = capture();
    await main({
      argv: ["send", "--priority", "bogus", "--text-file", "x.txt"],
      stdout: out.stdout,
    });
    const text = out.chunks.join("");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain("priority");
  });

  it("reports AUTH_REQUIRED when no token and send is invoked", async () => {
    const out = capture();
    await main({ argv: ["send", "--text-file", "x.txt"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("AUTH_REQUIRED");
  });

  it("rejects an unknown flag with VALIDATION_ERROR before auth (P6: fail loud)", async () => {
    const out = capture();
    await main({ argv: ["send", "--bogus", "--stdin"], stdout: out.stdout });
    const text = out.chunks.join("");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain("unknown flag --bogus");
  });

  it("reports a missing --text-file path", async () => {
    process.env["TELEGRAM_BOT_TOKEN"] = "fake-token";
    const out = capture();
    await main({
      argv: ["send", "--text-file", "/nonexistent/path/no-such-file.txt"],
      stdout: out.stdout,
    });
    const text = out.chunks.join("");
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain("not found");
  });
});

describe("createSkillMarkdown", () => {
  it("includes frontmatter and the commands block", () => {
    const md = createSkillMarkdown();
    expect(md).toContain("---\nname: tg-axi");
    expect(md).toContain("category: comms");
    expect(md).toContain("commands[6]:");
    expect(md).toContain("npx -y tg-axi");
  });

  it("documents receive/listen inbound flow", () => {
    const md = createSkillMarkdown();
    expect(md).toContain("receive");
    expect(md).toContain("listen");
  });

  it("documents the setup hooks integration (P7)", () => {
    const md = createSkillMarkdown();
    expect(md).toContain("setup hooks");
    expect(md).toContain("Claude Code, Codex, and OpenCode");
  });

  it("documents the token file location", () => {
    const md = createSkillMarkdown();
    expect(md).toContain("~/.claude/channels/telegram/.env");
    expect(md).toContain("TELEGRAM_BOT_TOKEN");
  });
});

describe("SKILL.md staleness (AXI P7)", () => {
  it("the committed SKILL.md matches createSkillMarkdown() (docs:check parity)", () => {
    const committed = readFileSync(
      fileURLToPath(new URL("../skills/tg-axi/SKILL.md", import.meta.url)),
      "utf8",
    );
    expect(committed).toBe(createSkillMarkdown() + "\n");
  });
});
