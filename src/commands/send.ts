import { readFileSync } from "node:fs";
import { encode } from "@toon-format/toon";
import { AxiError } from "../errors.js";
import { hasFlag, takeFlag } from "../args.js";
import { isStdinTTY, readStdin } from "../stdin.js";
import { sendChunks } from "../tg.js";
import { renderHelp, renderOutput } from "../toon.js";
import { requireToken, type TgContext } from "../context.js";
import { DEFAULT_CHAT, TG_TEXT_LIMIT } from "../config.js";

export const SEND_HELP = `usage: tg-axi send [flags]
Deliver a message to a Telegram chat. Text longer than ${TG_TEXT_LIMIT} chars is
split into multiple sendMessage calls; 429s are retried with backoff.

flags[5]:
  --chat <id> (default ${DEFAULT_CHAT}), --title <text>, --priority high|low (default high),
  --text-file <path>, --stdin
text source: exactly one of --text-file or --stdin is required
priority: low (silent notification) or high (loud, default)
examples:
  echo -n "alert body" | tg-axi send --stdin
  tg-axi send --text-file ./digest.txt --title "wedge alarm" --priority high
  tg-axi send --chat 123456789 --stdin --title "deploy failed"
`;

const VALID_PRIORITIES = new Set(["high", "low", "silent", "normal"]);

export async function sendCommand(args: string[], ctx: TgContext): Promise<string> {
  if (args[0] === "--help") return SEND_HELP;
  const apiCtx = requireToken(ctx);

  const useStdin = hasFlag(args, "--stdin");
  const textFile = takeFlag(args, "--text-file");
  const title = takeFlag(args, "--title");
  const priority = takeFlag(args, "--priority") ?? "high";

  if (!VALID_PRIORITIES.has(priority)) {
    throw new AxiError(
      `Invalid --priority: ${priority}. Use high, low, silent, or normal`,
      "VALIDATION_ERROR",
      ["--priority low sends silently; high (default) sends a loud notification"],
    );
  }
  if (useStdin && textFile) {
    throw new AxiError(
      "Use only one text source: --stdin or --text-file, not both",
      "VALIDATION_ERROR",
      ["echo -n \"...\" | tg-axi send --stdin", "tg-axi send --text-file ./digest.txt"],
    );
  }
  if (!useStdin && !textFile) {
    throw new AxiError(
      "A text source is required: pass --stdin or --text-file <path>",
      "VALIDATION_ERROR",
      [
        'echo -n "alert body" | tg-axi send --stdin',
        "tg-axi send --text-file ./digest.txt --title \"wedge alarm\"",
      ],
    );
  }

  const text = useStdin ? await readStdinText() : readTextFile(textFile!);
  if (text.length === 0) {
    throw new AxiError(
      "Message text is empty — Telegram rejects empty messages",
      "VALIDATION_ERROR",
      ["Provide non-empty text via --stdin or --text-file"],
    );
  }

  const result = await sendChunks(text, apiCtx, { title, priority });
  return renderOutput([
    encode({
      sent: "ok",
      chat: result.chat,
      chunks: result.chunks,
      message_ids: result.message_ids.join(","),
    }),
    renderHelp([
      `Run \`tg-axi status\` to verify chat reachability`,
      `Run \`tg-axi send --text-file <path>\` for file-backed alert delivery`,
    ]),
  ]);
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "UNKNOWN";
    if (code === "ENOENT") {
      throw new AxiError(`--text-file path not found: ${path}`, "VALIDATION_ERROR");
    }
    if (code === "EISDIR") {
      throw new AxiError(
        `--text-file must point to a readable UTF-8 file, not a directory: ${path}`,
        "VALIDATION_ERROR",
      );
    }
    throw new AxiError(`Could not read --text-file path: ${path} (${code})`, "VALIDATION_ERROR");
  }
}

async function readStdinText(): Promise<string> {
  if (isStdinTTY()) {
    throw new AxiError(
      "--stdin requires piped input — pipe the message text via stdin",
      "VALIDATION_ERROR",
      ['echo -n "alert body" | tg-axi send --stdin'],
    );
  }
  return readStdin();
}
