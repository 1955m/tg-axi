import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { AxiError, redactSecrets } from "./errors.js";
import { tgRequest, type TgRequestContext, type TgRequestOptions } from "./tg.js";
import { TG_TEXT_LIMIT } from "./config.js";

export const NOTIFICATION_EVENT_SCHEMA = "tg-axi/notification-event/v1";
export const DELIVERY_RECORD_SCHEMA = "tg-axi/notification-delivery/v1";
export const DELIVERY_METADATA_SCHEMA = "tg-axi/notification-metadata/v1";

export type NotificationKind = "review_ready" | "completion" | "blocker";
export type DeliveryState = "pending" | "confirmed" | "failed" | "unknown";

export interface NotificationLink {
  label: string;
  url: string;
}

export interface NotificationEvent {
  schema: typeof NOTIFICATION_EVENT_SCHEMA;
  event_id: string;
  kind: NotificationKind;
  owner: string;
  task_id: string;
  revision: string;
  occurred_at: string;
  summary: string;
  links: NotificationLink[];
}

export interface DeliveryRecord {
  schema: typeof DELIVERY_RECORD_SCHEMA;
  event_id: string;
  event_hash: string;
  chat_id: string;
  delivery: DeliveryState;
  confirmed_chunks: number;
  chunks: number;
  message_ids: number[];
  failure_kind?: "definite" | "uncertain";
  error?: { code: string; message: string };
  updated_at: string;
}

export interface NotificationResult {
  event_id: string;
  delivery: DeliveryState;
  deduplicated: boolean;
  chat: string;
  chunks: number;
  confirmed_chunks: number;
  message_ids: number[];
  event_file: string;
  receipt_file: string;
}

export interface DeliverySummary {
  delivery_dir: string;
  events: number;
  confirmed: number;
  pending: number;
  failed: number;
  unknown: number;
  latest_updated_at?: string;
}

export interface NotificationDeliveryOptions extends TgRequestOptions {
  retry?: boolean;
  persist?: (path: string, record: DeliveryRecord) => void;
}

const KIND_LABELS: Record<NotificationKind, string> = {
  review_ready: "可供審閱",
  completion: "完成",
  blocker: "阻礙",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function assertSingleLine(
  value: unknown,
  label: string,
  maxLength: number,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new AxiError(
      `${label} must be a non-empty string of at most ${maxLength} characters`,
      "VALIDATION_ERROR",
    );
  }
  if (
    [...value].some((char) => char === "\r" || char === "\n" || char < " " || char === "\u007f")
  ) {
    throw new AxiError(`${label} must be a single-line printable string`, "VALIDATION_ERROR");
  }
}

