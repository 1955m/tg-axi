import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { isAllowed, type AllowList } from "./access.js";
import { readOffset, writeOffset } from "./offset.js";
import {
  downloadTgFile,
  getFile,
  getUpdates,
  type TgMediaBase,
  type TgMessage,
  type TgPhotoSize,
  type TgRequestContext,
  type TgRequestOptions,
  type TgUpdate,
} from "./tg.js";

/**
 * Inbound receive core, shared by `tg-axi receive` (one-shot drain) and
 * `tg-axi listen` (continuous long-poll loop). The flow is the standard
 * Telegram getUpdates pattern: read the persisted offset → long-poll
 * getUpdates(offset, limit, timeout) → normalize each update into a flat
 * record (text/voice/audio/photo/…/unsupported) → download media via getFile
 * then /file/bot<token>/<file_path> into the inbox → advance the offset to
 * last_update_id + 1 (acks the batch). Re-running from a persisted offset
 * never re-fetches already-acked updates (idempotent in the steady state; only
 * a mid-batch crash can reprocess the in-flight batch — every Bot library has
 * this at-least-once window).
 */

export interface ReceiveOptions {
  /** getUpdates limit (1-100). */
  limit?: number;
  /** getUpdates long-poll seconds (0-50). */
  timeout?: number;
  /** Allowlist of chat/sender ids; non-allowed senders become rejected records. */
  allow: AllowList;
  /** Inbox directory for downloaded media. */
  inboxDir: string;
  /** Offset store path. */
  offsetFile: string;
  /** Skip file downloads (still emit file metadata). */
  noDownload?: boolean;
  /** Injectable file writer for tests. */
  writeFile?: (path: string, bytes: Buffer) => void;
  /** Per-request Bot API timeout / retry overrides + injectable sleep for tests. */
  requestOpts?: TgRequestOptions;
}

export interface NormalizedRecord {
  update_id: number;
  message_id: number | null;
  chat_id: number | null;
  from_id: number | null;
  from_username: string | null;
  from_name: string | null;
  date: number | null;
  type: string;
  decision: "allowed" | "rejected" | "unsupported";
  [key: string]: unknown;
}

export interface DrainResult {
  messages: NormalizedRecord[];
  rejected: NormalizedRecord[];
  unsupported: NormalizedRecord[];
  offsetBefore: number;
  /** New ack offset (last_update_id + 1), or null when no updates were received. */
  newOffset: number | null;
  updatesCount: number;
}

/** Fields added to media records describing the local download outcome. */
interface MediaDownload {
  file: string | null;
  downloaded: boolean;
  reason?: string;
  mime: string | null;
  size: number | null;
  name: string | null;
  file_id: string | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True for AxiError codes a daemon should retry through (transient blips). */
function isTransient(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: string }).code;
    return (
      code === "NETWORK_ERROR" ||
      code === "TIMEOUT" ||
      code === "UNKNOWN" ||
      code === "RATE_LIMITED"
    );
  }
  return true; // unknown non-AxiError → treat as transient so listen survives.
}

/**
 * Drain one getUpdates batch: read offset → fetch → normalize each update
 * (downloading media) → advance the offset. Never throws on a single bad
 * update; unknown subtypes and download failures are recorded, not crashed on.
 * A 409 (other consumer / webhook active), 401, etc. propagate as AxiErrors.
 */
export async function drainUpdates(
  apiCtx: TgRequestContext,
  opts: ReceiveOptions,
): Promise<DrainResult> {
  const offset = readOffset(opts.offsetFile);
  const updates = await getUpdates(
    { offset, limit: opts.limit, timeout: opts.timeout },
    apiCtx,
    opts.requestOpts ?? {},
  );
  const messages: NormalizedRecord[] = [];
  const rejected: NormalizedRecord[] = [];
  const unsupported: NormalizedRecord[] = [];
  for (const update of updates) {
    const record = await normalizeUpdateSafe(update, apiCtx, opts);
    if (record.decision === "rejected") rejected.push(record);
    else if (record.decision === "unsupported") unsupported.push(record);
    else messages.push(record);
  }
  let newOffset: number | null = null;
  if (updates.length > 0) {
    newOffset = updates.reduce((m, u) => Math.max(m, u.update_id), 0) + 1;
    writeOffset(newOffset, opts.offsetFile);
  }
  return {
    messages,
    rejected,
    unsupported,
    offsetBefore: offset,
    newOffset,
    updatesCount: updates.length,
  };
}

