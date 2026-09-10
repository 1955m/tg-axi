#!/usr/bin/env bash
# Firstmate's narrow outbound boundary: one already-validated event file in,
# one tg-axi notification result out. This script never parses chat text.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  printf 'usage: tg-axi-notify <event.json>\n' >&2
  exit 2
fi

event_file=$1
if [ ! -f "$event_file" ] || [ -L "$event_file" ]; then
  printf 'event file must be a regular file: %s\n' "$event_file" >&2
  exit 2
fi

tg_bin=${FM_TELEGRAM_AXI_BIN:-tg-axi}
delivery_dir=${FM_TELEGRAM_DELIVERY_DIR:-}
chat_id=${FM_TELEGRAM_CHAT_ID:-}
args=(notify --event-file "$event_file")
if [ -n "$delivery_dir" ]; then
  args+=(--delivery-dir "$delivery_dir")
fi
if [ -n "$chat_id" ]; then
  args+=(--chat "$chat_id")
fi

# Telegram credentials stay in tg-axi's runtime token environment/file. A
# non-zero result is intentionally preserved so Firstmate cannot record a
# notification obligation as successful after a definite or uncertain send.
exec "$tg_bin" "${args[@]}"
