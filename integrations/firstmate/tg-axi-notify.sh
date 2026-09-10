#!/usr/bin/env bash
# Firstmate's narrow outbound boundary: one already-validated event file in,
# one tg-axi notification result out. This script never parses chat text.
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  printf 'usage: tg-axi-notify <telegram.json> <event.json> [--retry]\n' >&2
  exit 2
fi

config_file=$1
event_file=$2
retry_flag=${3:-}
if [ -n "$retry_flag" ] && [ "$retry_flag" != "--retry" ]; then
  printf 'only --retry is accepted as an optional third argument\n' >&2
  exit 2
fi
if [ ! -f "$config_file" ] || [ -L "$config_file" ]; then
  printf 'configuration must be a regular file: %s\n' "$config_file" >&2
  exit 2
fi
if [ ! -f "$event_file" ] || [ -L "$event_file" ]; then
  printf 'event file must be a regular file: %s\n' "$event_file" >&2
  exit 2
fi

config_values=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.argv[1], "utf8"));
const fields = ["enabled", "binary", "chat_id", "token_file", "delivery_dir"];
if (config.enabled !== true || fields.slice(1).some((field) => typeof config[field] !== "string" || config[field].length === 0)) process.exit(2);
if (fields.slice(1).some((field) => /[\t\r\n]/.test(config[field]))) process.exit(2);
process.stdout.write(fields.map((field) => String(config[field])).join("\t"));
' "$config_file") || {
  printf 'invalid enabled Telegram configuration: %s\n' "$config_file" >&2
  exit 2
}
IFS=$'\t' read -r enabled tg_bin chat_id token_file delivery_dir <<< "$config_values"
if [ "$enabled" != true ] || [[ "$tg_bin" != /* ]] || [ ! -x "$tg_bin" ] || [ ! -f "$token_file" ] || [ ! -r "$token_file" ] || [[ ! "$delivery_dir" = /* ]] || [[ ! "$chat_id" =~ ^-?[0-9]+$ ]]; then
  printf 'configuration must specify an enabled absolute executable, numeric private chat, readable token file, and absolute delivery directory\n' >&2
  exit 2
fi

unset TELEGRAM_BOT_TOKEN
export TG_TOKEN_FILE="$token_file"
args=(notify --event-file "$event_file" --delivery-dir "$delivery_dir" --chat "$chat_id")
if [ -n "$retry_flag" ]; then
  args+=(--retry)
fi
exec "$tg_bin" "${args[@]}"
