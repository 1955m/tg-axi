# Firstmate outbound notification integration

This repository provides a deliberately narrow Firstmate boundary:
`integrations/firstmate/tg-axi-notify.sh` accepts a home-local JSON
configuration and one event JSON file, then executes the configured `tg-axi
notify` command. Firstmate remains responsible for
deciding that an outcome is verified, writing the short Traditional Chinese
summary, and supplying the real HTTPS artifact or pull-request link. The
wrapper does not watch arbitrary chat text or infer work state.

## Build and install from a validated revision

From the exact validated tg-axi checkout:

```sh
TG_AXI_CHECKOUT="$(pwd)" integrations/firstmate/install-runtime.sh
install -m 0755 integrations/firstmate/tg-axi-notify.sh /home/ubuntu/firstmate/.local/bin/tg-axi-notify
```

The notification path requires Linux `flock` locking; unsupported runtimes
fail validation without affecting inbound receive or listen.

Keep the package private; do not publish it. The Telegram token remains in the
runtime location `~/.claude/channels/telegram/.env` as
`TELEGRAM_BOT_TOKEN=...`, or in the process environment. Never put it in
Firstmate's tracked config or in an event file.

Run `TG_AXI_CHECKOUT="$(pwd)" integrations/firstmate/install-runtime.sh` to
retain the validated revision and its production dependencies outside the
checkout; rerunning resumes launcher publication if interruption occurs after
the runtime is published. Create `/home/ubuntu/firstmate/.config/tg-axi` mode 0700, copy
`integrations/firstmate/telegram.json.example` there as `telegram.json` mode
0600, and replace the private chat id. It is the enabled configuration
consumed by the wrapper and points at the retained launcher. It contains the absolute validated binary, private
chat id, token file path, and private delivery directory. The delivery
directory and its records are created mode 0700/0600 by tg-axi and are safe to
inspect after restart.

## Event contract

Firstmate should call the wrapper only at a verified `review_ready`,
`completion`, or `blocker` outcome. A stable `event_id` must be
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
  "links": [{ "label": "PR", "url": "https://github.com/1955m/tg-axi/pull/123" }]
}
```

The rendered message is short and Traditional Chinese, with the HTTPS links
on following lines. `tg-axi` writes the event and a pending receipt before the
API call. A confirmed replay returns `notification: deduplicated` and makes no
Telegram request. A definite failure or uncertain network
outcome leaves a non-confirmed receipt and a non-zero exit; it never becomes a
false success and is not retried implicitly. Inspect local state with:

```sh
/home/ubuntu/firstmate/.local/bin/tg-axi notify status --delivery-dir /home/ubuntu/firstmate/state/telegram/delivery
```

Only an explicit operator or Firstmate retry policy should repeat a
non-confirmed event with `--retry`. Telegram delivery is at-least-once around
unknown network outcomes; this interface makes no exactly-once promise.

At each verified completion, review-ready, or blocker outcome, primary should
write the event file and call:

```sh
/home/ubuntu/firstmate/.local/bin/tg-axi-notify \
  /home/ubuntu/firstmate/.config/tg-axi/telegram.json ./event.json
```

The same explicit call is the supported wedge-alarm hook: primary creates a
blocker event from its existing wedge-alarm outcome and records a failed exit
as an outstanding notification obligation. No watcher or chat-text inference
is involved. This repo stages the installable caller and config; it does not
modify live Firstmate source, config, credentials, services, or hooks.

After an explicit inspection of a non-confirmed receipt, repeat the same call
with `--retry`; the wrapper forwards that explicit decision to the retained
runtime and still selects the configured bot and delivery directory.
