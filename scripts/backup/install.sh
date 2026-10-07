#!/usr/bin/env bash
# 本番機で root として実行する: sudo scripts/backup/install.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v restic >/dev/null || apt-get install -y restic
command -v jq >/dev/null || apt-get install -y jq

install -m 755 raspi-backup.sh raspi-backup-notify.sh /usr/local/bin/
install -m 644 raspi-backup.service raspi-backup-failed.service raspi-backup.timer /etc/systemd/system/

install -d -m 700 /etc/raspi-backup
[ -f /etc/raspi-backup/env ] || install -m 600 env.example /etc/raspi-backup/env
if [ ! -f /etc/raspi-backup/restic-password ]; then
  (umask 077; openssl rand -base64 32 >/etc/raspi-backup/restic-password)
  echo "restic のパスワードを生成しました: /etc/raspi-backup/restic-password"
  echo "パスワードマネージャに控えてください（これがないと復元できません）"
fi

# shellcheck source=/dev/null
source /etc/raspi-backup/env
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE
restic cat config >/dev/null 2>&1 || restic init

systemctl daemon-reload
systemctl enable --now raspi-backup.timer
