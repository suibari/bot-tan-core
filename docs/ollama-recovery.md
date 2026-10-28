# Ollama GPU配置の監視と回復

GPUホスト(.220)で `scripts/ollamaRecovery.mts` をuserサービスとして実行する。
DBハートビート `health:ollama-placement` を本番のbiorhythm_serverが読み、
bot-tan.comのローカルLLM欄へ配置・回復状態を出す。疎通と配置は別々に判定する。

## 配置

`~/.config/ollama-recovery.env` を0600で作成する。DATABASE_URLは本番DBへ通じる
SSHトンネル(127.0.0.1:15432)を指定する。リポジトリの開発DB設定は使わない。

```ini
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:15432/DATABASE
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL
OLLAMA_RECOVERY_GPU_UUID=GPU-2a0546c9-7fd9-8231-ee2f-553b4be04719
OLLAMA_RECOVERY_ENABLED=1
```

```sh
sudo sh scripts/install-ollama-recovery-helper.sh
install -m644 scripts/ollama-recovery.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ollama-recovery.service
journalctl --user -u ollama-recovery.service -f
```

30秒ごとに/api/psと指定GPUの空きVRAMを取得する。混在時は、モデルのGPU使用量と
空き容量の合計が必要容量以上の状態が2分続いた場合だけ再ロードする。
必要容量の初期値は9GiB、全GPU配置の実測値+1GiBがこれを超えれば引き上げる。
混在のときは同じGPUの imggen サイドカー（`IMAGEGEN_BASE_URL`、既定 `http://127.0.0.1:7998`）の
`/health` も見る。直近30分に使われていて、今は ComfyUI も SDXL も降りているなら、混在の原因は
画像生成（絵文字の生成など。docs/emoji-generation.md）とみなし、30分の再試行間隔を待たずに、
安定確認も30秒に縮めて再ロードする。連続失敗での停止と容量の確認はそのまま効く。
サイドカーの再起動直後の30分も「使われていた」と見えるが、再起動はまれなので許容する。
GPUの他アプリを停止せず、num_ctxも送らない。

再ロードは空メッセージのライフサイクル要求のみで、生成を行わない。
停止が180秒以内に完了しない場合だけroot所有の `ollama-recovery-restart.service`
を起動し、Ollamaを再起動する。共有アプリの生成が中断される可能性がある（運用者の許容済み）。
Polkitルールはsuibariユーザーにこの補助サービスのstartだけを許可する。
任意サービスの管理やファイル変更は許可しない。補助サービスが未配置・起動拒否の場合は
回復失敗として表示し、対話的認証や権限の迂回を行わない。
再ロード後の全GPU配置とコンテキストが停止前と同じことを確認する。

## 再試行・停止

試行時刻・失敗回数・必要容量・直近結果は `~/.local/state/ollama-recovery/state.json`
へ原子的に保存する。30分以上あけて再試行し、3回連続失敗で自動回復を停止する。
全GPU配置の検知、または監視サービス再起動で失敗回数を解除する。再起動しても
再試行間隔は保持する。`OLLAMA_RECOVERY_ENABLED=0` とサービス再起動で検知だけにできる。

監視自体を撤去する場合は `systemctl --user disable --now ollama-recovery.service`。
ダッシュボードはハートビートの鮮度切れを検知し、正常配置を表示し続けない。
Jetstreamの切り替え履歴と5分以上古い配送測定値は現在の異常判定から外す。
