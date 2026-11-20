#!/usr/bin/env bash
# Terraria 바닐라 서버 / playit 설치 + data 브랜치의 월드 복원
set -euo pipefail

mkdir -p tml tml-data/Worlds bin

# ---- Terraria 바닐라 dedicated server ----
VER="${VANILLA_VERSION:-1458}"   # 1.4.5.8 -> 1458
url="https://terraria.org/api/download/pc-dedicated-server/terraria-server-${VER}.zip"
echo "Downloading Terraria server: $url"
curl -fsSL -A "Mozilla/5.0" "$url" -o /tmp/terraria.zip
unzip -q -o /tmp/terraria.zip -d tml
chmod +x tml/*/Linux/TerrariaServer.bin.x86_64
# supervisor가 쓰는 고정 경로
ln -sfn "$(pwd)/$(ls -d tml/*/Linux | head -1)" server-bin
ls server-bin | head

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
