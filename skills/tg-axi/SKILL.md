---
name: tg-axi
description: "Control a Telegram bot channel through the tg-axi CLI - outbound alert delivery and inbound message receive. Use whenever a task needs to deliver a Telegram alert or notification (piping a multi-line escalation digest, sending a file-backed message), receive inbound messages of every type (text/voice/audio/photo/video/document/sticker/location/contact with media downloaded to an inbox), run a continuous receive loop, or check bot/chat reachability. Outbound messages are chunk-split at Telegram's 4096-char limit and retried on 429; inbound drains are resumable + idempotent via a persisted offset, and a 409 conflict is surfaced clearly (another poller or a webhook is active)."
user-invocable: false
author: AXI Suite
metadata:
  hermes:
    tags: [telegram, alerts, notifications, messaging, receive]
    category: comms
---

# tg-axi

Agent ergonomic interface for Telegram — out-of-band alert delivery and inbound message receive. Prefer this for Telegram channel control.

You do not need tg-axi installed globally - invoke it with `npx -y tg-axi <command>`.
If tg-axi output shows a follow-up command starting with `tg-axi`, run it as `npx -y tg-axi ...` instead.

tg-axi reads the Telegram bot token at runtime from `~/.claude/channels/telegram/.env` (the `TELEGRAM_BOT_TOKEN` line) or the `TELEGRAM_BOT_TOKEN` env var. The token is never logged or committed.

## When to use

Use tg-axi whenever a task needs to control a Telegram bot channel: deliver an outbound alert or notification (piping a multi-line escalation digest via stdin, sending a file-backed message), receive inbound messages of every type, run a continuous receive loop, check bot/chat reachability, or get the session digest (bot username, token-present, default chat, reachable).

## Workflow

### Outbound (send alerts)
1. Run `npx -y tg-axi` with no arguments for a session digest - bot username, token-present, default chat, and reachable status.
2. Check health with `npx -y tg-axi status` - runs getMe and getChat against the default chat.
3. Deliver an alert by piping text via stdin: `echo -n "alert body" | npx -y tg-axi send --stdin`.
4. Add a title and priority: `npx -y tg-axi send --text-file ./digest.txt --title "wedge alarm" --priority high`.
5. Target another chat by placing `--chat <id>` AFTER the command: `npx -y tg-axi send --chat 123456789 --stdin`.
6. Messages longer than 4096 chars are split into multiple sendMessage calls automatically; 429s are retried with backoff.

### Inbound (receive)
7. Drain one batch of pending messages: `npx -y tg-axi receive`. All message types are normalized (text/voice/audio/photo/video/video_note/document/animation/sticker/location/contact); media is downloaded to `~/.claude/channels/telegram/inbox/` via getFile then the /file/bot<token>/ endpoint. The offset is persisted so the next `receive` is resumable + idempotent (never re-fetches already-acked updates).
8. Long-poll a batch: `npx -y tg-axi receive --timeout 30 --json` (`--json` for machine-readable output).
9. Run a continuous foreground receive loop: `npx -y tg-axi listen` (clean shutdown on SIGINT/SIGTERM; 409/auth propagate, transient blips retry with backoff).
10. If a 409 conflict occurs (another poller or an active webhook blocks getUpdates), run `npx -y tg-axi receive --drop-pending-webhook` (calls deleteWebhook) then drain. This is the only way tg-axi removes a webhook - it never deletes one implicitly.
11. The allowlist lives in `~/.claude/channels/telegram/access.json` (`{ "allowFrom": ["<chat id>", ...] }`); messages from non-allowed senders are recorded as type="rejected" and never acted on (no media download). Default is the default chat only; access is never widened silently.
12. Every response ends with contextual next-step hints under `help:` - follow them.

## Commands

```
commands[5]:
  (none)=session, send, status, receive, listen
```

Installed copies also inherit the SDK built-in `update` command.
Run `tg-axi update --check` to compare the installed version with npm, or `tg-axi update` to upgrade.
When using `npx -y tg-axi`, npx already resolves the package on demand.

Run `npx -y tg-axi --help` for global flags, or `npx -y tg-axi <command> --help` for per-command usage.

## Tips

- The primary alert path is `--stdin`: pipe the full escalation digest so nothing is truncated or quoted in argv.
- `--text-file <path>` reads message text from a UTF-8 file (use for large digests).
- `--priority low` sends silently (disable_notification); `--priority high` (default) sends a loud notification.
- Outbound output is TOON-encoded and token-efficient: `sent: ok, chat, chunks, message_ids` on success.
- Inbound: `tg-axi receive` returns `received`/ `offset` + a `messages[]` (and `rejected[]`/`unsupported[]` when present). `--json` switches to JSON.
- Media >20MB cannot be served by getFile; those records still emit with `downloaded: false` + a `reason` + file metadata - nothing is silently lost.
- The bot token lives in `~/.claude/channels/telegram/.env`; if missing, commands report `code: AUTH_REQUIRED`.

