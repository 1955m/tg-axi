#!/usr/bin/env bash
set -euo pipefail

repo_root=${TG_AXI_CHECKOUT:-$(git rev-parse --show-toplevel)}
revision=$(git -C "$repo_root" rev-parse HEAD)
if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'selected checkout HEAD must be a full commit SHA\n' >&2
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
install -d -m 0755 "$runtime_root" "$(dirname "$launcher")"
stage_dir="$runtime_root/.${revision}.$$.$RANDOM.staging"
launcher_tmp="$launcher.$revision.tmp"
launcher_stage="$launcher.$revision.staged"
cleanup() {
  rm -rf "$stage_dir" "$launcher_tmp" "$launcher_stage"
}
trap cleanup EXIT
if [ -e "$stage_dir" ]; then
  printf 'temporary tg-axi runtime already exists: %s\n' "$stage_dir" >&2
  exit 2
fi
install -d -m 0755 "$stage_dir"
cp -a "$repo_root/dist" "$stage_dir/dist"
cp -a "$repo_root/docs" "$stage_dir/docs"
cp -a "$repo_root/integrations" "$stage_dir/integrations"
cp -a "$repo_root/skills" "$stage_dir/skills"
install -m 0644 "$repo_root/package.json" "$repo_root/pnpm-lock.yaml" "$repo_root/README.md" "$repo_root/LICENSE" "$stage_dir/"
corepack pnpm --dir "$stage_dir" install --prod --frozen-lockfile --ignore-scripts

if [ -e "$runtime_dir" ]; then
  printf 'validated tg-axi runtime appeared during installation: %s\n' "$runtime_dir" >&2
  exit 2
fi
printf '#!/usr/bin/env bash\nexec /home/ubuntu/firstmate/.local/lib/tg-axi/%s/dist/bin/tg-axi.js "$@"\n' "$revision" > "$launcher_tmp"
install -m 0755 "$launcher_tmp" "$launcher_stage"
mv -T "$stage_dir" "$runtime_dir"
mv -T "$launcher_stage" "$launcher"
printf 'installed %s\n' "$runtime_dir"
