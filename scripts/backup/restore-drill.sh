#!/usr/bin/env bash
# 復元練習: Pi 以外のマシンで、パスワードマネージャに控えた鍵だけを使って戻せるかを確かめる。
#
#   RESTIC_REPOSITORY=rclone:<remote>:restic-raspi5 \
#   RESTIC_PASSWORD_FILE=~/.config/restic/raspi5.pass \
#   scripts/backup/restore-drill.sh [snapshot]
#
# 必要なもの: restic, rclone（Drive の remote 設定済み）, docker, sqlite3
# 復元したファイルには .env などの秘密情報が含まれるので、終了時に必ず消す。
# KEEP=1 を付けると、確認用に Postgres コンテナと作業ディレクトリを残す。

set -euo pipefail

: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY (e.g. rclone:gdrive:restic-raspi5)}"
: "${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE}"
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE

SNAPSHOT="${1:-latest}"
CONTAINER=nagi-restore-drill
PG_IMAGE=pgvector/pgvector:pg16
PG_USER=suibari_user
PG_DB=suibari_db
WORK="$(mktemp -d -t restore-drill.XXXXXX)"
chmod 700 "$WORK"

cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then
    echo "KEEP=1: $WORK とコンテナ $CONTAINER を残しました。確認後に消してください:"
    echo "  docker rm -f $CONTAINER; rm -rf $WORK"
    return
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
FAILED=0
fail() { echo "NG: $*"; FAILED=1; }

step "スナップショット一覧"
restic snapshots --host raspi5

step "復元: $SNAPSHOT -> $WORK"
started=$(date +%s)
restic restore "$SNAPSHOT" --target "$WORK"
STAGE="$WORK/backup/staging"
echo "作成日時: $(cat "$STAGE/created_at")"
echo "復元にかかった時間: $(($(date +%s) - started)) 秒"

step "Postgres を一時コンテナへ戻す"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER="$PG_USER" -e POSTGRES_DB="$PG_DB" \
  -e POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | base64)" \
  "$PG_IMAGE" >/dev/null
for _ in $(seq 60); do
  docker exec "$CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
  sleep 1
done
# initdb 直後の再起動を待つ
sleep 3
docker exec "$CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null

# 作成済みの suibari_user などは「既にある」エラーになるが、ほかのロールが作られればよい。
docker exec -i "$CONTAINER" psql -q -U "$PG_USER" -d postgres <"$STAGE/globals.sql" >/dev/null 2>&1 || true

started=$(date +%s)
docker cp "$STAGE/$PG_DB.dump" "$CONTAINER:/tmp/$PG_DB.dump"
if docker exec "$CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" -j 4 "/tmp/$PG_DB.dump" 2>"$WORK/pg_restore.err"; then
  echo "pg_restore: エラーなし"
else
  echo "pg_restore のエラー（先頭10行）:"
  head -n 10 "$WORK/pg_restore.err"
  fail "pg_restore がエラーを返しました"
fi
echo "Postgres の復元にかかった時間: $(($(date +%s) - started)) 秒"

step "行数の突き合わせ（バックアップ時の統計値と比べ、20%以上ずれた表を出す）"
docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -AtF $'\t' -c "analyze" >/dev/null
docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -AtF $'\t' -c \
  "select schemaname || '.' || relname, n_live_tup from pg_stat_user_tables order by 1" \
  >"$WORK/restored.rowcounts.tsv"
if ! awk -F'\t' '
  NR == FNR { expected[$1] = $2; next }
  { restored[$1] = $2 }
  END {
    bad = 0; tables = 0; rows = 0
    for (t in expected) {
      tables++; rows += restored[t]
      e = expected[t] + 0; r = restored[t] + 0
      if (!(t in restored)) { printf "  無い: %s\n", t; bad++; continue }
      if (e >= 100 && (r < e * 0.8 || r > e * 1.2)) { printf "  ずれ: %s 期待 %d / 復元 %d\n", t, e, r; bad++ }
    }
    printf "表 %d 個、行 %d（統計値）\n", tables, rows
    exit bad > 0
  }' "$STAGE/$PG_DB.rowcounts.tsv" "$WORK/restored.rowcounts.tsv"; then
  fail "行数が大きくずれた表があります"
fi

step "SQLite"
while IFS= read -r -d '' db; do
  rel="${db#"$STAGE"/sqlite/}"
  if [ "$(sqlite3 "$db" 'PRAGMA integrity_check')" = ok ]; then
    tables=$(sqlite3 "$db" "select group_concat(name, ', ') from sqlite_master where type = 'table'")
    echo "ok: $rel ($tables)"
  else
    fail "$rel の integrity_check が通りません"
  fi
done < <(find "$STAGE/sqlite" \( -name '*.db' -o -name '*.sqlite' \) -print0 2>/dev/null | sort -z)
[ -f "$STAGE/sqlite/label.db" ] && echo "label.db のラベル数: $(sqlite3 "$STAGE/sqlite/label.db" 'select count(*) from labels' 2>/dev/null || echo '?')"

step "設定ファイル"
for f in \
  home/suibari/work/bsky-affirmative-bot/.env \
  home/suibari/work/docker-db/docker-compose.yml \
  etc/cloudflared/config.yml \
  etc/systemd/system/nagi-appview.service \
  etc/raspi-backup/env; do
  if [ -s "$WORK/$f" ]; then echo "ok: /$f"; else fail "/$f がありません"; fi
done
for f in \
  home/suibari/work/bsky-affirmative-bot/searxng/.env \
  home/suibari/work/JetstreamProxy/.env; do
  if [ -s "$WORK/$f" ]; then echo "ok: /$f"; else fail "/$f がありません"; fi
done

step "結果"
if [ "$FAILED" = 0 ]; then
  echo "復元練習: 成功"
else
  echo "復元練習: 問題あり（上の NG を確認）"
  exit 1
fi
