#!/usr/bin/env bash
set -euo pipefail

repo_root=${TG_AXI_CHECKOUT:-$(git rev-parse --show-toplevel)}
revision=${TG_AXI_REVISION:-$(git -C "$repo_root" rev-parse HEAD)}
if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'TG_AXI_REVISION must be a full commit SHA\n' >&2
  exit 2
fi

runtime_root=/home/ubuntu/firstmate/.local/lib/tg-axi
runtime_dir="$runtime_root/$revision"
launcher=/home/ubuntu/firstmate/.local/bin/tg-axi
if [ -e "$runtime_dir" ]; then
  printf 'validated tg-axi runtime already exists: %s\n' "$runtime_dir" >&2
  exit 2
fi

corepack pnpm --dir "$repo_root" install --frozen-lockfile
corepack pnpm --dir "$repo_root" run build
install -d -m 0755 "$runtime_dir" "$runtime_root" "$(dirname "$launcher")"
cp -a "$repo_root/dist" "$runtime_dir/dist"
cp -a "$repo_root/docs" "$runtime_dir/docs"
cp -a "$repo_root/integrations" "$runtime_dir/integrations"
cp -a "$repo_root/skills" "$runtime_dir/skills"
install -m 0644 "$repo_root/package.json" "$repo_root/pnpm-lock.yaml" "$repo_root/README.md" "$repo_root/LICENSE" "$runtime_dir/"
corepack pnpm --dir "$runtime_dir" install --prod --frozen-lockfile --ignore-scripts

launcher_tmp="$launcher.$revision.tmp"
printf '#!/usr/bin/env bash\nexec /home/ubuntu/firstmate/.local/lib/tg-axi/%s/dist/bin/tg-axi.js "$@"\n' "$revision" > "$launcher_tmp"
install -m 0755 "$launcher_tmp" "$launcher"
rm -f "$launcher_tmp"
printf 'installed %s\n' "$runtime_dir"
