import { deliveryDir } from "../config.js";
import { assertNoRemainingArgs, takeBoolFlag, takeFlag } from "../args.js";
import { rejectUnknownFlags, requireToken, type TgContext } from "../context.js";
import { AxiError } from "../errors.js";
import {
  deliverNotification,
  readDeliverySummary,
  readNotificationEvent,
  type NotificationResult,
} from "../delivery.js";

export const NOTIFY_HELP = `usage: tg-axi notify [flags]
Deliver one Firstmate-owned notification event with a short Traditional Chinese
summary and at least one HTTPS artifact or PR link. The event and delivery
receipt are persisted privately before sending. A confirmed event is replay-safe.

flags[4]:
  --event-file <path> (required), --delivery-dir <dir> (default ${deliveryDir()}),
  --retry (explicitly retry a non-confirmed receipt), --json
status:
  tg-axi notify status [--delivery-dir <dir>] [--json]
examples:
  tg-axi notify --event-file ./event.json
  tg-axi notify --event-file ./event.json --retry
  tg-axi notify status
`;

function resultOutput(result: NotificationResult): Record<string, unknown> {
  return {
    notification: result.deduplicated ? "deduplicated" : "delivered",
    event_id: result.event_id,
    delivery: result.delivery,
    chat: result.chat,
    chunks: result.chunks,
    confirmed_chunks: result.confirmed_chunks,
    message_ids: result.message_ids,
    event_file: result.event_file,
    receipt_file: result.receipt_file,
    help: [
      "Run `tg-axi notify status` for local delivery counts",
      "A non-confirmed receipt is never retried implicitly; inspect it before using --retry",
    ],
  };
}

export async function notifyCommand(
  args: string[],
  ctx: TgContext,
): Promise<string | Record<string, unknown>> {
  if (args[0] === "--help") return NOTIFY_HELP;
  const status = args[0] === "status";
  if (status) args.shift();
  rejectUnknownFlags(
    args,
    ["--event-file", "--delivery-dir", "--retry", "--json"],
    `notify${status ? " status" : ""}`,
  );
  const json = takeBoolFlag(args, "--json");
  const dir = takeFlag(args, "--delivery-dir") ?? deliveryDir();
  if (dir.startsWith("--")) {
    throw new AxiError("--delivery-dir requires a directory path", "VALIDATION_ERROR");
  }
  const eventFile = status ? undefined : takeFlag(args, "--event-file");
  const retry = takeBoolFlag(args, "--retry");
  if (status && (eventFile !== undefined || retry)) {
    throw new AxiError("notify status accepts only --delivery-dir and --json", "VALIDATION_ERROR");
  }
  assertNoRemainingArgs(args, `notify${status ? " status" : ""}`);

  if (status) {
    const output = {
      ...readDeliverySummary(dir),
      help: ["Run `tg-axi notify --event-file <path>` at a verified Firstmate outcome"],
    };
    return json ? JSON.stringify(output) : output;
  }

  if (!eventFile || eventFile.startsWith("--")) {
    throw new AxiError("--event-file <path> is required", "VALIDATION_ERROR", [
      "Run `tg-axi notify --event-file ./event.json`",
    ]);
  }
  assertNoRemainingArgs(args, "notify");
  const event = readNotificationEvent(eventFile);
  const result = await deliverNotification(event, requireToken(ctx), dir, { retry });
  const output = resultOutput(result);
  return json ? JSON.stringify(output) : output;
}
