# 定型リプ3値分類: 埋め込み＋ロジスティック回帰（2026-10-31）

- 教師: `polarity_samples`（three-way-v1 / qwen3-embedding:0.6b）。正解は LLM のラベル
- 学習 12612 件 / 評価 3166 件（content_hash で分割）
- 評価の内訳: all 3166、日本語 788、English 2109、other 269
- L2 = 0.1

## 学習曲線（評価データでの LLM との一致率）

| 学習件数 | 全体 | 日本語 | 日本語 negative の再現率 | 英語 |
|---:|---:|---:|---:|---:|
| 1000 | 66.6% | 70.3% | 52.8% | 65.7% |
| 2000 | 68.6% | 69.9% | 51.2% | 68.1% |
| 4000 | 71.0% | 71.6% | 53.6% | 71.1% |
| 8000 | 72.6% | 71.7% | 50.4% | 73.0% |
| 12612 | 73.3% | 72.6% | 48.8% | 73.6% |

## all（3166 件）

一致率 73.3%、macro F1 0.728

| LLM \ 分類器 | negative | neutral | positive | 再現率 | 適合率 |
|---|---:|---:|---:|---:|---:|
| negative | 552 | 181 | 77 | 68.1% | 73.6% |
| neutral | 152 | 1086 | 171 | 77.1% | 73.1% |
| positive | 46 | 219 | 682 | 72.0% | 73.3% |

| 確信度しきい値 | 分類器で決める割合 | LLM に回す割合 | 決めた分の一致率 | LLM 併用時の一致率 | negative の取りこぼし |
|---:|---:|---:|---:|---:|---:|
| 0 | 100.0% | 0.0% | 73.3% | 73.3% | 31.9% |
| 0.5 | 89.0% | 11.0% | 77.1% | 79.6% | 22.7% |
| 0.6 | 70.0% | 30.0% | 82.8% | 87.9% | 14.3% |
| 0.7 | 52.4% | 47.6% | 88.1% | 93.7% | 7.0% |
| 0.8 | 34.5% | 65.5% | 92.3% | 97.3% | 3.2% |
| 0.85 | 26.1% | 73.9% | 93.8% | 98.4% | 1.9% |
| 0.9 | 16.4% | 83.6% | 95.8% | 99.3% | 0.7% |
| 0.95 | 7.4% | 92.6% | 98.3% | 99.9% | 0.1% |

## 日本語（788 件）

一致率 72.6%、macro F1 0.687

| LLM \ 分類器 | negative | neutral | positive | 再現率 | 適合率 |
|---|---:|---:|---:|---:|---:|
| negative | 61 | 44 | 20 | 48.8% | 64.9% |
| neutral | 26 | 240 | 67 | 72.1% | 71.4% |
| positive | 7 | 52 | 271 | 82.1% | 75.7% |

| 確信度しきい値 | 分類器で決める割合 | LLM に回す割合 | 決めた分の一致率 | LLM 併用時の一致率 | negative の取りこぼし |
|---:|---:|---:|---:|---:|---:|
| 0 | 100.0% | 0.0% | 72.6% | 72.6% | 51.2% |
| 0.5 | 89.7% | 10.3% | 75.4% | 77.9% | 40.0% |
| 0.6 | 69.8% | 30.2% | 81.5% | 87.1% | 28.8% |
| 0.7 | 50.6% | 49.4% | 89.0% | 94.4% | 10.4% |
| 0.8 | 34.1% | 65.9% | 92.9% | 97.6% | 6.4% |
| 0.85 | 25.3% | 74.7% | 95.0% | 98.7% | 2.4% |
| 0.9 | 15.1% | 84.9% | 98.3% | 99.7% | 0.8% |
| 0.95 | 5.8% | 94.2% | 100.0% | 100.0% | 0.0% |

## English（2109 件）

一致率 73.6%、macro F1 0.729

| LLM \ 分類器 | negative | neutral | positive | 再現率 | 適合率 |
|---|---:|---:|---:|---:|---:|
| negative | 452 | 121 | 50 | 72.6% | 75.0% |
| neutral | 116 | 741 | 94 | 77.9% | 73.9% |
| positive | 35 | 141 | 359 | 67.1% | 71.4% |

| 確信度しきい値 | 分類器で決める割合 | LLM に回す割合 | 決めた分の一致率 | LLM 併用時の一致率 | negative の取りこぼし |
|---:|---:|---:|---:|---:|---:|
| 0 | 100.0% | 0.0% | 73.6% | 73.6% | 27.4% |
| 0.5 | 89.1% | 10.9% | 77.7% | 80.1% | 18.9% |
| 0.6 | 69.9% | 30.1% | 83.3% | 88.3% | 11.2% |
| 0.7 | 53.1% | 46.9% | 88.1% | 93.7% | 6.1% |
| 0.8 | 34.8% | 65.2% | 92.4% | 97.3% | 2.4% |
| 0.85 | 26.4% | 73.6% | 93.9% | 98.4% | 1.6% |
| 0.9 | 16.6% | 83.4% | 95.4% | 99.2% | 0.6% |
| 0.95 | 7.9% | 92.1% | 98.2% | 99.9% | 0.2% |

## other（269 件）

一致率 72.9%、macro F1 0.713