function validateHttps(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    [...value].some(
      (char) => /\s/.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Validate the small event contract Firstmate uses to request a notification. */
export function validateNotificationEvent(value: unknown): NotificationEvent {
  if (!isObject(value) || value.schema !== NOTIFICATION_EVENT_SCHEMA) {
    throw new AxiError(
      `notification event schema must be ${NOTIFICATION_EVENT_SCHEMA}`,
      "VALIDATION_ERROR",
    );
  }
  if (!isSafeId(value.event_id))
    throw new AxiError("event_id is not path-safe", "VALIDATION_ERROR");
  if (
    typeof value.kind !== "string" ||
    !Object.prototype.hasOwnProperty.call(KIND_LABELS, value.kind)
  ) {
    throw new AxiError("kind must be review_ready, completion, or blocker", "VALIDATION_ERROR");
  }
  if (!isSafeId(value.owner)) throw new AxiError("owner is not path-safe", "VALIDATION_ERROR");
  if (!isSafeId(value.task_id)) throw new AxiError("task_id is not path-safe", "VALIDATION_ERROR");
  assertSingleLine(value.revision, "revision", 128);
  assertSingleLine(value.occurred_at, "occurred_at", 64);
  assertSingleLine(value.summary, "summary", 700);
  if (!Array.isArray(value.links) || value.links.length < 1 || value.links.length > 3) {
    throw new AxiError("links must contain one to three HTTPS links", "VALIDATION_ERROR");
  }
  const links: NotificationLink[] = value.links.map((link, index) => {
    if (!isObject(link))
      throw new AxiError(`links[${index}] must be an object`, "VALIDATION_ERROR");
    assertSingleLine(link.label, `links[${index}].label`, 80);
    if (!validateHttps(link.url))
      throw new AxiError(`links[${index}].url must be an HTTPS URL`, "VALIDATION_ERROR");
    return { label: link.label, url: link.url };
  });
  if (Object.prototype.hasOwnProperty.call(value, "priority")) {
    throw new AxiError("notification priority is not supported", "VALIDATION_ERROR");
  }
  const event = {
    schema: NOTIFICATION_EVENT_SCHEMA,
    event_id: value.event_id,
    kind: value.kind,
    owner: value.owner,
    task_id: value.task_id,
    revision: value.revision,
    occurred_at: value.occurred_at,
    summary: value.summary,
    links,
  } as NotificationEvent;
  const rendered = renderNotification(event);
  if (rendered.length > TG_TEXT_LIMIT) {
    throw new AxiError(
      `rendered notification exceeds Telegram's ${TG_TEXT_LIMIT}-character limit`,
      "VALIDATION_ERROR",
    );
  }
  return event;
}

/** Render the intentionally short Traditional Chinese notification body. */
export function renderNotification(event: NotificationEvent): string {
  return [
    `${KIND_LABELS[event.kind]}｜${event.task_id}`,
    event.summary,
    ...event.links.map((link) => `${link.label}：${link.url}`),
  ].join("\n");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function eventHash(event: NotificationEvent): string {
  return createHash("sha256").update(stableJson(event)).digest("hex");
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new AxiError(
        `delivery directory must be a private mode-0700 directory: ${path}`,
        "VALIDATION_ERROR",
      );
    }
  } catch (error) {
    if (error instanceof AxiError) throw error;
    throw new AxiError(`could not prepare private delivery directory: ${path}`, "VALIDATION_ERROR");
  }
}

function atomicWrite(path: string, value: unknown): void {
  const parent = dirname(path);
  ensurePrivateDirectory(parent);
  const temp = join(parent, `.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    const dirFd = openSync(parent, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )) {
        throw error;
      }
    }
  }
}

function exclusiveWrite(path: string, value: unknown): void {
  const parent = dirname(path);
  ensurePrivateDirectory(parent);
  const temp = join(parent, `.${process.pid}.${Math.random().toString(16).slice(2)}.claim`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, 0o600);
    linkSync(temp, path);
    const dirFd = openSync(parent, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )) {
        throw error;
      }
    }
  }
}

function readJson(path: string): unknown {
  try {
    if (!lstatSync(path).isFile()) throw new Error("not a regular file");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new AxiError(`invalid private delivery record: ${path}`, "VALIDATION_ERROR");
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw new AxiError(`could not inspect private delivery record: ${path}`, "VALIDATION_ERROR");
  }
}

function metadataPath(dir: string): string {
  return join(dir, "metadata.json");
}

function eventPath(dir: string, eventId: string): string {
  return join(dir, "events", `${eventId}.json`);
}

function receiptPath(dir: string, eventId: string): string {
  return join(dir, "receipts", `${eventId}.json`);
}

function botFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

function ensureDeliveryIdentity(dir: string, ctx: TgRequestContext): void {
  ensurePrivateDirectory(dir);
  ensurePrivateDirectory(join(dir, "events"));
  ensurePrivateDirectory(join(dir, "receipts"));
  const path = metadataPath(dir);
  const expected = {
    schema: DELIVERY_METADATA_SCHEMA,
    bot_fingerprint: botFingerprint(ctx.token),
    chat_id: ctx.chatId,
  };
  try {
    exclusiveWrite(path, expected);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    )) {
      throw new AxiError(`could not claim private delivery identity: ${path}`, "VALIDATION_ERROR");
    }
  }
  const actual = readJson(path);
  if (
    !isObject(actual) ||
    actual.schema !== expected.schema ||
    actual.bot_fingerprint !== expected.bot_fingerprint ||
    actual.chat_id !== expected.chat_id
  ) {
    throw new AxiError(
      "private delivery records belong to a different bot or chat",
      "VALIDATION_ERROR",
      ["Use a separate --delivery-dir for each Telegram bot and target chat"],
    );
  }
}

function readDeliveryRecord(path: string): DeliveryRecord {
  const value = readJson(path);
  if (
    !isObject(value) ||
    value.schema !== DELIVERY_RECORD_SCHEMA ||
    typeof value.event_id !== "string" ||
    typeof value.event_hash !== "string" ||
    typeof value.chat_id !== "string" ||
    !["pending", "confirmed", "failed", "unknown"].includes(String(value.delivery)) ||
    typeof value.confirmed_chunks !== "number" ||
    typeof value.chunks !== "number" ||
    !Array.isArray(value.message_ids) ||
    value.message_ids.some((id) => typeof id !== "number") ||
    typeof value.updated_at !== "string"
  ) {
    throw new AxiError(`invalid private delivery receipt: ${path}`, "VALIDATION_ERROR");
  }
  return value as unknown as DeliveryRecord;
}

function writeDeliveryRecord(path: string, record: DeliveryRecord): void {
  atomicWrite(path, record);
}

function claimPath(dir: string, eventId: string): string {
  return join(dir, "receipts", `${eventId}.claim`);
}

async function claimDelivery(dir: string, eventId: string): Promise<() => Promise<void>> {
  const path = claimPath(dir, eventId);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      stale: 2_000,
      update: 1_000,
      retries: 0,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ELOCKED"
    ) {
      throw new AxiError(
        `notification ${eventId} is already claimed by another delivery attempt`,
        "VALIDATION_ERROR",
      );
    }
    throw new AxiError(`could not claim notification ${eventId}`, "VALIDATION_ERROR");
  }
  return async (): Promise<void> => release();
}

function isUncertain(error: unknown): boolean {
  return error instanceof AxiError && ["NETWORK_ERROR", "TIMEOUT", "UNKNOWN"].includes(error.code);
}

function errorDetails(error: unknown): { code: string; message: string } {
  const code = error instanceof AxiError ? error.code : "UNKNOWN";
  return { code, message: redactSecrets(error instanceof Error ? error.message : String(error)) };
}

export class NotificationDeliveryError extends AxiError {
  readonly record: DeliveryRecord;
  readonly receiptFile: string;

  constructor(record: DeliveryRecord, receiptFile: string) {
    super(
      `notification ${record.event_id} delivery=${record.delivery}; receipt saved at ${receiptFile}`,
      record.error?.code ?? (record.failure_kind === "uncertain" ? "NETWORK_ERROR" : "UNKNOWN"),
      [
        "Inspect the receipt before retrying; Telegram delivery is not exactly-once",
        `Retry explicitly with --retry --event-file <path>`,
      ],
    );
    this.record = record;
    this.receiptFile = receiptFile;
  }
}

export class NotificationPersistenceError extends AxiError {
  constructor(eventId: string, receiptFile: string, error: unknown) {
    super(
      `Telegram acknowledged notification ${eventId}, but the receipt could not be persisted at ${receiptFile}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      "UNKNOWN",
      ["Repair local delivery storage before deciding whether an explicit retry is safe"],
    );
  }
}

