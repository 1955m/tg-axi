# tg-axi

AXI-compliant Telegram CLI — durable out-of-band notifications **and** inbound message receive, for agents and daemons. Token-efficient TOON output, chunk-split sends above Telegram's 4096-char limit, Telegram-directed retry delays, and request timeouts. Outbound mirrors the `gh-axi` / `glab-axi` UX; inbound drains every Telegram message type, downloads media to an inbox, and persists a resumable + idempotent offset.

```sh
tg-axi                                       # session digest: bot, token-present, default chat, reachable
tg-axi status                                # getMe + getChat health check
echo -n "alert body" | tg-axi send --stdin   # deliver an alert (the daemon path)
tg-axi send --text-file ./digest.txt --title "wedge alarm" --priority high
tg-axi notify --event-file ./firstmate-event.json   # durable Firstmate outcome notification
tg-axi notify status                                 # local delivery counts; no network call
tg-axi receive --json --timeout 30           # drain pending messages (one-shot)
tg-axi listen                                 # continuous long-poll receive loop
tg-axi setup hooks                           # install Claude Code / Codex / OpenCode session hooks
```

## Why

This is the out-of-band alert channel for Firstmate's verified outcomes and away-mode wedge alarm. Firstmate owns event meaning and the Traditional Chinese wording; `tg-axi notify` owns private event/receipt durability, Telegram transport, and replay dedupe. `tg-axi send --stdin` remains the simple alert path for arbitrary digests. Both paths report success/failure clearly, distinguish definite failure from uncertain delivery, and make no exactly-once promise.

## Install

```sh
# The package is private and is not published. Build/install from a validated checkout:
TG_AXI_CHECKOUT="$(pwd)" integrations/firstmate/install-runtime.sh
# or run on demand from the checkout:
corepack pnpm dev <command>
```

The installer retains the exact revision with production dependencies outside
the checkout and points `/home/ubuntu/firstmate/.local/bin/tg-axi` at it. A
rerun resumes launcher publication if interruption occurs after the runtime is
published.

Requires a Telegram bot token in `~/.claude/channels/telegram/.env` (the `TELEGRAM_BOT_TOKEN=` line) or the `TELEGRAM_BOT_TOKEN` env var. The token is read at runtime and never committed.

## Commands

```
(none)=session, send, notify, status, receive, listen, setup
```

| Command         | Flags                                                                                                                                | Notes                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `send`          | `--chat`, `--title`, `--priority high\|low`, `--text-file <path>`, `--stdin`                                                         | chunk-split at 4096; 429 retry; exactly one of `--text-file`/`--stdin` required |
| `notify`        | `--event-file <path>`, `--delivery-dir <dir>`, `--retry`                                                                             | Firstmate event; persists private receipt; confirmed replay is deduplicated     |
| `notify status` | `--delivery-dir <dir>`                                                                                                               | local delivery counts only; never contacts Telegram                             |
| `status`        | `--chat`                                                                                                                             | getMe + getChat health check                                                    |
| `receive`       | `--limit <1-100>`, `--timeout <0-50s>`, `--json`, `--drop-pending-webhook`, `--inbox <dir>`, `--offset-file <path>`, `--no-download` | one-shot drain; persist offset; normalize + download every message type         |
| `listen`        | `--limit`, `--timeout`, `--inbox`, `--offset-file <path>`, `--no-download`, `--json`                                                 | continuous long-poll loop; clean SIGINT/SIGTERM shutdown                        |
| `setup hooks`   | —                                                                                                                                    | install/repair Claude Code, Codex, OpenCode `SessionStart` hooks                |
| `(none)`        | `--chat`                                                                                                                             | session digest (bot, token-present, default chat, reachable)                    |

Plus the SDK built-in `update` / `update --check`.

`--chat <id>` goes AFTER the command (default `123456789`); a leading `--chat` is rejected as `VALIDATION_ERROR`.

## Output

