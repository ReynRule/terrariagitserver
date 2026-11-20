#!/usr/bin/env bash
# 월드 파일을 data 브랜치에 "덮어쓰기" 커밋 (히스토리 없이 단일 커밋을 force push)
set -euo pipefail

ROOT="$(pwd)"
SAVE_DIR="$ROOT/tml-data"
DATA_DIR="$ROOT/data"

mkdir -p "$DATA_DIR/Worlds" "$SAVE_DIR/Worlds"
rsync -a --delete "$SAVE_DIR/Worlds/" "$DATA_DIR/Worlds/"

cd "$DATA_DIR"
rm -rf .git
git init -q -b data
git config user.name "terraria-bot"
git config user.email "terraria-bot@users.noreply.github.com"
git add -A
git commit -q -m "World backup $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -q --force "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" data:data
echo "backup pushed"
