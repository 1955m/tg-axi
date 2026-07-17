import { existsSync, readFileSync } from "node:fs";
import { accessFilePath, ALLOW_FROM_ENV, DEFAULT_ALLOW_FROM } from "./config.js";

/**
 * Receive-side allowlist. Telegram lets any chat that has started the bot send
 * inbound messages; tg-axi narrows that to an explicit set so a stray message to
 * the bot cannot trigger downloads or downstream action. Sources, in priority
 * order, and only one widens access silently is allowed per source:
 *
 *   1. ~/.claude/channels/telegram/access.json  -> { "allowFrom": ["123456789", ...] }
 *   2. TG_ALLOW_FROM env (comma-separated ids)
 *   3. DEFAULT_ALLOW_FROM ([DEFAULT_CHAT]) — a safe 1-chat default
 *
 * Non-allowed senders are recorded as type="rejected" but never acted on (no
 * media download). The allowlist is never widened automatically.
 */
export interface AllowList {
  /** Canonicalized string-id set; matches against chat id OR sender id. */
  readonly set: ReadonlySet<string>;
  /** Where the set came from, surfaced in output so an operator can audit it. */
  readonly source: "access.json" | "env" | "default";
}

/** Load the allowlist from access.json > TG_ALLOW_FROM env > the default chat. */
export function loadAllowList(file: string = accessFilePath()): AllowList {
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        allowFrom?: unknown;
      };
      const ids = normalizeIds(parsed?.allowFrom);
      if (ids.length > 0) {
        return { set: new Set(ids), source: "access.json" };
      }
    } catch {
      // A malformed access.json falls through to env/default rather than widening.
    }
  }
  const envValue = process.env[ALLOW_FROM_ENV];
  if (envValue && envValue.trim().length > 0) {
    const ids = normalizeIds(envValue.split(","));
    if (ids.length > 0) return { set: new Set(ids), source: "env" };
  }
  return { set: new Set(DEFAULT_ALLOW_FROM), source: "default" };
}

/** True if either the chat id or the sender id is on the allowlist. */
export function isAllowed(
  chatId: string | number | null | undefined,
  fromId: string | number | null | undefined,
  allow: AllowList,
): boolean {
  if (allow.set.size === 0) return false;
  const chat = canonicalId(chatId);
  const from = canonicalId(fromId);
  if (chat !== null && allow.set.has(chat)) return true;
  if (from !== null && allow.set.has(from)) return true;
  return false;
}

function normalizeIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    const id = canonicalId(v);
    if (id !== null) out.push(id);
  }
  return out;
}

function canonicalId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "number" ? String(value) : String(value).trim();
  return s.length > 0 ? s : null;
}
