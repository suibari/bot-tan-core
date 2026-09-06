# ローカルモデル評価 機械チェック集計

生成日時: 2026-09-05T17:32:31.642Z
Gemini 実呼び出し: 0 回 / 上限 20 回（ブロック 0 件）

> **この表だけで採否を決めないこと。** 機械チェックは粗い破綻しか拾えず、誤検知も出る。
> 語彙選択や自然さの劣化はここに現れないので、必ず review*.md をブラインド採点すること。

> ホストが違うアーム同士の速度比較には、ハードウェア差が含まれる。
> warmup を除いた値は SYSTEM_INSTRUCTION がキャッシュ済み＝本番の定常状態に相当する。

## VRAM 実測

| アーム | モデルサイズ | VRAM占有 | 判定 |
|---|---:|---:|---|
| gemma-4-26B-A4B-it-GGUF:UD-IQ3_S | 11.82 GB | 11.82 GB | 全部GPU |
| gemma-4-12B-it-qat-GGUF:UD-Q4_K_ | 7.44 GB | 7.44 GB | 全部GPU |

## リプライ

| アーム | 件数 | hard違反 | warn | 空出力 | 中央値 | p95 | 出力tok | 生成tok/s | 反復間類似度 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gemma-4-26B-A4B-it-GGUF:UD-IQ3_S | 120 | 10 | 42 | 0 | 932ms | 1578ms | 74 | 140 | 0.55 |
| gemma-4-12B-it-qat-GGUF:UD-Q4_K_ | 120 | 5 | 59 | 0 | 1535ms | 14252ms | 83 | 83 | 0.42 |

### 違反の内訳

| 違反コード | gemma-4-26B-A4B-it-GGUF:UD-IQ3_S | gemma-4-12B-it-qat-GGUF:UD-Q4_K_ |
|---|---:|---:|
| first-person-soft | 28 | 38 |
| keigo | 6 | 1 |
| repetition | 0 | 1 |
| tense-error | 4 | 4 |
| tense-unclear | 14 | 20 |

## ウォームアップ（コールド）

| アーム | 全体 | ロード | promptトークン | prompt時間 |
|---|---:|---:|---:|---:|
| gemma-4-26B-A4B-it-GGUF:UD-IQ3_S | 2370ms | 349ms | 6433 | 1411ms |
| gemma-4-12B-it-qat-GGUF:UD-Q4_K_ | 10349ms | 4357ms | 6433 | 1663ms |
