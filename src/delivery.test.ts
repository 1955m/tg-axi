import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliverNotification,
  NotificationDeliveryError,
  readDeliverySummary,
  validateNotificationEvent,
  type NotificationEvent,
} from "./delivery.js";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
const CTX = { token: TOKEN, chatId: "123456789" };
const event: NotificationEvent = {
  schema: "tg-axi/notification-event/v1",
  event_id: "completion.task-42.r7",
  kind: "completion",
  owner: "primary",
  task_id: "task-42",
  revision: "r7",
  occurred_at: "2026-09-10T12:00:00Z",
  summary: "本輪修改已完成，請查看成果。",
  links: [{ label: "PR", url: "https://github.com/1955m/tg-axi/pull/123" }],
};

const realFetch = globalThis.fetch;
let roots: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "tg-axi-delivery-"));
  roots.push(value);
  return value;
}

function response(body: unknown, status = 200): Response {
  return { status, text: () => Promise.resolve(JSON.stringify(body)) } as Response;
}

function ok(messageId: number): Response {
  return response({ ok: true, result: { message_id: messageId } });
}

describe("notification event validation", () => {
  it("requires a real HTTPS link and keeps the event compact", () => {
    expect(() => validateNotificationEvent({ ...event, links: [] })).toThrow(/one to three HTTPS/);
    expect(() =>
      validateNotificationEvent({ ...event, links: [{ label: "x", url: "http://example.com" }] }),
    ).toThrow(/HTTPS/);
    expect(validateNotificationEvent(event).summary).toContain("完成");
  });
});

describe("durable notification delivery", () => {
  it("persists a confirmed receipt and deduplicates replay after restart", async () => {
    const dir = root();
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(ok(42));
    }) as unknown as typeof fetch;

    const first = await deliverNotification(event, CTX, dir);
    const second = await deliverNotification(event, CTX, dir);

    expect(first.delivery).toBe("confirmed");
    expect(first.deduplicated).toBe(false);
    expect(second).toMatchObject({ delivery: "confirmed", deduplicated: true, message_ids: [42] });
    expect(calls).toBe(1);
    const receipt = JSON.parse(readFileSync(first.receipt_file, "utf8")) as Record<string, unknown>;
    expect(receipt.delivery).toBe("confirmed");
    expect(statSync(first.receipt_file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(
      expect.arrayContaining(["events", "receipts", "metadata.json"]),
    );
    expect(readDeliverySummary(dir)).toMatchObject({ events: 1, confirmed: 1, pending: 0 });
  });

  it("records uncertain delivery without exposing the token or false success", async () => {
    const dir = root();
    globalThis.fetch = (() =>
      Promise.reject(
        new Error(`socket failed at /bot${TOKEN}/sendMessage`),
      )) as unknown as typeof fetch;

    try {
      await deliverNotification(event, CTX, dir);
      throw new Error("expected uncertain delivery");
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationDeliveryError);
      expect(String(error)).not.toContain(TOKEN);
    }
    const receiptPath = join(dir, "receipts", `${event.event_id}.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    expect(receipt.delivery).toBe("unknown");
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(readDeliverySummary(dir)).toMatchObject({ events: 1, unknown: 1, confirmed: 0 });

    let replayCalls = 0;
    globalThis.fetch = (() => {
      replayCalls++;
      return Promise.resolve(ok(43));
    }) as unknown as typeof fetch;
    await expect(deliverNotification(event, CTX, dir)).rejects.toBeInstanceOf(
      NotificationDeliveryError,
    );
    expect(replayCalls).toBe(0);
  });

  it("records a definite API failure separately from uncertainty", async () => {
    const dir = root();
    globalThis.fetch = (() =>
      Promise.resolve(
        response({ ok: false, error_code: 403, description: "forbidden" }, 403),
      )) as unknown as typeof fetch;

    await expect(deliverNotification(event, CTX, dir)).rejects.toBeInstanceOf(
      NotificationDeliveryError,
    );
    const receipt = JSON.parse(
      readFileSync(join(dir, "receipts", `${event.event_id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({ delivery: "failed", failure_kind: "definite" });
  });

  it("records confirmed chunks before a later chunk becomes uncertain", async () => {
    const dir = root();
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return calls === 1 ? Promise.resolve(ok(44)) : Promise.reject(new Error("connection closed"));
    }) as unknown as typeof fetch;
    const longEvent = {
      ...event,
      event_id: "completion.task-42.long",
      summary: "x".repeat(700),
      links: [
        { label: "PR", url: `https://github.com/${"a".repeat(1400)}` },
        { label: "成果", url: `https://example.com/${"b".repeat(1400)}` },
        { label: "報告", url: `https://example.org/${"c".repeat(1400)}` },
      ],
    };

    await expect(deliverNotification(longEvent, CTX, dir)).rejects.toBeInstanceOf(
      NotificationDeliveryError,
    );
    const receipt = JSON.parse(
      readFileSync(join(dir, "receipts", `${longEvent.event_id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({ delivery: "partial", confirmed_chunks: 1 });
  });
});
