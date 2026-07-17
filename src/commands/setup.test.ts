import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TgContext } from "../context.js";

// Mock the SDK's installSessionStartHooks so the test never writes to the real
// ~/.claude/settings.json, ~/.codex/hooks.json, or ~/.config/opencode/plugins.
// vi.hoisted keeps the mock reference stable across the hoisted vi.mock factory.
const { installMock } = vi.hoisted(() => ({ installMock: vi.fn() }));

vi.mock("axi-sdk-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axi-sdk-js")>();
  return { ...actual, installSessionStartHooks: installMock };
});

import { setupCommand } from "./setup.js";

const CTX: TgContext = { token: undefined, chatId: "123456789" };

describe("setup hooks (AXI P7)", () => {
  beforeEach(() => installMock.mockReset());

  it("installs SessionStart hooks and reports installed + integrations", async () => {
    const out = await setupCommand(["hooks"], CTX);
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(out).toContain("installed");
    expect(out).toContain("Claude Code, Codex, OpenCode");
    expect(out).toContain("Restart your agent session");
  });

  it("rejects an unknown flag after `setup hooks` with VALIDATION_ERROR (P6)", async () => {
    await expect(setupCommand(["hooks", "--bogus"], CTX)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(installMock).not.toHaveBeenCalled();
  });

  it("reports an unknown setup action", async () => {
    const out = await setupCommand(["bogus"], CTX);
    expect(out).toContain("Unknown setup action: bogus");
    expect(installMock).not.toHaveBeenCalled();
  });

  it("reports a missing action as (none)", async () => {
    const out = await setupCommand([], CTX);
    expect(out).toContain("Unknown setup action: (none)");
  });
});
