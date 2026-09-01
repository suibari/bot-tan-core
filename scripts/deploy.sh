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
if echo "$DIFF_FILES" | grep -q "^searxng/"; then
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
    pnpm --filter ./packages/database exec drizzle-kit push --config=drizzle.config.cjs
fi

# 実際の再起動処理
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

if [ "$RESTART_SEARXNG" = true ]; then
    echo "♻️  Reloading SearXNG..."
    # .env の探索場所がバージョンで揺れるので、-f ではなく cd してから叩く。
    #
    # `up -d` ではダメ。settings.yml は bind mount で渡していてプロセス起動時に
    # しか読まれず、compose ファイル自体が変わらない限り `up -d` はコンテナを
    # 作り直さない。実際、engines を書き換えたのに反映されず /config に旧設定が
    # 残っていた。設定を確実に読み直させるため --force-recreate を付ける。
    (cd searxng && docker compose up -d --force-recreate)
fi

if [ "$PUBLISH_LEXICON" = true ]; then
    echo "♻️  Publishing Lexicon..."
    pnpm --filter ./packages/nagi-lexicon lex:publish
fi

echo "✅ Deployment completed: $OLD_COMMIT -> $NEW_COMMIT"
