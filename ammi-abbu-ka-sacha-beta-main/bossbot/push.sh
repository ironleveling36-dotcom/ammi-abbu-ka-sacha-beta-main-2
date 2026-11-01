#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Push the finished bossbot project to github.com/hulm0408/bossbot
#
# The repo already exists and is EMPTY, and this archive already contains one
# clean commit — so this is a single push, no history rewriting.
#
# Usage:
#   tar -xzf bossbot-git.tar.gz -C bossbot-v1
#   bash bossbot-v1/push.sh          (or run the two commands at the bottom)
# ---------------------------------------------------------------------------
set -euo pipefail

DEST="${1:-.}"
cd "$DEST"

echo "→ repo: $(git log --oneline -1)"
echo "→ files: $(git ls-files | wc -l | tr -d ' ')"

git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/hulm0408/bossbot.git
git push -u origin main

echo
echo "✅ pushed. Now on Render:"
echo "   1. New → Blueprint (or Web Service) → pick hulm0408/bossbot"
echo "   2. Add env: BOT_TOKEN, BOSS_IDS (numeric Telegram IDs, comma separated)"
echo "   3. Add a disk mounted at  /opt/render/project/src/vendor/data"
echo "   4. Deploy. Health check path is /"
