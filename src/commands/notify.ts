import { deliveryDir } from "../config.js";
import { assertNoRemainingArgs, hasFlag, takeBoolFlag, takeFlag } from "../args.js";
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

flags[3]:
  --event-file <path> (required), --delivery-dir <dir> (default ${deliveryDir()}),
  --retry (explicitly retry a non-confirmed receipt)
status:
  tg-axi notify status [--delivery-dir <dir>]
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
    ["--event-file", "--delivery-dir", "--retry"],
    `notify${status ? " status" : ""}`,
  );
  const hasDeliveryDir =
    hasFlag(args, "--delivery-dir") || args.some((arg) => arg.startsWith("--delivery-dir="));
  const dir = takeFlag(args, "--delivery-dir");
  if (hasDeliveryDir && (!dir || dir.startsWith("--"))) {
    throw new AxiError("--delivery-dir requires a directory path", "VALIDATION_ERROR");
  }
  const resolvedDir = dir ?? deliveryDir();
  const eventFile = status ? undefined : takeFlag(args, "--event-file");
  const retry = takeBoolFlag(args, "--retry");
  if (status && (eventFile !== undefined || retry)) {
    throw new AxiError("notify status accepts only --delivery-dir", "VALIDATION_ERROR");
  }
  assertNoRemainingArgs(args, `notify${status ? " status" : ""}`);

  if (status) {
    const output = {
      ...readDeliverySummary(resolvedDir),
      help: ["Run `tg-axi notify --event-file <path>` at a verified Firstmate outcome"],
    };
    return output;
  }

  if (!eventFile || eventFile.startsWith("--")) {
    throw new AxiError("--event-file <path> is required", "VALIDATION_ERROR", [
      "Run `tg-axi notify --event-file ./event.json`",
    ]);
  }
  assertNoRemainingArgs(args, "notify");
  const event = readNotificationEvent(eventFile);
  const result = await deliverNotification(event, requireToken(ctx), resolvedDir, { retry });
  const output = resultOutput(result);
  return output;
}
