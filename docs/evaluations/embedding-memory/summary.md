# 埋め込みモデル評価 — 集計

- 生成: 2026-09-04T01:21:51.158Z
- コーパス: memory / 3000 件 (hash 7ef4221e90ae)
- 採点: LLM 下書きのみ（hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S）
- クエリ: 23 件

> **この数字はまだ暫定です。** LLM-as-judge は日本語の固有名詞で判定がぶれます。
> review.md を人手で確認し、`--judge=human` で再集計した数字で判断してください。

## 全体

| アーム | nDCG@10 | P@1 | P@5 | MRR | Recall@20 | 依存 | 説明 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `egemma` | 0.736 | 1.000 | 0.843 | 1.000 | 0.564 | ollama | embeddinggemma dense のみ |
| `ruri+sparse@a0.7+rerank-ruri` | 0.710 | 0.957 | 0.800 | 0.978 | 0.509 | sidecar | ruri+sparse@a0.7 の上位50件を cl-nagoya/ruri-v3-reranker-310m で並べ替え |
| `ruri310` | 0.663 | 0.957 | 0.800 | 0.967 | 0.471 | sidecar | ruri-v3-310m dense のみ |
| `qwen3-06b` | 0.660 | 1.000 | 0.826 | 1.000 | 0.490 | ollama | Qwen3-Embedding-0.6B dense のみ |
| `ruri+sparse@a0.7` | 0.652 | 0.913 | 0.817 | 0.957 | 0.547 | sidecar | ruri310 dense 0.7 + bge-m3 sparse 0.3 |
| `arctic-q` | 0.643 | 0.913 | 0.730 | 0.949 | 0.450 | ollama | arctic dense のみ + query: 接頭辞 |
| `qwen3-noprefix` | 0.620 | 0.826 | 0.739 | 0.890 | 0.464 | ollama | qwen3 dense のみ（クエリ接頭辞なし） |
| `bge-sparse` | 0.612 | 0.870 | 0.687 | 0.901 | 0.384 | sidecar | bge-m3 sparse のみ |
| `arctic` | 0.566 | 0.870 | 0.635 | 0.883 | 0.364 | ollama | arctic dense のみ |

## カテゴリ別 nDCG@10

| アーム | research-hit | emotion | daily | bot-self | cross-lingual | degenerate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `egemma` | 0.818 | 0.656 | 0.818 | 0.503 | 0.738 | 0.694 |
| `ruri+sparse@a0.7+rerank-ruri` | 0.791 | 0.765 | 0.655 | 0.748 | 0.548 | 0.655 |
| `ruri310` | 0.770 | 0.738 | 0.708 | 0.463 | 0.428 | 0.623 |
| `qwen3-06b` | 0.777 | 0.468 | 0.653 | 0.564 | 0.763 | 0.610 |
| `ruri+sparse@a0.7` | 0.824 | 0.548 | 0.693 | 0.477 | 0.459 | 0.647 |
| `arctic-q` | 0.703 | 0.589 | 0.679 | 0.692 | 0.580 | 0.553 |
| `qwen3-noprefix` | 0.785 | 0.487 | 0.688 | 0.517 | 0.549 | 0.458 |
| `bge-sparse` | 0.804 | 0.368 | 0.671 | 0.513 | 0.433 | 0.654 |
| `arctic` | 0.697 | 0.427 | 0.658 | 0.441 | 0.500 | 0.473 |

## 埋め込み生成の実測時間

| エンコーダ | ms |
| --- | ---: |
| `arctic` | 235000 |
| `qwen3-noprefix` | 356350 |
| `ruri310` | 509154 |
| `egemma` | 116982 |
