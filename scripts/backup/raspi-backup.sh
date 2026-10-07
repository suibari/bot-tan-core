#!/usr/bin/env bash
# /usr/local/bin/raspi-backup.sh
# 正本はリポジトリの scripts/backup/raspi-backup.sh。install.sh で配置する。
#
# Postgres と SQLite を整合した状態で書き出し、設定ファイル類と一緒に restic で
# 暗号化して Google Drive へ送る。世代管理は restic 側（forget/prune）で行う。

set -euo pipefail
umask 077

CONF=/etc/raspi-backup/env
# shellcheck source=/dev/null
source "$CONF"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set in $CONF}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is not set in $CONF}"
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE
# Drive は小さいファイルを大量に書くと rateLimitExceeded を返すので、pack を大きくし、
# rclone の呼び出し頻度も絞る。
export RESTIC_PACK_SIZE=64
RESTIC_OPTS=(-o "rclone.args=serve restic --stdio --tpslimit 4 --tpslimit-burst 4")

WORK_ROOT=/home/suibari/work
APP="$WORK_ROOT/bsky-affirmative-bot"
STAGE=/backup/staging
PG_CONTAINER=postgres-db
PG_USER=suibari_user
PG_DB=suibari_db

log() { echo "[raspi-backup] $*"; }

rm -rf "$STAGE"
mkdir -p "$STAGE/sqlite"

# ---- 1. Postgres ---------------------------------------------------------
# ロールなどのグローバル定義は pg_dump に含まれないので別に取る。
log "dumping postgres globals"
docker exec "$PG_CONTAINER" pg_dumpall -U "$PG_USER" --globals-only >"$STAGE/globals.sql"

# 圧縮は restic に任せる（-Z 0）。pg_dump 側で圧縮すると、変わっていない表まで毎日
# 別のバイト列になり、restic の重複排除が効かず全量を送り直すことになる。
log "dumping $PG_DB (custom format)"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc -Z 0 "$PG_DB" >"$STAGE/$PG_DB.dump"

# 途中で切れたダンプを「今日の分」として送らないよう、目次が読めることを確かめる。
docker exec -i "$PG_CONTAINER" pg_restore --list <"$STAGE/$PG_DB.dump" >"$STAGE/$PG_DB.toc"
grep -q "TABLE DATA" "$STAGE/$PG_DB.toc"

# 復元練習で突き合わせるための行数（統計値なので概数）。
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -AtF $'\t' -c \
  "select schemaname || '.' || relname, n_live_tup from pg_stat_user_tables order by 1" \
  >"$STAGE/$PG_DB.rowcounts.tsv"

# ---- 2. SQLite -----------------------------------------------------------
# 稼働中のファイルをそのままコピーすると壊れた状態で保存されうるので .backup を使う。
backup_sqlite() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  sqlite3 "$src" ".backup '$dest'"
  [ "$(sqlite3 "$dest" 'PRAGMA integrity_check')" = "ok" ]
  log "sqlite ok: $src"
}

backup_sqlite "$APP/apps/labeler_server/label.db" "$STAGE/sqlite/label.db"

# 自前 PDS を立てたら、ここで /pds 配下の *.sqlite も拾う（blob は下の restic で直接送る）。
if [ -d /pds ]; then
  while IFS= read -r -d '' db; do
    backup_sqlite "$db" "$STAGE/sqlite/pds/${db#/pds/}"
  done < <(find /pds -name '*.sqlite' -print0)
fi

# ---- 3. 復旧に必要な設定 -------------------------------------------------
for u in root suibari; do
  crontab -l -u "$u" >"$STAGE/crontab.$u" 2>/dev/null || true
done
date --iso-8601=seconds >"$STAGE/created_at"

PATHS=(
  "$STAGE"
  /etc/systemd/system
  /etc/cloudflared
  /home/suibari/.cloudflared
  /home/suibari/work/docker-db/docker-compose.yml
  /home/suibari/work/docker-db/init-sql
  /etc/raspi-backup/env
)
# 稼働中のサービスの .env（署名鍵や API キーを含む。restic で暗号化される）。
# bot は URL_JETSTREAM で JetstreamProxy を使うので、そちらも復旧に要る。
for f in \
  "$APP/.env" \
  "$APP/searxng/.env" \
  "$WORK_ROOT/JetstreamProxy/.env"; do
  [ -f "$f" ] && PATHS+=("$f")
done
# 自作スクリプト（/usr/local/bin の node などのバイナリは含めない）
while IFS= read -r -d '' f; do PATHS+=("$f"); done \
  < <(find /usr/local/bin -maxdepth 1 -name '*.sh' -print0)
[ -d /pds/blocks ] && PATHS+=(/pds/blocks)

# ---- 4. restic -----------------------------------------------------------
log "restic backup -> $RESTIC_REPOSITORY"
restic "${RESTIC_OPTS[@]}" backup --host raspi5 --tag nightly "${PATHS[@]}"

# 日曜だけ世代整理と整合性チェックを行う（Drive 越しの prune は遅いため）。
if [ "$(date +%u)" = 7 ]; then
  log "restic forget/prune"
  restic "${RESTIC_OPTS[@]}" forget --host raspi5 --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
  restic "${RESTIC_OPTS[@]}" check
fi

log "done"
