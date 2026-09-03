# 埋め込みモデル評価 — 集計

- 生成: 2026-09-03T18:10:18.174Z
- コーパス: posts / 3000 件 (hash 1e2564b5c976)
- 採点: LLM 下書きのみ（hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S）
- クエリ: 27 件

> **この数字はまだ暫定です。** LLM-as-judge は日本語の固有名詞で判定がぶれます。
> review.md を人手で確認し、`--judge=human` で再集計した数字で判断してください。

## 全体

| アーム | nDCG@10 | P@1 | P@5 | MRR | Recall@20 | 依存 | 説明 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `ruri+sparse@a0.7+rerank-ruri` | 0.699 | 0.815 | 0.859 | 0.883 | 0.428 | sidecar | ruri+sparse@a0.7 の上位50件を cl-nagoya/ruri-v3-reranker-310m で並べ替え |
| `ruri310` | 0.664 | 0.852 | 0.837 | 0.910 | 0.414 | sidecar | ruri-v3-310m dense のみ |
| `egemma+sparse@a0.7` | 0.662 | 0.815 | 0.793 | 0.869 | 0.451 | ollama+sidecar | egemma dense 0.7 + bge-m3 sparse 0.3 |
| `egemma+sparse@a0.9` | 0.660 | 0.852 | 0.793 | 0.888 | 0.444 | ollama+sidecar | egemma dense 0.9 + bge-m3 sparse 0.1 |
| `ruri+sparse@a0.9` | 0.651 | 0.815 | 0.815 | 0.889 | 0.442 | sidecar | ruri310 dense 0.9 + bge-m3 sparse 0.1 |
| `egemma` | 0.640 | 0.815 | 0.741 | 0.857 | 0.412 | ollama | embeddinggemma dense のみ |
| `qwen3-06b` | 0.639 | 0.815 | 0.741 | 0.857 | 0.376 | ollama | Qwen3-Embedding-0.6B dense のみ |
| `ruri+sparse@a0.7+rerank-bge` | 0.632 | 0.778 | 0.704 | 0.855 | 0.439 | sidecar | ruri+sparse@a0.7 の上位50件を BAAI/bge-reranker-v2-m3 で並べ替え |
| `ruri+sparse@a0.7` | 0.620 | 0.815 | 0.756 | 0.869 | 0.410 | sidecar | ruri310 dense 0.7 + bge-m3 sparse 0.3 |
| `egemma+sparse@a0.5` | 0.604 | 0.778 | 0.733 | 0.831 | 0.422 | ollama+sidecar | egemma dense 0.5 + bge-m3 sparse 0.5 |
| `ruri+sparse@a0.5` | 0.584 | 0.815 | 0.741 | 0.848 | 0.410 | sidecar | ruri310 dense 0.5 + bge-m3 sparse 0.5 |
| `egemma+sparse@a0.3` | 0.561 | 0.741 | 0.674 | 0.802 | 0.400 | ollama+sidecar | egemma dense 0.3 + bge-m3 sparse 0.7 |
| `arctic-q` | 0.560 | 0.667 | 0.681 | 0.774 | 0.374 | ollama | arctic dense のみ + query: 接頭辞 |
| `ruri+sparse@a0.3` | 0.559 | 0.778 | 0.696 | 0.815 | 0.399 | sidecar | ruri310 dense 0.3 + bge-m3 sparse 0.7 |
| `bge+sparse@a0.5` | 0.545 | 0.741 | 0.667 | 0.805 | 0.362 | ollama+sidecar | bge-dense dense 0.5 + bge-m3 sparse 0.5 |
| `bge+sparse@a0.7` | 0.544 | 0.741 | 0.719 | 0.827 | 0.363 | ollama+sidecar | bge-dense dense 0.7 + bge-m3 sparse 0.3 |
| `arctic+trgm+rerank-ruri` | 0.540 | 0.741 | 0.681 | 0.771 | 0.282 | ollama+postgres+sidecar | arctic+trgm の上位50件を cl-nagoya/ruri-v3-reranker-310m で並べ替え |
| `bge+sparse@a0.3` | 0.536 | 0.704 | 0.667 | 0.783 | 0.361 | ollama+sidecar | bge-dense dense 0.3 + bge-m3 sparse 0.7 |
| `e5-large` | 0.520 | 0.667 | 0.630 | 0.790 | 0.316 | sidecar | multilingual-e5-large dense のみ |
| `bge+sparse@a0.9` | 0.512 | 0.630 | 0.652 | 0.743 | 0.351 | ollama+sidecar | bge-dense dense 0.9 + bge-m3 sparse 0.1 |
| `bge-sparse` | 0.502 | 0.667 | 0.637 | 0.765 | 0.318 | sidecar | bge-m3 sparse のみ |
| `bge-dense` | 0.465 | 0.444 | 0.593 | 0.639 | 0.332 | ollama | bge-m3 dense のみ |
| `arctic+trgm+rerank-bge` | 0.415 | 0.593 | 0.585 | 0.704 | 0.249 | ollama+postgres+sidecar | arctic+trgm の上位50件を BAAI/bge-reranker-v2-m3 で並べ替え |
| `arctic+trgm` ⬅ 現行本番 | 0.366 | 0.556 | 0.481 | 0.649 | 0.209 | ollama+postgres | arctic dense 0.7 + pg_trgm 0.3（現行本番の再現） |
| `arctic` | 0.343 | 0.593 | 0.452 | 0.664 | 0.195 | ollama | arctic dense のみ |

## カテゴリ別 nDCG@10

