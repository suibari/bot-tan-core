# 本番機のバックアップ

本番機（Raspberry Pi 5, `192.168.1.200`）のデータと復旧に必要な設定を、restic で暗号化して
Google Drive の `restic-raspi5` へ送る。

## 何を・いつ

毎日 3:30（`raspi-backup.timer`）に `raspi-backup.sh` が動く。

| 対象 | 方法 |
|---|---|
| Postgres `suibari_db` | `pg_dump -Fc -Z 0`（圧縮は restic に任せる。差分保存を効かせるため） |
| Postgres のロール | `pg_dumpall --globals-only` |
| ラベラー `apps/labeler_server/label.db` | `sqlite3 .backup` と `PRAGMA integrity_check` |
| `/pds` 配下の `*.sqlite` と `/pds/blocks` | 自前 PDS を立てたら自動で含まれる |
| `.env`（本リポジトリ、`searxng/`、`JetstreamProxy`） | そのまま |
| systemd のユニット、cloudflared、`docker-db` の compose、root と suibari の crontab、`/usr/local/bin/*.sh` | そのまま |

世代は日次7・週次4・月次6。日曜だけ `forget --prune` と `check` を行う。
失敗すると `raspi-backup-failed.service` が `BACKUP_DISCORD_WEBHOOK_URL` へ知らせる。

## 配置

本番機で、リポジトリを更新してから実行する。

```
sudo scripts/backup/install.sh
```

restic と jq を入れ、スクリプトとユニットを配置する。初回だけ `/etc/raspi-backup/env` と
パスワードを作り、リポジトリを初期化する。

## 鍵の置き場所

| もの | 本番機 | 自分 |
|---|---|---|
| restic のパスワード | `/etc/raspi-backup/restic-password`（root, 600） | パスワードマネージャ |
| Drive の OAuth クライアント（ID・シークレット） | `/root/.config/rclone/rclone.conf` | パスワードマネージャ |

restic のパスワードは、ファイルを書き換えただけでは変わらない。古いパスワードで開いて
`restic key passwd --new-password-file <新しいファイル>` を実行すること。古いパスワードを
失うと、リポジトリは誰にも開けなくなる。

## 復元練習

Pi 以外のマシンで、パスワードマネージャに控えた鍵だけを使って行う。

```
RESTIC_REPOSITORY=rclone:<remote>:restic-raspi5 \
RESTIC_PASSWORD_FILE=~/.config/restic/raspi5.pass \
scripts/backup/restore-drill.sh
```

最新のスナップショットを一時ディレクトリへ戻し、pgvector の一時コンテナに Postgres を戻して
表ごとの行数を突き合わせ、SQLite と設定ファイルを確かめる。終わったらコンテナと復元した
ファイルを消す（`.env` を含むため）。2026-10-07 の .220 での実績は、取得 43 秒、Postgres の
復元 61 秒。

新しい rclone は Google Drive に自分の OAuth クライアント ID を要求する。Google Cloud Console で
Drive API を有効にし、同意画面を「本番環境」（「テスト」だと7日で認証が切れる）、種類
「デスクトップ アプリ」で作る。

## Pi を失ったとき

1. 新しい機体に Docker、rclone、restic を入れ、rclone で Drive を認証する
2. `restic restore latest --target /` で設定ファイル類を戻す（`/backup/staging` も戻る）
3. `docker-db` の compose で Postgres を起動し、`globals.sql` を流してから
   `pg_restore -d suibari_db /backup/staging/suibari_db.dump`
4. `label.db` を `apps/labeler_server/` へ置く
5. リポジトリを clone してビルドし、systemd のサービスと cloudflared を起動する