/**
 * Continuous long-poll loop over {@link drainUpdates}. Writes each non-empty
 * batch (TOON) to `writer` as it arrives, advances the offset per batch, and
 * stops cleanly when `shouldStop()` returns true (SIGINT/SIGTERM in the CLI).
 * `stopSignal` aborts the in-flight long-poll so shutdown is prompt, not gated
 * by the long-poll timeout. Transient errors (network/timeout/5xx/429-exhausted)
 * are retried with backoff; operator-action errors (409 conflict, 401 auth)
 * propagate.
 */
export async function listenUpdates(
  apiCtx: TgRequestContext,
  opts: ReceiveOptions,
  emit: (result: DrainResult) => void,
  shouldStop: () => boolean,
  stopSignal?: AbortSignal,
): Promise<{ batches: number; messages: number; rejected: number; unsupported: number }> {
  const sleep = opts.requestOpts?.sleep ?? defaultSleep;
  const drainOpts: ReceiveOptions = {
    ...opts,
    requestOpts: { ...opts.requestOpts, ...(stopSignal ? { signal: stopSignal } : {}) },
  };
  let batches = 0;
  let messages = 0;
  let rejected = 0;
  let unsupported = 0;
  let backoff = 1_000;
  while (!shouldStop()) {
    let result: DrainResult;
    try {
      result = await drainUpdates(apiCtx, drainOpts);
      backoff = 1_000; // reset after a successful drain
    } catch (error) {
      if (shouldStop()) break; // abort from shutdown → clean exit, offset already at last full batch
      if (isTransient(error)) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      throw error; // 409 / auth / forbidden → operator must act
    }
    batches++;
    messages += result.messages.length;
    rejected += result.rejected.length;
    unsupported += result.unsupported.length;
    if (result.messages.length || result.rejected.length || result.unsupported.length) {
      emit(result);
    }
    // With long-poll timeout>0 getUpdates blocks, so no busy loop. Only idle
    // when a no-download short-poll batch came back empty.
    if ((opts.timeout ?? 0) === 0 && result.updatesCount === 0) {
      await sleep(250);
    }
  }
  return { batches, messages, rejected, unsupported };
}

/** Build the plain output object the runtime TOON-serializes (or JSON-stringifies). */
export function buildReceiveOutput(
  result: DrainResult,
  audit?: { allow?: string; inbox?: string; webhook?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    received: result.messages.length,
    offset: result.newOffset ?? result.offsetBefore,
  };
  if (audit?.allow) out["allow"] = audit.allow;
  if (audit?.inbox) out["inbox"] = audit.inbox;
  if (audit?.webhook) out["webhook"] = audit.webhook;
  if (result.messages.length > 0) out["messages"] = result.messages;
  if (result.rejected.length > 0) out["rejected"] = result.rejected;
  if (result.unsupported.length > 0) out["unsupported"] = result.unsupported;
  return out;
}

/**
 * Normalize one Update into a flat record. A `message`/`edited_message` is
 * classified by its media field; any other update kind (callback_query,
 * channel_post, poll, …) becomes type="unsupported" with the raw subtype.
 */
export async function normalizeUpdate(
  update: TgUpdate,
  apiCtx: TgRequestContext,
  opts: ReceiveOptions,
): Promise<NormalizedRecord> {
  const msg: TgMessage | undefined = update.message ?? update.edited_message;
  if (!msg) {
    const subtype = detectUnsupportedSubtype(update);
    return {
      update_id: update.update_id,
      message_id: null,
      chat_id: null,
      from_id: null,
      from_username: null,
      from_name: null,
      date: null,
      type: "unsupported",
      decision: "unsupported",
      subtype,
    };
  }
  const base = baseRecord(update.update_id, msg);
  if (!isAllowed(base.chat_id, base.from_id, opts.allow)) {
    return { ...base, type: "rejected", decision: "rejected" };
  }
  return normalizeMessage(base, msg, apiCtx, opts);
}

/**
 * normalizeUpdate, guarded: an unexpected shape (e.g. a malformed media array)
 * must never abort the whole batch or block the offset from advancing — it is
 * recorded as type="unsupported" instead, same as a genuinely unknown update kind.
 */
