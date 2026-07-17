import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { offsetFilePath } from "./config.js";

/**
 * Last-acked Telegram update_id store. Telegram getUpdates confirms (acks) an
 * update once a subsequent call passes `offset = update_id + 1`, so the store
 * holds that next-offset value: `readOffset()` returns the first update_id to
 * fetch, `writeOffset(lastUpdateId + 1)` persists the ack point. Re-running
 * `receive` from a persisted offset never re-fetches already-acked updates,
 * which is the idempotency guarantee (only a mid-batch crash can reprocess the
 * in-flight batch — every Bot library has this at-least-once window).
 */

/** Read the persisted offset, or 0 when the store does not yet exist. */
export function readOffset(file: string = offsetFilePath()): number {
  if (!existsSync(file)) return 0;
  const content = readFileSync(file, "utf8").trim();
  if (content.length === 0) return 0;
  const parsed = parseInt(content, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Persist the offset atomically (write to a sibling temp file then rename, so a
 * crash mid-write never leaves a truncated store). Writes the integer as text.
 */
export function writeOffset(value: number, file: string = offsetFilePath()): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Refusing to write invalid offset: ${value}`);
  }
  const tmp = join(dirname(file) || ".", `.offset.${process.pid}.tmp`);
  writeFileSync(tmp, `${value}\n`);
  renameSync(tmp, file);
}
