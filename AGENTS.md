# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Build / test / lint

- `pnpm install` then local bins (no workspace gating from this dir): `node_modules/.bin/tsc -p tsconfig.json`, `node_modules/.bin/vitest run`, `node_modules/.bin/eslint . --max-warnings=0`, `node_modules/.bin/prettier --check .`.
- `tsc` is `strict` + `noUnusedLocals`/`noUnusedParameters` — every imported symbol must be referenced by name; re-exporting a symbol just to "use" an import is an anti-pattern (import from each symbol's home module instead).
- TS `module: node16` → relative imports MUST use the `.js` extension (e.g. `./context.js`) even for `.ts` files.
- Tests are colocated `*.test.ts`, fully offline: they stub `globalThis.fetch` (never the network) and point `TG_TOKEN_FILE` at a nonexistent path so the real `~/.claude/channels/telegram/.env` token is never read.
- CI gate (`.github/workflows/ci.yml`) order on Node 24 mirrors kunchenguid/axi CONTRIBUTING: `pnpm install --frozen-lockfile` → `format:check` → `lint` → `build` → `test` → `build:skill` → `git diff --exit-code -- skills/`. The last two steps are the generated-skill staleness guard (AXI P7).
- `skills/tg-axi/SKILL.md` is GENERATED from `src/skill.ts` (`createSkillMarkdown()`); never hand-edit it. After editing `skill.ts` or `cli.ts` TOP_HELP/DESCRIPTION, run `pnpm run build:skill` (or `pnpm run docs:check`) and commit the regenerated SKILL.md, or the `git diff --exit-code -- skills/` step fails.

## Release

- release-please (`release-please-config.json` + `.release-please-manifest.json` + `.github/workflows/release-please.yml`) drives versioned releases + `CHANGELOG.md` from conventional-commit messages (`feat:`/`fix:`/`chore:`). The manifest pins the root version (currently `0.1.0`); release-please opens a release PR on push to `main` that bumps `package.json` + the manifest. `package.json` stays `private: true` (npm publishing is a separate captain-gated decision), so release-please only cuts tags + changelogs.

## AXI principle compliance

- **P6 (fail loud on unknown flags):** `rejectUnknownFlags(args, known, commandPath)` in `context.ts` runs at the top of each command (after the `--help` short-circuit, before any dependency call like `requireToken`). An unrecognized `--flag` throws `VALIDATION_ERROR` naming the flag + listing the command's valid flags; `--chat`/`--help` are always-allowed globals. Each command declares its own known-flag set; `--json` is per-command (receive/listen only), not global.
- **P7 (ambient context):** `tg-axi setup hooks` (`commands/setup.ts`) calls the SDK's `installSessionStartHooks()` to install Claude Code / Codex / OpenCode `SessionStart` hooks (idempotent, explicit opt-in only — never run from an ordinary command). The generated SKILL.md is the secondary discovery path; the staleness gate above keeps it in sync.

## SDK contract (axi-sdk-js)

- `runAxiCli` dispatches command-first; commands return `AxiRenderable = string | Record<string, unknown>` — a plain object is TOON-serialized by the runtime (`@toon-format/toon` `encode`), a string passes through. `tg-axi` outbound commands return pre-rendered strings; of the inbound commands, only `receive` returns a plain object (the SDK-native idiom). `listen` self-renders instead: it streams each drained batch straight to stdout via `process.stdout.write` (bypassing the runtime renderer entirely) and returns just a pre-rendered `listen: stopped` summary string on shutdown. `--json` returns a `JSON.stringify` string (also pass-through).
- A top-level `help: string[]` key in a returned object renders as an inline `help[N]:` block; the existing outbound commands use the multi-line `renderHelp` form instead. Both are valid TOON.
- Thrown `AxiError` → SDK renders `{ error, code, help[] }`. `exitCodeForError`: only `VALIDATION_ERROR` exits 2; all else exit 1. tg-axi's 409 → `VALIDATION_ERROR` (consistent with the documented code set).

## Inbound receive (receive.ts / commands/receive, listen)

- The offset store (`~/.claude/channels/telegram/offset`, `TG_OFFSET_FILE` / `--offset-file`) holds `last_update_id + 1`; `receive`/`listen` write it after a successful drain. Re-running from a persisted offset never re-fetches acked updates (idempotent in the steady state; only a mid-batch crash reprocesses the in-flight batch).
- Allowlist: `access.json` (`allowFrom`) > `TG_ALLOW_FROM` env > `[DEFAULT_CHAT]`. Non-allowed senders → `type="rejected"` record, NO media download, but still acked.
- Media: `getFile` then `downloadTgFile` (`/file/bot<token>/<file_path>`) into the inbox (`TG_INBOX_DIR` / `--inbox`). `getFile` serves ≤20MB only; larger/failed downloads emit `downloaded:false` + `reason` + metadata — never crash.
- `409 Conflict` (other poller OR active webhook) → `VALIDATION_ERROR` with clear guidance; `--drop-pending-webhook` calls `deleteWebhook` (the ONLY place tg-axi removes a webhook — never implicit).
- `TgRequestOptions.signal` (external `AbortSignal`) threads through `tgFetch` + `downloadTgFile`; `listen` uses it for prompt SIGINT/SIGTERM shutdown (abort the in-flight long-poll, exit after the current batch). The outbound `send` path passes no signal → unaffected.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
