import { API_BASE, TG_TEXT_LIMIT } from "./config.js";
import { AxiError, mapTgApiError, type TgErrorParameters } from "./errors.js";

/** Narrow context the HTTP client needs: a resolved token + chat id. */
export interface TgRequestContext {
  token: string;
  chatId: string;
}

interface TgApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: TgErrorParameters;
}

/** Internal/test hooks for request behavior. Commands pass these through. */
export interface TgRequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 4;
const MAX_RETRY_WAIT_S = 10;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Compute the delay before a 429 retry. Honors Telegram retry_after (capped). */
export function computeRetryDelay(
  retryAfterSeconds: number | undefined,
  attempt: number,
): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds, MAX_RETRY_WAIT_S) * 1000;
  }
  const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

/** Split a message into chunks <= limit chars, preferring newline boundaries. */
export function chunkMessage(text: string, limit: number = TG_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let split = limit;
    // Prefer a newline boundary in the trailing 512 chars to avoid mid-line cuts.
    const newline = rest.lastIndexOf("\n", limit);
    if (newline > limit - 512) split = newline + 1;
    chunks.push(rest.slice(0, split));
    rest = rest.slice(split);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function toFetchError(error: unknown, timeoutMs: number): AxiError {
  if (error instanceof Error && (/abort/i.test(error.name) || error.name === "TimeoutError")) {
    return new AxiError(
      `Telegram API request timed out after ${timeoutMs}ms`,
      "TIMEOUT",
      ["Retry; the Telegram API was too slow to respond"],
    );
  }
  return new AxiError(
    `Telegram API request failed: ${error instanceof Error ? error.message : String(error)}`,
    "NETWORK_ERROR",
    ["Check network/DNS and retry"],
  );
}

async function tgFetch<T>(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; parsed: TgApiResponse<T> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw toFetchError(error, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => "");
  let parsed: TgApiResponse<T> | null = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as TgApiResponse<T>;
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, parsed };
}

/**
 * Call a Telegram Bot API method. Throws a structured AxiError on failure.
 * Retries 429 responses with backoff (honoring `parameters.retry_after`,
 * capped) up to `maxRetries` times. Request-level timeout uses AbortController.
 */
export async function tgRequest<T>(
  method: string,
  body: Record<string, unknown>,
  ctx: TgRequestContext,
  opts: TgRequestOptions = {},
): Promise<T> {
  const url = `${API_BASE}/bot${ctx.token}/${method}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    attempt++;
    const { status, parsed } = await tgFetch<T>(url, body, timeoutMs);
    if (parsed && parsed.ok) return parsed.result as T;
    const errCode = parsed?.error_code ?? status;
    const errDesc =
      parsed?.description ?? (parsed ? "" : `non-JSON response (HTTP ${status})`);
    const error = mapTgApiError(errCode, errDesc, parsed?.parameters);
    if (error.code === "RATE_LIMITED" && attempt <= maxRetries) {
      await sleep(computeRetryDelay(parsed?.parameters?.retry_after, attempt));
      continue;
    }
    throw error;
  }
}

export interface SendResult {
  chat: string;
  chunks: number;
  message_ids: number[];
}

/**
 * Send a (possibly long) message to a chat, splitting at Telegram's 4096-char
 * limit and sending each chunk as a separate sendMessage call. 429s are retried
 * per-request by tgRequest. `priority` "low"/"silent" sends silently.
 */
export async function sendChunks(
  text: string,
  ctx: TgRequestContext,
  opts: { title?: string; priority?: string } & TgRequestOptions = {},
): Promise<SendResult> {
  const message = opts.title ? `${opts.title}\n\n${text}` : text;
  const chunks = chunkMessage(message, TG_TEXT_LIMIT);
  const silent = opts.priority === "low" || opts.priority === "silent";
  const messageIds: number[] = [];
  for (const chunk of chunks) {
    const result = await tgRequest<{ message_id: number }>(
      "sendMessage",
      { chat_id: ctx.chatId, text: chunk, disable_notification: silent },
      ctx,
      {
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        sleep: opts.sleep,
      },
    );
    messageIds.push(result.message_id);
  }
  return { chat: ctx.chatId, chunks: chunks.length, message_ids: messageIds };
}
