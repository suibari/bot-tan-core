#!/usr/bin/env bash
# Git差分にかかわらず毎デプロイ実行する。上流イメージの更新はGit差分には出ない。
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT/searxng"

if [ ! -f .env ]; then
    echo "❌ searxng/.env がありません。検索基盤の更新に失敗しました。" >&2
    exit 1
fi

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
    DOCKER=(sudo -n docker)
    if ! "${DOCKER[@]}" info >/dev/null 2>&1; then
        echo "❌ Dockerへ接続できません（sudo -n でも失敗）。" >&2
        exit 1
    fi
fi

# pull失敗時はupへ進まず、稼働中のコンテナを維持する。
"${DOCKER[@]}" compose config --quiet
echo "🔎 Checking SearXNG / gateway images..."
"${DOCKER[@]}" compose pull

# 新イメージやcompose設定の変更はupが検知する。bind mountの内容変更だけは
# 検知されないため、呼び出し元のGit差分に応じて再作成する。
RECREATE=()
case "${1:-}" in
    --force-recreate) RECREATE=(--force-recreate) ;;
    "") ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
esac
# ネットワークの設定（IPv6 の有効化など）は up では作り直されない。稼働中のネットワークが
# IPv6 無効なら、一度 down してネットワークごと作り直す（止まるのは数秒）。
NETWORK="$("${DOCKER[@]}" inspect nagi-searxng --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' 2>/dev/null || true)"
if [ -n "$NETWORK" ] && [ "$("${DOCKER[@]}" network inspect "$NETWORK" --format '{{.EnableIPv6}}' 2>/dev/null)" != "true" ]; then
    echo "🔁 ネットワーク $NETWORK が IPv6 無効のため作り直します"
    "${DOCKER[@]}" compose down
fi
"${DOCKER[@]}" compose up -d --pull never "${RECREATE[@]}" --wait --wait-timeout 90
"${DOCKER[@]}" inspect nagi-searxng --format \
    'SearXNG version={{index .Config.Labels "org.opencontainers.image.version"}} image={{.Image}} created={{.Created}}'
# 外へ出る経路の確認。IPv4 で出ていたら汚染された結果が返る（compose.yml のコメント参照）。
"${DOCKER[@]}" exec nagi-searxng /usr/local/searxng/.venv/bin/python -c \
    "from curl_cffi import requests as r; print('SearXNG egress=' + r.get('https://ifconfig.me/ip', impersonate='chrome', interface='::', timeout=10).text)" \
    || echo "⚠️ SearXNG の外向き IPv6 を確認できませんでした" >&2
