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
export const DEFAULT_TOKEN_FILE = () => join(homedir(), ".claude", "channels", "telegram", ".env");

/** Resolve the token file path: TG_TOKEN_FILE env > default ~/.claude path. */
export function tokenFilePath(): string {
  return process.env[TOKEN_FILE_ENV] ?? DEFAULT_TOKEN_FILE();
}

// ── receive: offset store / inbox / allowlist ───────────────────────────────
// These reuse the same ~/.claude/channels/telegram/ dir the token lives in, so a
// single channel config dir holds the token, the last-acked offset, the inbox of
// downloaded media, and the access allowlist. Each is overridable via env for
// tests and local installs, and never commits the token.

/** Environment variable overriding the offset store location (for tests/local). */
export const OFFSET_FILE_ENV = "TG_OFFSET_FILE";

/** Default on-disk location of the last-acked Telegram update_id. */
export const DEFAULT_OFFSET_FILE = () =>
  join(homedir(), ".claude", "channels", "telegram", "offset");

/** Resolve the offset store path: TG_OFFSET_FILE env > default ~/.claude path. */
export function offsetFilePath(): string {
  return process.env[OFFSET_FILE_ENV] ?? DEFAULT_OFFSET_FILE();
}

/** Environment variable overriding the inbox directory (for tests/local). */
export const INBOX_DIR_ENV = "TG_INBOX_DIR";

/** Default inbox directory for downloaded Telegram media files. */
export const DEFAULT_INBOX_DIR = () => join(homedir(), ".claude", "channels", "telegram", "inbox");

/** Resolve the inbox directory: TG_INBOX_DIR env > default ~/.claude path. */
export function inboxDir(): string {
  return process.env[INBOX_DIR_ENV] ?? DEFAULT_INBOX_DIR();
}

/** Environment variable overriding the access allowlist file (for tests/local). */
export const ACCESS_FILE_ENV = "TG_ACCESS_FILE";

/** Default on-disk location of the access allowlist (JSON { allowFrom: [...] }). */
export const DEFAULT_ACCESS_FILE = () =>
  join(homedir(), ".claude", "channels", "telegram", "access.json");

/** Resolve the access allowlist path: TG_ACCESS_FILE env > default ~/.claude path. */
export function accessFilePath(): string {
  return process.env[ACCESS_FILE_ENV] ?? DEFAULT_ACCESS_FILE();
}

/** Environment variable holding a comma-separated allowlist override. */
export const ALLOW_FROM_ENV = "TG_ALLOW_FROM";

/** Default allowlist when no access.json and no TG_ALLOW_FROM env: just DEFAULT_CHAT. */
export const DEFAULT_ALLOW_FROM = [DEFAULT_CHAT];

/** getUpdates limit bounds (Telegram permits 1-100 per call). */
export const MAX_UPDATES_LIMIT = 100;
export const DEFAULT_UPDATES_LIMIT = 100;

/** getUpdates long-poll timeout bounds in seconds (Telegram permits 0-50). */
export const MAX_LONG_POLL_TIMEOUT = 50;
export const DEFAULT_RECEIVE_TIMEOUT = 0;
export const DEFAULT_LISTEN_TIMEOUT = 30;

/** Per-file download timeout (getFile serves files up to 20MB). */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

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
