import { API_BASE, DOWNLOAD_TIMEOUT_MS, TG_TEXT_LIMIT } from "./config.js";
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
  /** External signal that aborts the in-flight request (used by `listen` shutdown). */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 4;
const MAX_RETRY_WAIT_S = 10;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Link an external AbortSignal to a request's AbortController so aborting the
 * external signal aborts the in-flight request (used by `listen` shutdown).
 * Returns a cleanup that removes the listener; safe to call in a `finally`.
 */
function linkAbort(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return (): void => signal.removeEventListener("abort", onAbort);
}

/** Compute the delay before a 429 retry. Honors Telegram retry_after (capped). */
export function computeRetryDelay(retryAfterSeconds: number | undefined, attempt: number): number {
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
    return new AxiError(`Telegram API request timed out after ${timeoutMs}ms`, "TIMEOUT", [
      "Retry; the Telegram API was too slow to respond",
    ]);
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
  signal?: AbortSignal,
): Promise<{ status: number; parsed: TgApiResponse<T> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unlink = linkAbort(controller, signal);
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
    unlink();
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
    const { status, parsed } = await tgFetch<T>(url, body, timeoutMs, opts.signal);
    if (parsed && parsed.ok) return parsed.result as T;
    const errCode = parsed?.error_code ?? status;
    const errDesc = parsed?.description ?? (parsed ? "" : `non-JSON response (HTTP ${status})`);
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

// ── inbound (receive) Bot API methods + shapes ───────────────────────────────
// These mirror the outbound client: same tgRequest POST wrapper (with 429 retry
// and AbortController timeout), except downloadTgFile, which GETs a file_path
// from the file/ endpoint (not a Bot API method).

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface TgMediaBase {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
  duration?: number;
  width?: number;
  height?: number;
  length?: number;
  performer?: string;
  title?: string;
}

/** A Telegram Message. Only the fields tg-axi normalizes are typed; the rest are
 *  carried via the index signature so unknown subtypes still round-trip. */
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  voice?: TgMediaBase;
  audio?: TgMediaBase;
  photo?: TgPhotoSize[];
  video?: TgMediaBase;
  video_note?: TgMediaBase;
  document?: TgMediaBase;
  animation?: TgMediaBase;
  sticker?: TgMediaBase & {
    emoji?: string;
    set_name?: string;
    is_animated?: boolean;
    is_video?: boolean;
    type?: string;
  };
  location?: { longitude: number; latitude: number };
  contact?: { phone_number: string; first_name?: string; last_name?: string; user_id?: number };
  [key: string]: unknown;
}

/** A Telegram Update. `message` and `edited_message` are normalized; any other
 *  top-level update kind (channel_post, callback_query, poll, …) is emitted as
 *  type="unsupported" with its raw subtype, never crashed on. */
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  [key: string]: unknown;
}

export interface TgFile {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

/**
 * Call getUpdates (long-poll). `offset` = first update_id to fetch; passing
 * `offset = last_update_id + 1` also confirms (acks) prior updates. `limit`
 * 1-100; `timeout` long-poll seconds 0-50. The AbortController timeout is
 * `timeout*1000 + slack` so a valid slow long-poll response is never aborted.
 */
export async function getUpdates(
  params: { offset?: number; limit?: number; timeout?: number },
  ctx: TgRequestContext,
  opts: TgRequestOptions = {},
): Promise<TgUpdate[]> {
  const longPoll = Math.max(0, params.timeout ?? 0);
  const body: Record<string, unknown> = {};
  if (params.offset !== undefined) body["offset"] = params.offset;
  if (params.limit !== undefined) body["limit"] = params.limit;
  if (params.timeout !== undefined) body["timeout"] = params.timeout;
  const timeoutMs = opts.timeoutMs ?? (longPoll > 0 ? (longPoll + 10) * 1000 : DEFAULT_TIMEOUT_MS);
  return tgRequest<TgUpdate[]>("getUpdates", body, ctx, { ...opts, timeoutMs });
}

/** Resolve a file_path for download. getFile only serves files up to 20MB. */
export async function getFile(
  fileId: string,
  ctx: TgRequestContext,
  opts: TgRequestOptions = {},
): Promise<TgFile> {
  return tgRequest<TgFile>("getFile", { file_id: fileId }, ctx, opts);
}

/** Delete any active webhook (explicit opt-in; never done implicitly elsewhere). */
export async function deleteWebhook(
  ctx: TgRequestContext,
  opts: TgRequestOptions = {},
): Promise<boolean> {
  const result = await tgRequest<unknown>("deleteWebhook", {}, ctx, opts);
  if (result === true) return true;
  if (typeof result === "object" && result !== null) {
    const deleted = (result as { deleted?: unknown }).deleted;
    if (deleted === true) return true;
  }
  return false;
}

/**
 * Download a Telegram file by the file_path returned by getFile. GETs
 * `${API_BASE}/file/bot<token>/<file_path>` (not a Bot API method). Throws a
 * structured AxiError (NETWORK_ERROR / TIMEOUT) on failure so callers can catch
 * and mark the record `downloaded: false` rather than crash the drain.
 */
export async function downloadTgFile(
  filePath: string,
  ctx: TgRequestContext,
  opts: TgRequestOptions = {},
): Promise<Buffer> {
  const url = `${API_BASE}/file/bot${ctx.token}/${filePath}`;
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unlink = linkAbort(controller, opts.signal);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    throw toFetchError(error, timeoutMs);
  } finally {
    clearTimeout(timer);
    unlink();
  }
  if (!response.ok) {
    throw new AxiError(
      `Telegram file download failed (HTTP ${response.status}) for ${filePath}`,
      "NETWORK_ERROR",
      ["getFile serves files up to 20MB — large files are not downloadable via the Bot API"],
    );
  }
  const ab = await response.arrayBuffer();
  return Buffer.from(ab);
}
