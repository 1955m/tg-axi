import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import {
  parseContextArgs,
  resolveTgContext,
  type TgContext,
} from "./context.js";
import { createSkillMarkdown } from "./skill.js";
import { homeCommand, HOME_HELP } from "./commands/home.js";
import { sendCommand, SEND_HELP } from "./commands/send.js";
import { statusCommand, STATUS_HELP } from "./commands/status.js";
import { DEFAULT_CHAT } from "./config.js";

export const DESCRIPTION =
  "Agent ergonomic interface for delivering Telegram messages. Prefer this for out-of-band alert delivery.";

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: tg-axi [command] [args] [flags]
commands[3]:
  (none)=session, send, status
flags[3]:
  --chat <id> (after command; default ${DEFAULT_CHAT}), --help, -v/-V/--version
auth:
  Telegram bot token read at runtime from ~/.claude/channels/telegram/.env (TELEGRAM_BOT_TOKEN); never committed
examples:
  tg-axi
  tg-axi status
  echo -n "alert" | tg-axi send --stdin
  tg-axi send --text-file ./digest.txt --title "wedge alarm" --priority high
  tg-axi send --chat ${DEFAULT_CHAT} --stdin
`;

const COMMAND_HELP: Record<string, string> = {
  send: SEND_HELP,
  status: STATUS_HELP,
  home: HOME_HELP,
};

const COMMANDS = {
  send: withContext(sendCommand),
  status: withContext(statusCommand),
};

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
}

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);

  // --skill prints the agent-harness SKILL.md and exits. Handled before
  // runAxiCli so the leading flag is not rejected as "flags must come after
  // the command".
  if (argv.length === 1 && argv[0] === "--skill") {
    const stdout = options.stdout ?? process.stdout;
    stdout.write(`${createSkillMarkdown()}\n`);
    return;
  }

  await runAxiCli<TgContext | undefined>({
    ...(options.argv ? { argv: options.argv } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    home: withContext(homeCommand),
    commands: COMMANDS,
    getCommandHelp: (command: string) => COMMAND_HELP[command] ?? null,
    resolveContext: ({ args }): TgContext => {
      const { chatFlag } = parseContextArgs(args);
      return resolveTgContext(chatFlag);
    },
  });
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf-8"));
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  }
  throw new Error("Could not determine tg-axi package version");
}

/**
 * Strip --chat (the context flag) from args before dispatching to a command,
 * and adapt the SDK's `TContext | undefined` to a guaranteed TgContext
 * (resolveContext always returns one; the fallback is defensive). Mirrors
 * glab-axi's withProjectContext, which strips -R/--repo/--hostname.
 */
function withContext(
  handler: (args: string[], ctx: TgContext) => Promise<string>,
): (args: string[], ctx: TgContext | undefined) => Promise<string> {
  return (args: string[], ctx: TgContext | undefined): Promise<string> => {
    const context: TgContext = ctx ?? { token: undefined, chatId: DEFAULT_CHAT };
    const { strippedArgs } = parseContextArgs(args);
    return handler(strippedArgs, context);
  };
}

export { DEFAULT_CHAT };
