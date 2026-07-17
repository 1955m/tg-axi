import { AxiError, exitCodeForError } from "axi-sdk-js";

export { AxiError, exitCodeForError };

/** Telegram `parameters` block, carried on 429 (retry_after) and 400 (migrate_to_chat_id). */
export interface TgErrorParameters {
  retry_after?: number;
  migrate_to_chat_id?: number;
}

/**
 * Map a Telegram Bot API error response to a structured AxiError.
 * Telegram returns `{ ok: false, error_code, description, parameters }` even for
 * HTTP-level failures (401 Unauthorized, 400 Bad Request, 429 Too Many Requests, …).
 * Codes mirror glab-axi's set: AUTH_REQUIRED, FORBIDDEN, NOT_FOUND,
 * RATE_LIMITED, VALIDATION_ERROR, TIMEOUT, NETWORK_ERROR, UNKNOWN.
 */
export function mapTgApiError(
  errorCode: number | undefined,
  description: string,
  parameters?: TgErrorParameters,
): AxiError {
  const code = errorCode ?? 0;
  const desc = description?.trim() || "";
  if (code === 429) {
    const retry = parameters?.retry_after;
    return new AxiError(
      `Telegram rate limit hit (429)${retry ? ` — retry after ${retry}s` : ""}`,
      "RATE_LIMITED",
      ["tg-axi retries 429 automatically with backoff; reduce send volume if it persists"],
    );
  }
  if (code === 401) {
    return new AxiError("Telegram rejected the bot token (401 Unauthorized)", "AUTH_REQUIRED", [
      "Set TELEGRAM_BOT_TOKEN in the environment or ~/.claude/channels/telegram/.env",
      "Run `tg-axi status` to verify the token",
    ]);
  }
  if (code === 403) {
    if (/not enough rights|forbidden/i.test(desc) && /chat/i.test(desc)) {
      return new AxiError(`Telegram chat not reachable: ${desc}`, "FORBIDDEN", [
        "Start a conversation with the bot first, then pass --chat <id>",
      ]);
    }
    if (/bot was blocked by the user/i.test(desc)) {
      return new AxiError("Telegram chat is blocked — the recipient stopped the bot", "FORBIDDEN", [
        "Have the recipient unblock the bot, then retry",
      ]);
    }
    return new AxiError(`Telegram forbidden (403): ${desc}`, "FORBIDDEN");
  }
  if (code === 400) {
    if (/chat not found|chat_id/i.test(desc)) {
      return new AxiError(`Telegram chat not found: ${desc}`, "NOT_FOUND", [
        "Pass --chat <id> with a valid numeric chat id",
      ]);
    }
    if (/empty\b/i.test(desc)) {
      return new AxiError(`Telegram rejected an empty message: ${desc}`, "VALIDATION_ERROR", [
        "Provide non-empty text via --stdin or --text-file",
      ]);
    }
    return new AxiError(`Telegram bad request (400): ${desc}`, "VALIDATION_ERROR");
  }
  if (code === 404) {
    return new AxiError(`Telegram not found (404): ${desc}`, "NOT_FOUND");
  }
  if (code === 409) {
    // Telegram permits exactly one getUpdates consumer per bot token, and an
    // active webhook blocks getUpdates entirely. Both surface as 409 Conflict.
    return new AxiError(`Telegram getUpdates conflict (409): ${desc}`, "VALIDATION_ERROR", [
      "Only ONE getUpdates consumer may run per bot token — stop any other poller/listen instance",
      "An active webhook blocks getUpdates — run `tg-axi receive --drop-pending-webhook` to remove it",
    ]);
  }
  if (code >= 500) {
    return new AxiError(`Telegram server error (${code}): ${desc}`, "UNKNOWN", [
      "Retry later — the Telegram API is temporarily unavailable",
    ]);
  }
  return new AxiError(`Telegram API error${code ? ` (${code})` : ""}: ${desc}`, "UNKNOWN");
}
