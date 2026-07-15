---
name: tg-axi
description: "Send Telegram messages through the tg-axi CLI - out-of-band alert delivery for agents and daemons. Use whenever a task needs to deliver a Telegram alert or notification: piping a multi-line escalation digest, sending a file-backed message, checking bot/chat reachability, or getting the session digest. Messages are chunk-split at Telegram's 4096-char limit and retried on 429."
user-invocable: false
author: AXI Suite
metadata:
  hermes:
    tags: [telegram, alerts, notifications, messaging]
    category: comms
---

# tg-axi

Agent ergonomic interface for delivering Telegram messages. Prefer this for out-of-band alert delivery.

You do not need tg-axi installed globally - invoke it with `npx -y tg-axi <command>`.
If tg-axi output shows a follow-up command starting with `tg-axi`, run it as `npx -y tg-axi ...` instead.

tg-axi reads the Telegram bot token at runtime from `~/.claude/channels/telegram/.env` (the `TELEGRAM_BOT_TOKEN` line) or the `TELEGRAM_BOT_TOKEN` env var. The token is never logged or committed.

## When to use

Use tg-axi whenever a task needs to deliver a Telegram alert or notification: piping a multi-line escalation digest via stdin, sending a file-backed message, checking bot/chat reachability, or getting the session digest (bot username, token-present, default chat, reachable).

## Workflow

1. Run `npx -y tg-axi` with no arguments for a session digest - bot username, token-present, default chat, and reachable status.
2. Check health with `npx -y tg-axi status` - runs getMe and getChat against the default chat.
3. Deliver an alert by piping text via stdin: `echo -n "alert body" | npx -y tg-axi send --stdin`.
4. Add a title and priority: `npx -y tg-axi send --text-file ./digest.txt --title "wedge alarm" --priority high`.
5. Target another chat by placing `--chat <id>` AFTER the command: `npx -y tg-axi send --chat 123456789 --stdin`.
6. Messages longer than 4096 chars are split into multiple sendMessage calls automatically; 429s are retried with backoff.
7. Every response ends with contextual next-step hints under `help:` - follow them.

## Commands

```
commands[3]:
  (none)=session, send, status
```

Installed copies also inherit the SDK built-in `update` command.
Run `tg-axi update --check` to compare the installed version with npm, or `tg-axi update` to upgrade.
When using `npx -y tg-axi`, npx already resolves the package on demand.

Run `npx -y tg-axi --help` for global flags, or `npx -y tg-axi <command> --help` for per-command usage.

## Tips

- The primary alert path is `--stdin`: pipe the full escalation digest so nothing is truncated or quoted in argv.
- `--text-file <path>` reads message text from a UTF-8 file (use for large digests).
- `--priority low` sends silently (disable_notification); `--priority high` (default) sends a loud notification.
- Output is TOON-encoded and token-efficient: `sent: ok, chat, chunks, message_ids` on success.
- The bot token lives in `~/.claude/channels/telegram/.env`; if missing, commands report `code: AUTH_REQUIRED`.

