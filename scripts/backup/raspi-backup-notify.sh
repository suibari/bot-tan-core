#!/usr/bin/env bash
# /usr/local/bin/raspi-backup-notify.sh
# raspi-backup.service が失敗したときに OnFailure から呼ばれ、Discord へ知らせる。

set -uo pipefail

CONF=/etc/raspi-backup/env
# shellcheck source=/dev/null
[ -r "$CONF" ] && source "$CONF"

UNIT="${1:-raspi-backup.service}"
TAIL="$(journalctl -u "$UNIT" -n 15 --no-pager -o cat 2>/dev/null | cut -c1-180)"

if [ -z "${BACKUP_DISCORD_WEBHOOK_URL:-}" ]; then
  echo "[raspi-backup-notify] $UNIT failed (BACKUP_DISCORD_WEBHOOK_URL is not set)" >&2
  exit 0
fi

MESSAGE="$(printf '**%s が失敗しました** (%s)\n```\n%s\n```' "$UNIT" "$(hostname)" "$TAIL" | head -c 1900)"
PAYLOAD="$(jq -n --arg content "$MESSAGE" '{content: $content}')"

curl -fsS -m 15 -H 'Content-Type: application/json' -d "$PAYLOAD" "$BACKUP_DISCORD_WEBHOOK_URL" >/dev/null
