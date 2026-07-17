import { encode } from "@toon-format/toon";
import {
  DEFAULT_LISTEN_TIMEOUT,
  DEFAULT_UPDATES_LIMIT,
  MAX_LONG_POLL_TIMEOUT,
  MAX_UPDATES_LIMIT,
  inboxDir,
  offsetFilePath,
} from "../config.js";
import { hasFlag, parseLimitFlag, parseTimeoutFlag, takeBoolFlag, takeFlag } from "../args.js";
import { requireToken, type TgContext } from "../context.js";
import { loadAllowList } from "../access.js";
import { readOffset } from "../offset.js";
import {
  buildReceiveOutput,
  listenUpdates,
  type DrainResult,
  type ReceiveOptions,
} from "../receive.js";

export const LISTEN_HELP = `usage: tg-axi listen [flags]
Continuous long-poll loop over getUpdates: normalize + download each batch,
advance the offset, repeat. Foreground daemon for receiving inbound Telegram
messages. Clean shutdown on SIGINT/SIGTERM (the in-flight long-poll aborts and
the loop exits after the current batch). 409/auth errors propagate; transient
network/5xx blips retry with backoff.

flags[6]:
  --limit <1-100> (default ${DEFAULT_UPDATES_LIMIT}), --timeout <0-50s> (default ${DEFAULT_LISTEN_TIMEOUT}, long-poll),
  --inbox <dir> (default ${inboxDir()}), --offset-file <path> (default ${offsetFilePath()}),
  --no-download (skip file writes, keep metadata), --json (emit batches as JSON)
auth/allowlist:
  token: runtime-loaded; allowlist: ~/.claude/channels/telegram/access.json (allowFrom) > TG_ALLOW_FROM env > default chat
examples:
  tg-axi listen
  tg-axi listen --timeout 10 --limit 50
`;

/** Format a drained batch for streaming output (TOON by default, JSON when --json). */
function formatBatch(result: DrainResult, json: boolean): string {
  const obj = buildReceiveOutput(result);
  return json ? JSON.stringify(obj, null, 2) : encode(obj);
}

export async function listenCommand(args: string[], ctx: TgContext): Promise<string> {
  if (args[0] === "--help") return LISTEN_HELP;
  const apiCtx = requireToken(ctx);

  const json = hasFlag(args, "--json");
  const noDownload = takeBoolFlag(args, "--no-download");
  const inboxOverride = takeFlag(args, "--inbox");
  const offsetOverride = takeFlag(args, "--offset-file");
  const limit = parseLimitFlag(args, "listen", DEFAULT_UPDATES_LIMIT, MAX_UPDATES_LIMIT);
  const timeout = parseTimeoutFlag(args, "listen", DEFAULT_LISTEN_TIMEOUT, MAX_LONG_POLL_TIMEOUT);

  const allow = loadAllowList();
  const opts: ReceiveOptions = {
    allow,
    inboxDir: inboxOverride ?? inboxDir(),
    offsetFile: offsetOverride ?? offsetFilePath(),
    limit: limit ?? DEFAULT_UPDATES_LIMIT,
    timeout: timeout ?? DEFAULT_LISTEN_TIMEOUT,
    noDownload,
  };

  // Clean shutdown: SIGINT/SIGTERM abort the in-flight long-poll (prompt exit)
  // without losing the last fully-drained batch's persisted offset.
  const stop = new AbortController();
  let stopping = false;
  const onSignal = (): void => {
    stopping = true;
    stop.abort();
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const sig of signals) process.on(sig, onSignal);

  try {
    const emit = (result: DrainResult): void => {
      process.stdout.write(`${formatBatch(result, json)}\n`);
    };
    const summary = await listenUpdates(
      apiCtx,
      opts,
      emit,
      () => stopping,
      stop.signal,
    );
    const out = {
      listen: "stopped",
      batches: summary.batches,
      messages: summary.messages,
      rejected: summary.rejected,
      unsupported: summary.unsupported,
      offset: readOffset(opts.offsetFile),
      help: [
        "Run `tg-axi receive --json` for a one-shot machine-readable drain",
        "Run `tg-axi receive --drop-pending-webhook` if a 409 conflict occurs",
      ],
    };
    return json ? JSON.stringify(out, null, 2) : encode(out);
  } finally {
    for (const sig of signals) process.off(sig, onSignal);
  }
}