/** Deliver one event, preserving a private receipt at every handoff boundary. */
export async function deliverNotification(
  event: NotificationEvent,
  ctx: TgRequestContext,
  dir: string,
  options: NotificationDeliveryOptions = {},
): Promise<NotificationResult> {
  const persist = options.persist ?? writeDeliveryRecord;
  ensureDeliveryIdentity(dir, ctx);
  const eventFile = eventPath(dir, event.event_id);
  const receiptFile = receiptPath(dir, event.event_id);
  const hash = eventHash(event);
  if (pathExists(eventFile)) {
    const existing = validateNotificationEvent(readJson(eventFile));
    if (eventHash(existing) !== hash) {
      throw new AxiError(
        `event_id already exists with different content: ${event.event_id}`,
        "VALIDATION_ERROR",
      );
    }
  } else {
    try {
      exclusiveWrite(eventFile, event);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      )) {
        throw new AxiError(
          `could not claim notification event: ${event.event_id}`,
          "VALIDATION_ERROR",
        );
      }
      const existing = validateNotificationEvent(readJson(eventFile));
      if (eventHash(existing) !== hash) {
        throw new AxiError(
          `event_id already exists with different content: ${event.event_id}`,
          "VALIDATION_ERROR",
        );
      }
    }
  }

  if (pathExists(receiptFile)) {
    const existing = readDeliveryRecord(receiptFile);
    if (existing.event_hash !== hash || existing.chat_id !== ctx.chatId) {
      throw new AxiError(
        `delivery receipt does not match event ${event.event_id}`,
        "VALIDATION_ERROR",
      );
    }
    if (existing.delivery === "confirmed") {
      return {
        event_id: event.event_id,
        delivery: "confirmed",
        deduplicated: true,
        chat: existing.chat_id,
        chunks: existing.chunks,
        confirmed_chunks: existing.confirmed_chunks,
        message_ids: existing.message_ids,
        event_file: eventFile,
        receipt_file: receiptFile,
      };
    }
    if (!options.retry) throw new NotificationDeliveryError(existing, receiptFile);
  }

  const releaseClaim = await claimDelivery(dir, event.event_id);
  try {
    if (pathExists(receiptFile)) {
      const existing = readDeliveryRecord(receiptFile);
      if (existing.event_hash !== hash || existing.chat_id !== ctx.chatId) {
        throw new AxiError(
          `delivery receipt does not match event ${event.event_id}`,
          "VALIDATION_ERROR",
        );
      }
      if (existing.delivery === "confirmed") {
        return {
          event_id: event.event_id,
          delivery: "confirmed",
          deduplicated: true,
          chat: existing.chat_id,
          chunks: existing.chunks,
          confirmed_chunks: existing.confirmed_chunks,
          message_ids: existing.message_ids,
          event_file: eventFile,
          receipt_file: receiptFile,
        };
      }
      if (!options.retry) throw new NotificationDeliveryError(existing, receiptFile);
    }

    let record: DeliveryRecord = {
      schema: DELIVERY_RECORD_SCHEMA,
      event_id: event.event_id,
      event_hash: hash,
      chat_id: ctx.chatId,
      delivery: "pending",
      confirmed_chunks: 0,
      chunks: 1,
      message_ids: [],
      updated_at: new Date().toISOString(),
    };
    persist(receiptFile, record);
    let result: { message_id: number };
    try {
      result = await tgRequest<{ message_id: number }>(
        "sendMessage",
        { chat_id: ctx.chatId, text: renderNotification(event) },
        ctx,
        options,
      );
    } catch (error) {
      const uncertain = isUncertain(error);
      record = {
        ...record,
        delivery: uncertain ? "unknown" : "failed",
        failure_kind: uncertain ? "uncertain" : "definite",
        error: errorDetails(error),
        updated_at: new Date().toISOString(),
      };
      persist(receiptFile, record);
      throw new NotificationDeliveryError(record, receiptFile);
    }
    record = {
      ...record,
      delivery: "confirmed",
      confirmed_chunks: 1,
      message_ids: [result.message_id],
      updated_at: new Date().toISOString(),
    };
    try {
      persist(receiptFile, record);
    } catch (error) {
      throw new NotificationPersistenceError(event.event_id, receiptFile, error);
    }
    return {
      event_id: event.event_id,
      delivery: record.delivery,
      deduplicated: false,
      chat: record.chat_id,
      chunks: record.chunks,
      confirmed_chunks: record.confirmed_chunks,
      message_ids: record.message_ids,
      event_file: eventFile,
      receipt_file: receiptFile,
    };
  } finally {
    await releaseClaim();
  }
}