All output is [TOON](https://www.npmjs.com/package/@toon-format/toon)-encoded: `label:` key-value blocks for details and a trailing `help[N]:` block of runnable next-step hints. A successful `send` reports `sent: ok, chat, chunks, message_ids`. `notify` reports its event and private receipt paths; a confirmed replay reports `notification: deduplicated`. Errors render as `{ error, code, help[] }` with codes `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `VALIDATION_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, `UNKNOWN`.

## Firstmate notifications

Firstmate writes a versioned event JSON only after a verified review-ready,
completion, or blocker outcome. The event must contain a stable
`event_id`, a short Traditional Chinese `summary`, and one to three real HTTPS
links (usually an artifact or PR). Run the configured
`integrations/firstmate/tg-axi-notify.sh <config> <event>` wrapper. The event and
receipt are stored before sending under the private `TG_DELIVERY_DIR` location
(default `~/.claude/channels/telegram/delivery`). A confirmed event never sends
again on replay. A pending, failed, or unknown receipt requires an
explicit `--retry`; unknown network outcomes remain non-confirmed.

See [`docs/firstmate-integration.md`](docs/firstmate-integration.md) for the
install/configuration contract. It keeps credentials out of Firstmate config,
event files, and repository state.

## Priority

Telegram has no native "priority"; `--priority` maps to notification loudness: `low`/`silent` send silently (`disable_notification: true`), `high`/`normal` (default) send a loud notification.

## Receive (inbound)

`tg-axi receive` is a one-shot drain a poller/cron/shim calls; `tg-axi listen` is the continuous foreground daemon. Both share one core: `getUpdates` with the persisted offset → normalize every message → download media → advance the offset.

- **Offset store:** the last-acked `update_id` is persisted at `~/.claude/channels/telegram/offset` (overridable: `TG_OFFSET_FILE` env / `--offset-file`). `receive` writes `last_update_id + 1` after a successful drain; the next call fetches from there, so it **never re-fetches already-acked updates** (idempotent in the steady state; only a mid-batch crash can reprocess the in-flight batch — every Bot library has this at-least-once window). Atomic write (temp + rename).
- **All message types** are normalized to a flat record with `update_id`, `message_id`, `chat_id`, `from_id`/`from_username`/`from_name`, `date` (epoch), `type`, plus type-specific fields: `text`, `voice`/`audio`/`video`/`video_note`/`animation` (`duration`, `mime`, `performer`, `title`), `photo` (largest size picked), `document` (`name` + `mime`), `sticker` (`emoji`, `set_name`), `location` (`longitude`/`latitude`), `contact` (`phone`, …), and `caption` on media. Unknown update kinds (e.g. `callback_query`) still emit `type="unsupported"` with the raw subtype — never crash.
- **Media download:** every media type calls `getFile` then downloads `https://api.telegram.org/file/bot<token>/<file_path>` into the inbox (default `~/.claude/channels/telegram/inbox/`, overridable: `TG_INBOX_DIR` / `--inbox`). The record carries `file` (local path), `mime`, `size`, `name`, `file_id`, and `downloaded`. `getFile` only serves files up to **20MB**; a larger file does **not** crash — the record still emits the file metadata with `downloaded: false` + a `reason`, so nothing is silently lost.
- **Allowlist:** `~/.claude/channels/telegram/access.json` (`{ "allowFrom": ["<chat id>", ...] }`) is honored; priority is access.json > `TG_ALLOW_FROM` env > the default chat. Messages from non-allowed senders are recorded as `type="rejected"` and **never acted on** (no media download) but still acked. Access is never widened silently.
- **Single-consumer safety:** Telegram allows only ONE `getUpdates` consumer per bot token, and an active webhook blocks `getUpdates` entirely — both surface as `409 Conflict`. tg-axi raises a clear `VALIDATION_ERROR` telling the operator another poller/webhook is active. `tg-axi receive --drop-pending-webhook` (calls `deleteWebhook`) is the explicit, documented opt-in to remove a webhook; tg-axi **never** deletes a webhook implicitly.
- **Output:** each drained batch is TOON by default (`received`, `offset`, `messages[]`, plus `rejected[]`/`unsupported[]` when present); `receive`'s reply additionally carries an audit `allow`/`inbox`/`webhook`, while `listen` streams one such batch per line and prints a `listen: stopped` summary (`batches`/`messages`/`rejected`/`unsupported`/`offset`) on shutdown. `--json` switches to JSON.

## Develop

```sh
pnpm install
pnpm build            # tsc -> dist/
pnpm test             # vitest (unit + in-process integration; fully offline)
pnpm lint             # eslint --max-warnings=0
pnpm format           # prettier --write .
pnpm format:check     # prettier --check .
pnpm build:skill      # regenerate skills/tg-axi/SKILL.md from source
pnpm docs:check       # build:skill + git diff --exit-code -- skills/ (generated-skill staleness guard)
pnpm dev <args>       # run via tsx without building
```

> The root workspace gates `pnpm -r` on a deps-status check that re-runs install and trips on the `esbuild` ignored-build policy. To run a single package's scripts directly, use the local bins: `node_modules/.bin/tsc -p tsconfig.json`, `node_modules/.bin/vitest run`, `node_modules/.bin/eslint . --max-warnings=0` from the package dir.

## Architecture

Built on the published [`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js) (`runAxiCli` routing/help, `AxiError`, the `update` built-in, SessionStart hooks) and [`@toon-format/toon`](https://www.npmjs.com/package/@toon-format/toon). The file layout mirrors `gh-axi`/`glab-axi`:

```
bin/tg-axi.ts          entrypoint
src/cli.ts             runAxiCli wiring, TOP_HELP, --skill, context (token+chat) resolution
src/config.ts          DEFAULT_CHAT, API_BASE, TG_TEXT_LIMIT, runtime token loading + offset/inbox/access/delivery path resolvers
src/context.ts         TgContext, --chat resolution, requireToken()
src/tg.ts              Telegram Bot API client (tgRequest with timeout+429 retry+AbortSignal, sendChunks, chunkMessage, getUpdates, getFile, deleteWebhook, downloadTgFile)
src/errors.ts          mapTgApiError -> AxiError codes (409 conflict → webhook/poller guidance)
src/toon.ts            field extractors + renderList/renderDetail/renderHelp
src/offset.ts          atomic last-acked update_id store (readOffset/writeOffset)
src/access.ts          allowlist load (access.json > TG_ALLOW_FROM > default) + isAllowed
src/receive.ts         inbound core: normalizeUpdate (all message types) + drainUpdates + listenUpdates + media download
src/skill.ts           createSkillMarkdown()
src/commands/*.ts      home, send, notify, status, receive, listen, setup
src/delivery.ts        durable notification event/receipt storage and delivery
skills/tg-axi/SKILL.md shipped skill file for agent harness auto-loading
```

The key structural difference from `glab-axi`: there is no vendor CLI to wrap, so `src/tg.ts` is an HTTP client (global `fetch` + `AbortController`) rather than an `execFile` wrapper.

License: MIT.
