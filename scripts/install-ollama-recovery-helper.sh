#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then
  echo 'Run this installer as root on the GPU host.' >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -o root -g root -m644 "$script_dir/ollama-recovery-restart.service" /etc/systemd/system/ollama-recovery-restart.service
install -o root -g root -m644 "$script_dir/ollama-recovery.rules" /etc/polkit-1/rules.d/50-ollama-recovery.rules
systemctl daemon-reload
