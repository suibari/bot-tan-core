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
RESTART_AMATERAS=false
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
    RESTART_AMATERAS=true
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

if echo "$DIFF_FILES" | grep -q "apps/nagi_amateras/"; then
    RESTART_AMATERAS=true
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
    pnpm --filter ./packages/database drizzle:push
fi

# 実際の再起動処理

# SearXNG は grounding の検索基盤。bot より先に上げる。
#
# **ここで deploy 全体を止めない。** searxng/.env は .gitignore なので初回 pull 後は
# 存在せず、compose の ${SEARXNG_SECRET:?} がハードエラーになる。set -e のまま
# 素通しすると、以降の lexicon publish ごと落ちる。検索が無くても bot は
# 「知らない」と答えて動くので、警告だけ出して先へ進める。
if [ "$RESTART_SEARXNG" = true ]; then
    if ! command -v docker >/dev/null 2>&1; then
        echo "⚠️  docker が無いので SearXNG をスキップ"
    elif [ ! -f searxng/.env ]; then
        echo "⚠️  searxng/.env が無いので SearXNG をスキップ（初回は手動セットアップが要る）"
        echo "    cd searxng && cp .env.example .env && SEARXNG_SECRET を埋めて docker compose up -d"
    else
        echo "♻️  Reloading SearXNG..."
        # .env の探索場所がバージョンで揺れるので -f ではなく cd してから叩く。
        #
        # `up -d` ではダメ。settings.yml は bind mount で渡していてプロセス起動時に
        # しか読まれず、compose ファイル自体が変わらない限りコンテナが作り直されない。
        # 実際、engines を書き換えたのに反映されず /config に旧設定が残っていた。
        (cd searxng && docker compose up -d --force-recreate) \
            || echo "⚠️  SearXNG の再起動に失敗。他のサービスは続行する。"
    fi
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

if [ "$RESTART_AMATERAS" = true ]; then
    echo "♻️  Restarting Nagi Amateras (Labeler)..."
    sudo systemctl restart nagi-amateras.service
fi

if [ "$RESTART_NAGI_APPVIEW" = true ]; then
    echo "♻️  Restarting Nagi AppView..."
    sudo systemctl restart nagi-appview.service
fi

if [ "$PUBLISH_LEXICON" = true ]; then
    echo "♻️  Publishing Lexicon..."
    pnpm --filter ./packages/nagi-lexicon lex:publish
fi

echo "✅ Deployment completed: $OLD_COMMIT -> $NEW_COMMIT"
