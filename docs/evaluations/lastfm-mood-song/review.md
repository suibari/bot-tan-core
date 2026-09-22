# Last.fm mood-song PoC

実施日: 2026-09-23

本番botたんの直近フィードから、おやすみポストと質問ポストを除いた定期ポスト8件を使用した。
経路は「ローカルLLMで許可リスト内のタグを分類 → `tag.getTopTracks` → 重み付き抽選候補12曲 →
`track.getInfo`を使ったローカルLLM安全・適合性ゲート → YouTube照合 → ローカルLLM紹介文」。

## 最終試行

| タグ | 選出曲 | 評価 |
|---|---|---|
| night / relaxing / happy | The Way You Look Tonight — Michael Bublé | 良好。幸せで穏やかな夜に合う |
| sunny / cheerful / uplifting | Bicycle Song — Red Hot Chili Peppers | 許容。明るさは合うが、投稿との結びつきは弱め |
| study / peaceful / rainy day | Wonderful Life — Gwen Stefani | 許容。穏やかさは合うが、勉強・雨との結びつきは弱め |
| relaxing / chill / happy | Primavera — Ludovico Einaudi | 良好。休日の落ち着いた鑑賞時間に合う |
| happy / chill / night | Send Me On My Way — Rusted Root | 良好。充実した休日と前向きな気分に合う |
| relaxing / chill / rainy day | Sweater Weather — The Neighbourhood | 良好。雨の日のカフェに合う |
| happy / cheerful / feel good | The Stars — Algernon Cadwallader | 良好。友達との楽しい時間に合う |
| happy / peaceful / chill | Drifting — Suzanne Ciani | 良好。穏やかな会話の余韻に合う |

- YouTube確認成功: 8/8
- 明確に危険なテーマの選出: 0/8
- 主観評価: 良好6件、許容2件
- 所要時間: 平均5.9秒、最短4.5秒、最長13.3秒

## 試行中に分かったこと

初期版では、Last.fm上で`happy`タグが付く「Pumped Up Kicks」が明るいカフェ投稿に選ばれた。
タグは音の印象を表していても歌詞テーマを保証しないため、タグ取得だけでの本番採用は危険だった。

候補ごとの`track.getInfo`（Wiki概要・上位タグ・リスナー数）を安全ゲートへ渡すことで、最終試行では
重大な不一致が消えた。情報がない未知の曲は安全ゲートで除外する。最終的な1曲はLLMに決めさせず、
ゲートを通った集合からコード側の重み付き抽選で決める。

品質は完全ではなく、Last.fmのユーザータグ由来の意外な選曲は残る。ただし変化として許容できる範囲で、
障害時にはローカル検査済みのbot memoryだけへフォールバックする。Gemini経路は課金事故を
避けるため削除した。

生データは `latest-v3.json`。`latest.json`と`latest-v2.json`は安全ゲート改善前の比較用ログ。

## 言語別プールの再試行

日本語定期ポスト4件と英語定期ポスト2件で再実行した結果、日本語側は「光」「ブルーバード」
「First Love」、英語側は「Song for the Baby」「Wasting Time」となり、6/6件で指定側の
言語の曲になった。評価スクリプトはサンプル間で選出履歴を保存しないため「ブルーバード」が
2回出たが、本番経路ではDBの30日履歴により除外される。生データは`language-split.json`。
