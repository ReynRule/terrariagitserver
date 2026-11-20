#!/usr/bin/env bash
# tModLoader / 모드 / playit 설치 + data 브랜치의 월드 복원
set -euo pipefail

ROOT="$(pwd)"
mkdir -p tml tml-data/Mods tml-data/Worlds bin

# ---- tModLoader ----
if [ -n "${TML_VERSION:-}" ]; then
  url="https://github.com/tModLoader/tModLoader/releases/download/${TML_VERSION}/tModLoader.zip"
else
  url="https://github.com/tModLoader/tModLoader/releases/latest/download/tModLoader.zip"
fi
echo "Downloading tModLoader: $url"
curl -fsSL "$url" -o /tmp/tml.zip
unzip -q -o /tmp/tml.zip -d tml

# ---- playit.gg agent (공개 TCP 터널) ----
curl -fsSL https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64 -o bin/playit
chmod +x bin/playit

# ---- 월드/설정 복원 (data 브랜치) ----
if git ls-remote --exit-code --heads origin data >/dev/null 2>&1; then
  echo "Restoring data branch"
  git clone -q --depth 1 -b data "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" data
else
  echo "No data branch yet (first run)"
  mkdir -p data
fi
mkdir -p data/Worlds
cp -a data/Worlds/. tml-data/Worlds/ 2>/dev/null || true
echo "Worlds restored:"; ls -1 tml-data/Worlds || true

# ---- 모드 (Steam Workshop, 익명 steamcmd) ----
count=$(node -e "console.log((require('./server/mods.json').workshopIds||[]).length)")
if [ "$count" -gt 0 ]; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq lib32gcc-s1 lib32stdc++6 >/dev/null
  mkdir -p steamcmd steam
  curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz -C steamcmd

  args=(+force_install_dir "$ROOT/steam" +login anonymous)
  for id in $(node -e "console.log(require('./server/mods.json').workshopIds.map(String).filter(s=>/^\d+$/.test(s)).join(' '))"); do
    args+=(+workshop_download_item 1281930 "$id")
  done
  args+=(+quit)
  ./steamcmd/steamcmd.sh "${args[@]}"

  for d in steam/steamapps/workshop/content/1281930/*/; do
    [ -d "$d" ] || continue
    v=$(find "$d" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1 || true)
    if [ -n "$v" ] && ls "$v"/*.tmod >/dev/null 2>&1; then
      cp "$v"/*.tmod tml-data/Mods/
    elif ls "$d"/*.tmod >/dev/null 2>&1; then
      cp "$d"/*.tmod tml-data/Mods/
    else
      echo "WARN: no .tmod found in $d"
    fi
  done
fi

# enabled.json = 내려받은 모든 .tmod → 모든 월드에 동일하게 적용
node -e "
const fs=require('fs');
const names=fs.readdirSync('tml-data/Mods').filter(f=>f.endsWith('.tmod')).map(f=>f.replace(/\.tmod\$/,''));
fs.writeFileSync('tml-data/Mods/enabled.json', JSON.stringify(names));
console.log('Enabled mods:', names.join(', ')||'(none)');
"