/** Read-only local status for startup and operator checks; never contacts Telegram. */
export function readDeliverySummary(dir: string): DeliverySummary {
  if (!pathExists(dir)) {
    return {
      delivery_dir: dir,
      events: 0,
      confirmed: 0,
      pending: 0,
      failed: 0,
      unknown: 0,
    };
  }
  ensurePrivateDirectory(dir);
  const receiptsDir = join(dir, "receipts");
  if (!pathExists(receiptsDir)) {
    return {
      delivery_dir: dir,
      events: 0,
      confirmed: 0,
      pending: 0,
      failed: 0,
      unknown: 0,
    };
  }
  ensurePrivateDirectory(receiptsDir);
  const records = readdirSync(receiptsDir)
    .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name))
    .map((name) => readDeliveryRecord(join(receiptsDir, name)));
  const summary: DeliverySummary = {
    delivery_dir: dir,
    events: records.length,
    confirmed: records.filter((record) => record.delivery === "confirmed").length,
    pending: records.filter((record) => record.delivery === "pending").length,
    failed: records.filter((record) => record.delivery === "failed").length,
    unknown: records.filter((record) => record.delivery === "unknown").length,
  };
  const latest = records
    .map((record) => record.updated_at)
    .sort()
    .at(-1);
  if (latest) summary.latest_updated_at = latest;
  return summary;
}

export function readNotificationEvent(path: string): NotificationEvent {
  try {
    return validateNotificationEvent(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof AxiError) throw error;
    throw new AxiError(`could not read notification event file: ${path}`, "VALIDATION_ERROR");
  }
}
