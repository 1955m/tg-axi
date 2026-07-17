import {
  DEFAULT_RECEIVE_TIMEOUT,
  DEFAULT_UPDATES_LIMIT,
  MAX_LONG_POLL_TIMEOUT,
  MAX_UPDATES_LIMIT,
  inboxDir,
  offsetFilePath,
} from "../config.js";
import { deleteWebhook } from "../tg.js";
import { hasFlag, parseLimitFlag, parseTimeoutFlag, takeBoolFlag, takeFlag } from "../args.js";
import { rejectUnknownFlags, requireToken, type TgContext } from "../context.js";
import { loadAllowList } from "../access.js";
import { buildReceiveOutput, drainUpdates, type ReceiveOptions } from "../receive.js";

export const RECEIVE_HELP = `usage: tg-axi receive [flags]
One-shot drain: call getUpdates with the persisted offset, normalize all new
messages (text/voice/audio/photo/video/video_note/document/animation/sticker/
location/contact), download media into the inbox, then persist the new offset so
the next call is resumable + idempotent. Re-running from a persisted offset never
re-fetches already-acked updates. A 409 means another poller/webhook is active.

flags[7]:
  --limit <1-100> (default ${DEFAULT_UPDATES_LIMIT}), --timeout <0-50s> (default ${DEFAULT_RECEIVE_TIMEOUT}, long-poll),
  --json (machine-readable output), --drop-pending-webhook (deleteWebhook then drain),
  --inbox <dir> (default ${inboxDir()}), --offset-file <path> (default ${offsetFilePath()}),
  --no-download (skip file writes, keep metadata)
auth/allowlist:
  token: runtime-loaded; allowlist: ~/.claude/channels/telegram/access.json (allowFrom) > TG_ALLOW_FROM env > default chat
examples:
  tg-axi receive
  tg-axi receive --limit 10 --timeout 30 --json
  tg-axi receive --drop-pending-webhook
`;

export async function receiveCommand(
  args: string[],
  ctx: TgContext,
): Promise<Record<string, unknown> | string> {
  if (args[0] === "--help") return RECEIVE_HELP;
  rejectUnknownFlags(
    args,
    [
      "--limit",
      "--timeout",
      "--json",
      "--drop-pending-webhook",
      "--inbox",
      "--offset-file",
      "--no-download",
    ],
    "receive",
  );
  const apiCtx = requireToken(ctx);

  const json = hasFlag(args, "--json");
  const noDownload = takeBoolFlag(args, "--no-download");
  const dropWebhook = hasFlag(args, "--drop-pending-webhook");
  const inboxOverride = takeFlag(args, "--inbox");
  const offsetOverride = takeFlag(args, "--offset-file");
  const limit = parseLimitFlag(args, "receive", DEFAULT_UPDATES_LIMIT, MAX_UPDATES_LIMIT);
  const timeout = parseTimeoutFlag(args, "receive", DEFAULT_RECEIVE_TIMEOUT, MAX_LONG_POLL_TIMEOUT);

  const allow = loadAllowList();
  const opts: ReceiveOptions = {
    allow,
    inboxDir: inboxOverride ?? inboxDir(),
    offsetFile: offsetOverride ?? offsetFilePath(),
    limit: limit ?? DEFAULT_UPDATES_LIMIT,
    timeout: timeout ?? DEFAULT_RECEIVE_TIMEOUT,
    noDownload,
  };

  let webhook: string | undefined;
  if (dropWebhook) {
    await deleteWebhook(apiCtx);
    webhook = "deleted";
  }

  const result = await drainUpdates(apiCtx, opts);
  const output = buildReceiveOutput(result, {
    allow: allow.source,
    inbox: opts.inboxDir,
    ...(webhook ? { webhook } : {}),
  });
  output["help"] = receiveHints();
  return json ? JSON.stringify(output, null, 2) : output;
}

function receiveHints(): string[] {
  return [
    "Run `tg-axi listen` for a continuous long-poll loop",
    "Run `tg-axi receive --json` for machine-readable output",
    "Run `tg-axi receive --drop-pending-webhook` if a 409 conflict occurs",
  ];
}