| アーム | proper-noun | general | emotion | compound | cross-lingual |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ruri+sparse@a0.7+rerank-ruri` | 0.502 | 0.988 | 0.635 | 0.761 | 0.613 |
| `ruri310` | 0.598 | 0.965 | 0.559 | 0.590 | 0.554 |
| `egemma+sparse@a0.7` | 0.469 | 0.960 | 0.619 | 0.685 | 0.578 |
| `egemma+sparse@a0.9` | 0.423 | 0.956 | 0.647 | 0.622 | 0.696 |
| `ruri+sparse@a0.9` | 0.547 | 0.989 | 0.549 | 0.614 | 0.500 |
| `egemma` | 0.382 | 0.916 | 0.635 | 0.588 | 0.750 |
| `qwen3-06b` | 0.458 | 0.972 | 0.494 | 0.670 | 0.595 |
| `ruri+sparse@a0.7+rerank-bge` | 0.473 | 0.944 | 0.613 | 0.597 | 0.512 |
| `ruri+sparse@a0.7` | 0.502 | 0.976 | 0.531 | 0.642 | 0.378 |
| `egemma+sparse@a0.5` | 0.453 | 0.956 | 0.578 | 0.684 | 0.276 |
| `ruri+sparse@a0.5` | 0.487 | 0.960 | 0.471 | 0.677 | 0.213 |
| `egemma+sparse@a0.3` | 0.418 | 0.942 | 0.443 | 0.692 | 0.223 |
| `arctic-q` | 0.400 | 0.914 | 0.537 | 0.511 | 0.396 |
| `ruri+sparse@a0.3` | 0.471 | 0.940 | 0.390 | 0.691 | 0.188 |
| `bge+sparse@a0.5` | 0.458 | 0.954 | 0.384 | 0.627 | 0.183 |
| `bge+sparse@a0.7` | 0.468 | 0.940 | 0.369 | 0.554 | 0.291 |
| `arctic+trgm+rerank-ruri` | 0.313 | 0.954 | 0.421 | 0.496 | 0.520 |
| `bge+sparse@a0.3` | 0.445 | 0.940 | 0.357 | 0.656 | 0.161 |
| `e5-large` | 0.452 | 0.864 | 0.593 | 0.324 | 0.276 |
| `bge+sparse@a0.9` | 0.447 | 0.906 | 0.371 | 0.389 | 0.364 |
| `bge-sparse` | 0.377 | 0.896 | 0.324 | 0.657 | 0.157 |
| `bge-dense` | 0.404 | 0.871 | 0.336 | 0.286 | 0.345 |
| `arctic+trgm+rerank-bge` | 0.289 | 0.634 | 0.375 | 0.260 | 0.547 |
| `arctic+trgm` | 0.214 | 0.700 | 0.299 | 0.328 | 0.261 |
| `arctic` | 0.162 | 0.632 | 0.305 | 0.297 | 0.328 |

## 判断

置き換えに進む条件は次の2つを**同時に**満たすこと（プラン記載の基準）:

1. `proper-noun` の nDCG@10 が現行本番 `arctic+trgm` より明確に上
2. 全カテゴリ平均の nDCG@10 が現行本番より劣化していない

現行本番: nDCG@10 = 0.366 / proper-noun = 0.214

| アーム | 全体差分 | proper-noun 差分 | 条件 | 依存 |
| --- | ---: | ---: | --- | --- |
| `ruri+sparse@a0.7+rerank-ruri` | +0.333 | +0.288 | ✅ | sidecar |
| `ruri310` | +0.298 | +0.383 | ✅ | sidecar |
| `egemma+sparse@a0.7` | +0.296 | +0.255 | ✅ | ollama+sidecar |
| `egemma+sparse@a0.9` | +0.294 | +0.209 | ✅ | ollama+sidecar |
| `ruri+sparse@a0.9` | +0.285 | +0.333 | ✅ | sidecar |
| `egemma` | +0.274 | +0.168 | ✅ | ollama |
| `qwen3-06b` | +0.273 | +0.244 | ✅ | ollama |
| `ruri+sparse@a0.7+rerank-bge` | +0.266 | +0.259 | ✅ | sidecar |
| `ruri+sparse@a0.7` | +0.254 | +0.288 | ✅ | sidecar |
| `egemma+sparse@a0.5` | +0.239 | +0.239 | ✅ | ollama+sidecar |
| `ruri+sparse@a0.5` | +0.218 | +0.273 | ✅ | sidecar |
| `egemma+sparse@a0.3` | +0.195 | +0.204 | ✅ | ollama+sidecar |
| `arctic-q` | +0.194 | +0.185 | ✅ | ollama |
| `ruri+sparse@a0.3` | +0.193 | +0.257 | ✅ | sidecar |
| `bge+sparse@a0.5` | +0.179 | +0.244 | ✅ | ollama+sidecar |
| `bge+sparse@a0.7` | +0.179 | +0.254 | ✅ | ollama+sidecar |
| `arctic+trgm+rerank-ruri` | +0.174 | +0.099 | ✅ | ollama+postgres+sidecar |
| `bge+sparse@a0.3` | +0.170 | +0.231 | ✅ | ollama+sidecar |
| `e5-large` | +0.154 | +0.238 | ✅ | sidecar |
| `bge+sparse@a0.9` | +0.146 | +0.233 | ✅ | ollama+sidecar |
| `bge-sparse` | +0.136 | +0.163 | ✅ | sidecar |
| `bge-dense` | +0.099 | +0.190 | ✅ | ollama |
| `arctic+trgm+rerank-bge` | +0.049 | +0.075 | ✅ | ollama+postgres+sidecar |
| `arctic` | -0.023 | -0.052 | — | ollama |

## 埋め込み生成の実測時間

| エンコーダ | ms |
| --- | ---: |
| `ruri310` | 470448 |
| `e5-large` | 617406 |