async function normalizeUpdateSafe(
  update: TgUpdate,
  apiCtx: TgRequestContext,
  opts: ReceiveOptions,
): Promise<NormalizedRecord> {
  try {
    return await normalizeUpdate(update, apiCtx, opts);
  } catch (error) {
    return {
      update_id: update.update_id,
      message_id: null,
      chat_id: null,
      from_id: null,
      from_username: null,
      from_name: null,
      date: null,
      type: "unsupported",
      decision: "unsupported",
      subtype: "normalize_error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function baseRecord(update_id: number, msg: TgMessage): NormalizedRecord {
  const from = msg.from;
  const first = from?.first_name ?? "";
  const last = from?.last_name ?? "";
  const name = (first + " " + last).trim();
  return {
    update_id,
    message_id: msg.message_id,
    chat_id: msg.chat?.id ?? null,
    from_id: from?.id ?? null,
    from_username: from?.username ?? null,
    from_name: name.length > 0 ? name : null,
    date: typeof msg.date === "number" ? msg.date : null,
    type: "unsupported",
    decision: "allowed",
  };
}

/** The first top-level update key that isn't update_id (callback_query, poll, …). */
function detectUnsupportedSubtype(update: TgUpdate): string {
  for (const key of Object.keys(update)) {
    if (key !== "update_id") return key;
  }
  return "unknown";
}

async function normalizeMessage(
  base: NormalizedRecord,
  msg: TgMessage,
  apiCtx: TgRequestContext,
  opts: ReceiveOptions,
): Promise<NormalizedRecord> {
  const caption = msg.caption ?? null;

  if (msg.text !== undefined) {
    return { ...base, type: "text", text: msg.text };
  }
  if (msg.voice) {
    return mediaRecord(
      base,
      "voice",
      msg.voice,
      { caption, duration: msg.voice.duration, mime: msg.voice.mime_type, ext: "oga" },
      apiCtx,
      opts,
    );
  }
  if (msg.audio) {
    return mediaRecord(
      base,
      "audio",
      msg.audio,
      {
        caption,
        duration: msg.audio.duration,
        mime: msg.audio.mime_type,
        performer: msg.audio.performer,
        title: msg.audio.title,
        name: msg.audio.file_name,
        ext: "mp3",
      },
      apiCtx,
      opts,
    );
  }
  if (msg.photo) {
    const largest = pickLargestPhoto(msg.photo);
    if (largest) {
      return mediaRecord(
        base,
        "photo",
        largest,
        { caption, mime: "image/jpeg", width: largest.width, height: largest.height },
        apiCtx,
        opts,
      );
    }
  }
  if (msg.video) {
    return mediaRecord(
      base,
      "video",
      msg.video,
      {
        caption,
        duration: msg.video.duration,
        mime: msg.video.mime_type,
        width: msg.video.width,
        height: msg.video.height,
        name: msg.video.file_name,
        ext: "mp4",
      },
      apiCtx,
      opts,
    );
  }
  if (msg.video_note) {
    return mediaRecord(
      base,
      "video_note",
      msg.video_note,
      { duration: msg.video_note.duration, length: msg.video_note.length, mime: "video/mp4" },
      apiCtx,
      opts,
    );
  }
  if (msg.document) {
    return mediaRecord(
      base,
      "document",
      msg.document,
      { caption, mime: msg.document.mime_type, name: msg.document.file_name },
      apiCtx,
      opts,
    );
  }
  if (msg.animation) {
    return mediaRecord(
      base,
      "animation",
      msg.animation,
      {
        caption,
        duration: msg.animation.duration,
        mime: msg.animation.mime_type,
        width: msg.animation.width,
        height: msg.animation.height,
        name: msg.animation.file_name,
        ext: "mp4",
      },
      apiCtx,
      opts,
    );
  }
  if (msg.sticker) {
    return mediaRecord(
      base,
      "sticker",
      msg.sticker,
      {
        emoji: msg.sticker.emoji,
        set_name: msg.sticker.set_name,
        width: msg.sticker.width,
        height: msg.sticker.height,
        is_animated: msg.sticker.is_animated,
        is_video: msg.sticker.is_video,
        sticker_type: msg.sticker.type,
        mime: stickerMime(msg.sticker),
      },
      apiCtx,
      opts,
    );
  }
  if (msg.location) {
    return {
      ...base,
      type: "location",
      longitude: msg.location.longitude,
      latitude: msg.location.latitude,
    };
  }
  if (msg.contact) {
    return {
      ...base,
      type: "contact",
      phone: msg.contact.phone_number,
      first_name: msg.contact.first_name ?? null,
      last_name: msg.contact.last_name ?? null,
      user_id: msg.contact.user_id ?? null,
    };
  }
  // No recognized type — still allowed, but emit unsupported with the raw payload.
  return { ...base, type: "unsupported", decision: "unsupported", subtype: "message" };
}

interface MediaExtra {
  caption?: string | null;
  duration?: number;
  mime?: string;
  width?: number;
  height?: number;
  length?: number;
  name?: string;
  performer?: string;
  title?: string;
  ext?: string;
  emoji?: string;
  set_name?: string;
  is_animated?: boolean;
  is_video?: boolean;
  sticker_type?: string;
}

/** Drop keys whose value is undefined, so TOON encode() doesn't render a stray `field: null`. */
function definedFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function mediaRecord(
  base: NormalizedRecord,
  type: string,
  media: TgMediaBase,
  extra: MediaExtra,
  apiCtx: TgRequestContext,
  opts: ReceiveOptions,
): Promise<NormalizedRecord> {
  const dl = await fetchMedia(media, extra, base.update_id, base.message_id ?? 0, apiCtx, opts);
  const record: NormalizedRecord = {
    ...base,
    type,
    mime: dl.mime,
    size: dl.size,
    ...definedFields({
      duration: extra.duration,
      width: extra.width,
      height: extra.height,
      length: extra.length,
      performer: extra.performer,
      title: extra.title,
      emoji: extra.emoji,
      set_name: extra.set_name,
      is_animated: extra.is_animated,
      is_video: extra.is_video,
      sticker_type: extra.sticker_type,
    }),
    name: dl.name,
    caption: extra.caption ?? null,
    file_id: dl.file_id,
    file: dl.file,
    downloaded: dl.downloaded,
    ...(dl.reason !== undefined ? { reason: dl.reason } : {}),
  };
  return record;
}

async function fetchMedia(
  media: TgMediaBase,
  extra: MediaExtra,
  updateId: number,
  messageId: number,
  apiCtx: TgRequestContext,
  opts: ReceiveOptions,
): Promise<MediaDownload> {
  const fileId = media.file_id ?? null;
  const size = media.file_size ?? null;
  const mime = extra.mime ?? media.mime_type ?? null;
  const name = extra.name ?? null;
  if (opts.noDownload) {
    return {
      file: null,
      downloaded: false,
      reason: "no-download",
      mime,
      size,
      name,
      file_id: fileId,
    };
  }
  if (!fileId) {
    return {
      file: null,
      downloaded: false,
      reason: "missing file_id",
      mime,
      size,
      name,
      file_id: fileId,
    };
  }
  try {
    const file = await getFile(fileId, apiCtx, opts.requestOpts ?? {});
    const filePath = file.file_path;
    if (!filePath) {
      return {
        file: null,
        downloaded: false,
        reason: "no file_path from getFile",
        mime,
        size: size ?? file.file_size ?? null,
        name,
        file_id: fileId,
      };
    }
    const bytes = await downloadTgFile(filePath, apiCtx, opts.requestOpts ?? {});
    const basename = safeBasename(filePath, mime, extra.ext);
    const localPath = join(opts.inboxDir, `${updateId}_${messageId}_${basename}`);
    if (opts.writeFile) {
      opts.writeFile(localPath, bytes);
    } else {
      mkdirSync(opts.inboxDir, { recursive: true });
      writeFileSync(localPath, bytes);
    }
    return {
      file: localPath,
      downloaded: true,
      mime,
      size: size ?? file.file_size ?? bytes.length,
      name: name ?? basename,
      file_id: fileId,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { file: null, downloaded: false, reason, mime, size, name, file_id: fileId };
  }
}

/** Pick the largest photo size (by file_size, then by dimensions), or undefined for an empty/malformed array. */
function pickLargestPhoto(sizes: TgPhotoSize[]): TgPhotoSize | undefined {
  if (!Array.isArray(sizes) || sizes.length === 0) return undefined;
  let best = sizes[0];
  let bestScore = scorePhoto(best);
  for (let i = 1; i < sizes.length; i++) {
    const score = scorePhoto(sizes[i]);
    if (score > bestScore) {
      best = sizes[i];
      bestScore = score;
    }
  }
  return best;
}

function scorePhoto(s: TgPhotoSize): number {
  if (s.file_size && s.file_size > 0) return s.file_size;
  const w = s.width ?? 0;
  const h = s.height ?? 0;
  return w * h;
}

/** A filesystem-safe basename, deriving an extension from mime when the path lacks one. */
function safeBasename(filePath: string, mime: string | null, fallbackExt?: string): string {
  const raw =
    String(filePath)
      .replace(/[\\/]+/g, "/")
      .split("/")
      .pop() ?? "";
  let name = raw.length > 0 ? raw : `file_${Date.now()}`;
  if (!extname(name)) {
    const ext = mimeExtension(mime) ?? fallbackExt ?? "bin";
    name = `${name}.${ext}`;
  }
  return name;
}

function mimeExtension(mime: string | null): string | null {
  if (!mime) return null;
  const map: Record<string, string> = {
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "application/pdf": "pdf",
    "application/zip": "zip",
  };
  return map[mime.toLowerCase()] ?? null;
}

function stickerMime(
  s: TgMediaBase & { is_video?: boolean; is_animated?: boolean; type?: string },
): string {
  if (s.is_video) return "video/webm";
  if (s.type === "video") return "video/webm";
  if (s.is_animated || s.type === "animated" || s.type === "mask") return "image/webp";
  return "image/webp";
}
