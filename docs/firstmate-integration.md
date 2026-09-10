# Firstmate outbound notification integration

This repository provides a deliberately narrow Firstmate boundary:
`integrations/firstmate/tg-axi-notify.sh` accepts one event JSON file and
executes the pinned `tg-axi notify` command. Firstmate remains responsible for
deciding that an outcome is verified, writing the short Traditional Chinese
summary, and supplying the real HTTPS artifact or pull-request link. The
wrapper does not watch arbitrary chat text or infer work state.

## Build and install from a validated revision

From the exact validated tg-axi checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run build
install -m 0755 dist/bin/tg-axi.js /absolute/path/to/bin/tg-axi
install -m 0755 integrations/firstmate/tg-axi-notify.sh /absolute/path/to/bin/tg-axi-notify
```

Keep the package private; do not publish it. The Telegram token remains in the
runtime location `~/.claude/channels/telegram/.env` as
`TELEGRAM_BOT_TOKEN=...`, or in the process environment. Never put it in
Firstmate's tracked config or in an event file.

Use a private mode-0600 Firstmate configuration, based on
`integrations/firstmate/telegram.json.example`, with the absolute binary,
private chat id, and a private delivery directory. The wrapper reads these
values from `FM_TELEGRAM_AXI_BIN`, `FM_TELEGRAM_CHAT_ID`, and
`FM_TELEGRAM_DELIVERY_DIR`; the primary integration may export them from its
home-local config. The delivery directory and its records are created mode
0700/0600 by tg-axi and are safe to inspect after restart.

## Event contract

Firstmate should call the wrapper only at a verified `progress`,
`review_ready`, `completion`, or `blocker` outcome. A stable `event_id` must be
derived from the source event identity (for example kind + task + revision +
occurrence), so a replay has the same identity. Example:

```json
{
  "schema": "tg-axi/notification-event/v1",
  "event_id": "review_ready.task-42.r7",
  "kind": "review_ready",
  "owner": "primary",
  "task_id": "task-42",
  "revision": "r7",
  "occurred_at": "2026-09-10T12:00:00Z",
  "summary": "本輪修改已完成，請查看成果並回報意見。",
  "links": [{ "label": "PR", "url": "https://github.com/1955m/tg-axi/pull/123" }],
  "priority": "high"
}
```

The rendered message is short and Traditional Chinese, with the HTTPS links
on following lines. `tg-axi` writes the event and a pending receipt before the
API call. A confirmed replay returns `notification: deduplicated` and makes no
Telegram request. A definite failure, partial send, or uncertain network
outcome leaves a non-confirmed receipt and a non-zero exit; it never becomes a
false success and is not retried implicitly. Inspect local state with:

```sh
tg-axi notify status --delivery-dir /home/ubuntu/firstmate/state/telegram/delivery
```

Only an explicit operator or Firstmate retry policy should repeat a
non-confirmed event with `--retry`. Telegram delivery is at-least-once around
unknown network outcomes; this interface makes no exactly-once promise.

Primary should connect this wrapper to existing verified outcome interfaces
(completion, review-ready, blocker, and the supported wedge-alarm path) and
record a failed wrapper exit as an outstanding notification obligation. This
repo does not modify the live Firstmate source, config, credentials, services,
or hooks.
