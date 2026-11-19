#!/usr/bin/env bash
# 検索 gateway（searxng/compose.yml）の更新。Git差分にかかわらず毎デプロイ実行する。
# 上流イメージ（python:3.13-alpine）の更新はGit差分には出ない。
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

# gateway は1日の使用量を ./data に書く。リポジトリの持ち主の UID で動かす。
mkdir -p data
export GATEWAY_UID GATEWAY_GID
GATEWAY_UID="$(id -u)"
GATEWAY_GID="$(id -g)"

# pull失敗時はupへ進まず、稼働中のコンテナを維持する。
"${DOCKER[@]}" compose config --quiet
echo "🔎 Checking gateway image..."
"${DOCKER[@]}" compose pull

# 新イメージやcompose設定の変更はupが検知する。bind mountの内容変更だけは
# 検知されないため、呼び出し元のGit差分に応じて再作成する。
RECREATE=()
case "${1:-}" in
    --force-recreate) RECREATE=(--force-recreate) ;;
    "") ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
esac
# SearXNG をやめた（2026-11-19）ときの移行。旧構成のコンテナと IPv6 ネットワークが残っていれば、
# 一度 down して作り直す（止まるのは数秒）。
if "${DOCKER[@]}" inspect nagi-searxng >/dev/null 2>&1; then
    echo "🔁 旧 SearXNG を止めて、gateway だけの構成に作り直します"
    "${DOCKER[@]}" compose down --remove-orphans
fi
"${DOCKER[@]}" compose up -d --pull never --remove-orphans "${RECREATE[@]}" --wait --wait-timeout 90
