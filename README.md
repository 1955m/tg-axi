# tg-axi

AXI-compliant Telegram CLI — out-of-band alert delivery for agents and daemons. Token-efficient TOON output, chunk-split sends above Telegram's 4096-char limit, 429 retry with backoff, and request timeouts. Mirrors the `gh-axi` / `glab-axi` UX.

```sh
tg-axi                                       # session digest: bot, token-present, default chat, reachable
tg-axi status                                # getMe + getChat health check
echo -n "alert body" | tg-axi send --stdin   # deliver an alert (the daemon path)
tg-axi send --text-file ./digest.txt --title "wedge alarm" --priority high
```

## Why

This is the out-of-band alert channel for firstmate's away-mode wedge alarm: the daemon pipes the full escalation digest to `tg-axi send --stdin`, so `send` must reliably deliver a possibly-long multi-line message and report success/failure clearly. `tg-axi` wraps the Telegram Bot API into the compact, agent-ergonomic shape `gh-axi` established: a no-args session digest, TOON-encoded output, contextual `help[N]:` hints, structured `AxiError` codes, chunk-splitting at 4096, 429 backoff, AbortController timeouts, and a `--skill` generator.

## Install

```sh
npm install -g tg-axi        # when published
# or run on demand:
npx -y tg-axi <command>
```

Requires a Telegram bot token in `~/.claude/channels/telegram/.env` (the `TELEGRAM_BOT_TOKEN=` line) or the `TELEGRAM_BOT_TOKEN` env var. The token is read at runtime and never committed.

## Commands

```
(none)=session, send, status
```

| Command | Flags | Notes |
| --- | --- | --- |
| `send` | `--chat`, `--title`, `--priority high\|low`, `--text-file <path>`, `--stdin` | chunk-split at 4096; 429 retry; exactly one of `--text-file`/`--stdin` required |
| `status` | `--chat` | getMe + getChat health check |
| `(none)` | `--chat` | session digest (bot, token-present, default chat, reachable) |

Plus the SDK built-in `update` / `update --check`.

`--chat <id>` goes AFTER the command (default `123456789`); a leading `--chat` is rejected as `VALIDATION_ERROR`.

## Output

All output is [TOON](https://www.npmjs.com/package/@toon-format/toon)-encoded: `label:` key-value blocks for details and a trailing `help[N]:` block of runnable next-step hints. A successful `send` reports `sent: ok, chat, chunks, message_ids`. Errors render as `{ error, code, help[] }` with codes `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`, `VALIDATION_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, `UNKNOWN`.

## Priority

Telegram has no native "priority"; `--priority` maps to notification loudness: `low`/`silent` send silently (`disable_notification: true`), `high`/`normal` (default) send a loud notification.

## Develop

```sh
pnpm install
pnpm build            # tsc -> dist/
pnpm test             # vitest (unit + in-process integration; fully offline)
pnpm lint             # eslint --max-warnings=0
pnpm build:skill      # regenerate skills/tg-axi/SKILL.md from source
pnpm dev <args>       # run via tsx without building
```

> The root workspace gates `pnpm -r` on a deps-status check that re-runs install and trips on the `esbuild` ignored-build policy. To run a single package's scripts directly, use the local bins: `node_modules/.bin/tsc -p tsconfig.json`, `node_modules/.bin/vitest run`, `node_modules/.bin/eslint . --max-warnings=0` from the package dir.

## Architecture

Built on the published [`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js) (`runAxiCli` routing/help, `AxiError`, the `update` built-in, SessionStart hooks) and [`@toon-format/toon`](https://www.npmjs.com/package/@toon-format/toon). The file layout mirrors `gh-axi`/`glab-axi`:

```
bin/tg-axi.ts          entrypoint
src/cli.ts             runAxiCli wiring, TOP_HELP, --skill, context (token+chat) resolution
src/config.ts          DEFAULT_CHAT, API_BASE, TG_TEXT_LIMIT, runtime token loading
src/context.ts         TgContext, --chat resolution, requireToken()
src/tg.ts              Telegram Bot API client (tgRequest with timeout+429 retry, sendChunks, chunkMessage)
src/errors.ts          mapTgApiError -> AxiError codes
src/toon.ts            field extractors + renderList/renderDetail/renderHelp
src/skill.ts           createSkillMarkdown()
src/commands/*.ts      home, send, status
skills/tg-axi/SKILL.md shipped skill file for agent harness auto-loading
```

The key structural difference from `glab-axi`: there is no vendor CLI to wrap, so `src/tg.ts` is an HTTP client (global `fetch` + `AbortController`) rather than an `execFile` wrapper.

See `NOTES.md` for the build-decision rationale and live validation evidence (a real test message delivered to chat `123456789`, including chunk-splitting above 4096).

License: MIT.
