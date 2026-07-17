import { AxiError } from "./errors.js";
import { DEFAULT_CHAT, loadToken } from "./config.js";

/**
 * Resolved context passed to every tg-axi command handler.
 * Unlike glab-axi (which resolves a GitLab project + host), tg-axi's context is
 * just the bot token + the target chat id. `token` may be undefined here;
 * commands that must call the API resolve it with requireToken().
 */
export interface TgContext {
  token: string | undefined;
  chatId: string;
}

/** Resolve the target chat: --chat flag value > DEFAULT_CHAT. */
export function resolveChatId(flagValue?: string): string {
  if (flagValue && flagValue.length > 0) return flagValue;
  return DEFAULT_CHAT;
}

/** Build a TgContext from the resolved chat flag and the runtime-loaded token. */
export function resolveTgContext(chatFlag: string | undefined): TgContext {
  return {
    token: loadToken(),
    chatId: resolveChatId(chatFlag),
  };
}

/**
 * Return a validated { token, chatId } for API-calling commands, or throw
 * AUTH_REQUIRED when no token is loadable. home/status/send all funnel here.
 */
export function requireToken(ctx: TgContext): { token: string; chatId: string } {
  if (!ctx.token) {
    throw new AxiError(
      "Telegram bot token not found — set TELEGRAM_BOT_TOKEN or create ~/.claude/channels/telegram/.env",
      "AUTH_REQUIRED",
      [
        "Create ~/.claude/channels/telegram/.env with TELEGRAM_BOT_TOKEN=<token>",
        "Run `tg-axi status` to verify the token",
      ],
    );
  }
  return { token: ctx.token, chatId: ctx.chatId };
}

interface ParsedContextArgs {
  chatFlag: string | undefined;
  strippedArgs: string[];
}

/** Strip --chat / --chat= (space or equals form) from args. */
export function parseContextArgs(args: string[]): ParsedContextArgs {
  const stripped: string[] = [];
  let chatFlag: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--chat" && index + 1 < args.length) {
      chatFlag = args[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith("--chat=") && arg.length > "--chat=".length) {
      chatFlag = arg.slice("--chat=".length);
      continue;
    }
    stripped.push(arg);
  }
  return { chatFlag, strippedArgs: stripped };
}

// ── per-command flag validation (AXI principle 6: fail loud on unknown flags) ─

/**
 * Flags allowed on every command. --chat is the global chat selector (already
 * stripped from args by withContext/parseContextArgs before a command sees
 * them); --help always passes. Both are never reported as unknown.
 */
const GLOBAL_FLAGS = new Set(["--chat", "--help"]);

/**
 * Reject unknown flags before any dependency call (exit 2). Globals
 * (--chat, already stripped, plus --help) are always allowed. Lists the
 * command's valid flags inline so the agent self-corrects in one turn —
 * mirroring cloudflare-axi's rejectUnknownFlags.
 */
export function rejectUnknownFlags(args: string[], known: string[], commandPath: string): void {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (known.includes(name) || GLOBAL_FLAGS.has(name)) continue;
    throw new AxiError(`unknown flag ${name} for \`${commandPath}\``, "VALIDATION_ERROR", [
      `valid flags for \`${commandPath}\`: ${[...known, "--help"].join(", ")}`,
      "(--help always allowed; --chat is a global selector placed after the command)",
    ]);
  }
}
