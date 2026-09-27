#!/usr/bin/env bash
# scripts/deploy.sh

set -euo pipefail

PROJECT_ROOT="/home/suibari/work/bsky-affirmative-bot"
cd "$PROJECT_ROOT"

# pull前の最新コミットIDを記録
OLD_COMMIT="$(git rev-parse HEAD)"
git pull origin main
NEW_COMMIT="$(git rev-parse HEAD)"

# 依存関係のインストールとビルド
pnpm install --frozen-lockfile
pnpm build

# 変更があった場所を特定
DIFF_FILES="$(git diff --name-only "$OLD_COMMIT" "$NEW_COMMIT")"

RESTART_BOT=false
RESTART_NAGI_BOT=false
RESTART_BIO=false
RESTART_LABELER=false
RESTART_DISCORD=false
RESTART_NAGI_APPVIEW=false
RESTART_SEARXNG=false
SEARXNG_FAILED=false
PUSH_DB=false
PUBLISH_LEXICON=false

# 判定ロジック
if echo "$DIFF_FILES" | grep -q "packages/"; then
    # 共有ライブラリが変わったらすべて再起動
    RESTART_BOT=true
    RESTART_NAGI_BOT=true
    RESTART_BIO=true
    RESTART_LABELER=true
    RESTART_DISCORD=true
    RESTART_NAGI_APPVIEW=true
fi

if echo "$DIFF_FILES" | grep -q "apps/bsky_bot_server/"; then
    RESTART_BOT=true
fi

if echo "$DIFF_FILES" | grep -q "apps/nagi_bot_server/"; then
    RESTART_NAGI_BOT=true
fi

if echo "$DIFF_FILES" | grep -q "apps/biorhythm_server/"; then
    RESTART_BIO=true
fi

if echo "$DIFF_FILES" | grep -q "apps/labeler_server/"; then
    RESTART_LABELER=true
fi

if echo "$DIFF_FILES" | grep -q "apps/discord_bot/"; then
    RESTART_DISCORD=true
fi

if echo "$DIFF_FILES" | grep -q "apps/nagi_appview/"; then
    RESTART_NAGI_APPVIEW=true
fi

# SearXNG は grounding の検索段。唯一 systemd ではなく Docker で動かしている。
if echo "$DIFF_FILES" | grep -Eq "^searxng/|^scripts/deploy-searxng\.sh$"; then
    RESTART_SEARXNG=true
fi

# DB 判定/push
if echo "$DIFF_FILES" | grep -Eq \
    "^packages/database/(src/(schema|nagiSchema)\.ts|drizzle/|drizzle\.config\.cjs)"; then
    PUSH_DB=true
fi

# Lexicon 判定
if echo "$DIFF_FILES" | grep -q "packages/nagi-lexicon/lexicons/"; then
    PUBLISH_LEXICON=true
fi

if [ "$PUSH_DB" = true ]; then
    echo "♻️  Pushing DB..."
    pnpm --filter ./packages/database drizzle:push
fi

# 実際の再起動処理

# Git差分がなくても上流イメージを確認する。失敗しても他appsは更新するが、
# 最後に非ゼロで終了し、検索基盤の更新失敗を成功扱いしない。
SEARXNG_ARGS=()
if [ "$RESTART_SEARXNG" = true ]; then
    SEARXNG_ARGS=(--force-recreate)
fi
if ! bash scripts/deploy-searxng.sh "${SEARXNG_ARGS[@]}"; then
    SEARXNG_FAILED=true
    echo "⚠️ SearXNG の更新に失敗。他のサービスは続行する。" >&2
fi

if [ "$RESTART_BIO" = true ]; then
    echo "♻️  Restarting Biorhythm Server..."
    sudo systemctl restart biorhythm-server.service
fi

if [ "$RESTART_BOT" = true ]; then
    echo "♻️  Restarting Bot Server..."
    sudo systemctl restart bsky-bot.service
fi

if [ "$RESTART_NAGI_BOT" = true ]; then
    echo "♻️  Restarting Nagi Bot Server..."
    sudo systemctl restart nagi-bot.service
fi

if [ "$RESTART_LABELER" = true ]; then
    echo "♻️  Restarting Labeler Server..."
    sudo systemctl restart labeler-server.service
fi

if [ "$RESTART_DISCORD" = true ]; then
    echo "♻️  Restarting Discord Bot..."
    sudo systemctl restart discord-bot.service
fi

if [ "$RESTART_NAGI_APPVIEW" = true ]; then
    echo "♻️  Restarting Nagi AppView..."
    sudo systemctl restart nagi-appview.service
fi

if [ "$PUBLISH_LEXICON" = true ]; then
    echo "♻️  Publishing Lexicon..."
    pnpm --filter ./packages/nagi-lexicon lex:publish
fi

if [ "$SEARXNG_FAILED" = true ]; then
    echo "❌ 他appsの更新は完了しましたが、SearXNGの更新に失敗しました。" >&2
    exit 1
fi
echo "✅ Deployment completed: $OLD_COMMIT -> $NEW_COMMIT"
