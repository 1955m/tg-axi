import { installSessionStartHooks } from "axi-sdk-js";
import { rejectUnknownFlags, type TgContext } from "../context.js";
import { renderError, renderHelp, renderOutput } from "../toon.js";

export const SETUP_HELP = `usage: tg-axi setup <action>
Install agent SessionStart hooks for ambient context.
  setup hooks               install/repair Claude Code, Codex, and OpenCode hooks
flags: --help (always); --chat (global, after the command)
examples:
  tg-axi setup hooks`;

/**
 * Install agent session integrations. Mirrors cloudflare-axi's setup command.
 * `setup hooks` installs SessionStart hooks (Claude Code / Codex / OpenCode)
 * via the SDK's installSessionStartHooks, which writes the current executable
 * path portably and is idempotent. Explicit opt-in only — never run from an
 * ordinary command (AXI P7).
 */
export async function setupCommand(args: string[], _ctx: TgContext): Promise<string> {
  const action = args[0];
  if (action === "hooks") {
    rejectUnknownFlags(args.slice(1), [], "setup hooks");
    installSessionStartHooks();
    return renderOutput([
      "hooks:\n  status: installed\n  integrations: Claude Code, Codex, OpenCode",
      renderHelp(["Restart your agent session to receive tg-axi ambient context"]),
    ]);
  }
  return renderError(`Unknown setup action: ${action ?? "(none)"}`, "VALIDATION_ERROR", [
    "Run `tg-axi setup hooks` to install SessionStart hooks",
    "More setup actions ship post-MVP",
  ]);
}