| LLM \ 分類器 | negative | neutral | positive | 再現率 | 適合率 |
|---|---:|---:|---:|---:|---:|
| negative | 39 | 16 | 7 | 62.9% | 73.6% |
| neutral | 10 | 105 | 10 | 84.0% | 71.4% |
| positive | 4 | 26 | 52 | 63.4% | 75.4% |

| 確信度しきい値 | 分類器で決める割合 | LLM に回す割合 | 決めた分の一致率 | LLM 併用時の一致率 | negative の取りこぼし |
|---:|---:|---:|---:|---:|---:|
| 0 | 100.0% | 0.0% | 72.9% | 72.9% | 37.1% |
| 0.5 | 85.9% | 14.1% | 77.5% | 80.7% | 25.8% |
| 0.6 | 70.6% | 29.4% | 82.1% | 87.4% | 16.1% |
| 0.7 | 52.0% | 48.0% | 85.0% | 92.2% | 9.7% |
| 0.8 | 33.8% | 66.2% | 90.1% | 96.7% | 4.8% |
| 0.85 | 26.8% | 73.2% | 90.3% | 97.4% | 3.2% |
| 0.9 | 18.2% | 81.8% | 91.8% | 98.5% | 1.6% |
| 0.95 | 7.8% | 92.2% | 95.2% | 99.6% | 0.0% |

## 人手ラベル（predefinedReplyEvaluationCases.json の3値 48 件）

- 分類器: 44/48
- 今の LLM: 47/48

| id | 言語 | 正解 | 分類器 | 確信度 | LLM |
|---|---|---|---|---:|---|
| ja-negative-01 | 日本語 | negative | negative | 0.96 | negative |
| ja-negative-02 | 日本語 | negative | negative | 0.88 | negative |
| ja-negative-03 | 日本語 | negative | negative | 0.81 | negative |
| ja-negative-04 | 日本語 | negative | negative | 0.94 | negative |
| ja-negative-05 | 日本語 | negative | negative | 0.96 | negative |
| ja-negative-06 | 日本語 | negative | negative | 0.43 | negative |
| ja-negative-07 | 日本語 | negative | negative | 0.62 | negative |
| ja-negative-08 | 日本語 | negative | negative | 0.51 | negative |
| ja-negative-09 | 日本語 | negative | negative | 0.99 | negative |
| ja-negative-10 | 日本語 | negative | positive | 0.81 | negative |
| ja-neutral-01 | 日本語 | neutral | neutral | 0.91 | neutral |
| ja-neutral-02 | 日本語 | neutral | neutral | 0.80 | neutral |
| ja-neutral-03 | 日本語 | neutral | neutral | 0.56 | neutral |
| ja-neutral-04 | 日本語 | neutral | neutral | 0.50 | neutral |
| ja-neutral-05 | 日本語 | neutral | neutral | 0.97 | neutral |
| ja-neutral-06 | 日本語 | neutral | neutral | 0.91 | neutral |
| ja-neutral-07 | 日本語 | neutral | neutral | 0.55 | neutral |
| ja-neutral-08 | 日本語 | neutral | neutral | 0.85 | neutral |
| ja-neutral-09 | 日本語 | neutral | neutral | 0.58 | positive |
| ja-neutral-10 | 日本語 | neutral | neutral | 0.61 | neutral |
| ja-positive-01 | 日本語 | positive | positive | 0.99 | positive |
| ja-positive-02 | 日本語 | positive | positive | 1.00 | positive |
| ja-positive-03 | 日本語 | positive | negative | 0.70 | positive |
| ja-positive-04 | 日本語 | positive | positive | 0.96 | positive |
| ja-positive-05 | 日本語 | positive | positive | 1.00 | positive |
| ja-positive-06 | 日本語 | positive | positive | 0.95 | positive |
| ja-positive-07 | 日本語 | positive | positive | 0.85 | positive |
| ja-positive-08 | 日本語 | positive | positive | 0.61 | positive |
| ja-positive-09 | 日本語 | positive | neutral | 0.63 | positive |
| ja-positive-10 | 日本語 | positive | positive | 0.85 | positive |
| en-negative-01 | English | negative | negative | 0.96 | negative |
| en-negative-02 | English | negative | negative | 0.71 | negative |
| en-negative-03 | English | negative | negative | 0.85 | negative |
| en-negative-04 | English | negative | negative | 0.72 | negative |
| en-negative-05 | English | negative | negative | 0.67 | negative |
| en-negative-06 | English | negative | negative | 0.77 | negative |
| en-neutral-01 | English | neutral | neutral | 0.97 | neutral |
| en-neutral-02 | English | neutral | neutral | 0.75 | neutral |
| en-neutral-03 | English | neutral | negative | 0.85 | neutral |
| en-neutral-04 | English | neutral | neutral | 0.43 | neutral |
| en-neutral-05 | English | neutral | neutral | 0.76 | neutral |
| en-neutral-06 | English | neutral | neutral | 0.87 | neutral |
| en-positive-01 | English | positive | positive | 1.00 | positive |
| en-positive-02 | English | positive | positive | 0.94 | positive |
| en-positive-03 | English | positive | positive | 0.93 | positive |
| en-positive-04 | English | positive | positive | 0.94 | positive |
| en-positive-05 | English | positive | positive | 0.98 | positive |
| en-positive-06 | English | positive | positive | 0.98 | positive |

