import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default chat id for the away-mode wedge alarm channel (firstmate's chat). */
export const DEFAULT_CHAT = "123456789";

/** Telegram Bot API base. Methods are called as `${API_BASE}/bot<token>/<method>`. */
export const API_BASE = "https://api.telegram.org";

/** Telegram sendMessage text limit per message (chars). tg-axi splits above this. */
export const TG_TEXT_LIMIT = 4096;

/** Environment variable holding the bot token (read from process.env first). */
export const TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

/** Environment variable overriding the token file location (for tests/local). */
export const TOKEN_FILE_ENV = "TG_TOKEN_FILE";

/** Default on-disk location of the bot token (never committed to this repo). */
export const DEFAULT_TOKEN_FILE = () =>
  join(homedir(), ".claude", "channels", "telegram", ".env");

/** Resolve the token file path: TG_TOKEN_FILE env > default ~/.claude path. */
export function tokenFilePath(): string {
  return process.env[TOKEN_FILE_ENV] ?? DEFAULT_TOKEN_FILE();
}

/**
 * Load the Telegram bot token at runtime.
 * Priority: TELEGRAM_BOT_TOKEN env var > the .env file at tokenFilePath().
 * Returns undefined when neither is present (commands map this to AUTH_REQUIRED).
 * The token is never logged or written to any committed file.
 */
export function loadToken(): string | undefined {
  const envToken = process.env[TOKEN_ENV];
  if (envToken && envToken.length > 0) return envToken;
  const file = tokenFilePath();
  if (!existsSync(file)) return undefined;
  const content = readFileSync(file, "utf8");
  const match = content.match(/^TELEGRAM_BOT_TOKEN\s*=\s*(.+?)\s*$/m);
  if (!match) return undefined;
  return match[1].replace(/^["']|["']$/g, "");
}
