# reply-grounding: baseline

model: hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL
updated: 2026-11-06T22:33:55.701Z

## ③ 選択（本番の知識カード）

- ジャンルのある投稿 25件に入ったカード: 16枚
- うちジャンル違い: 31% (5/16)
- ジャンル違いが1枚以上入った投稿: 20% (5/25)
- 対照の投稿 8件に入ったカード: 6枚

| case | カード（✗=ジャンル違い） |
|---|---|
| ygo-ra-lemon | - |
| ygo-md-lemon-shark | - |
| ygo-ra-pumpup | - |
| ygo-ra-kc-mirror | - |
| ygo-ra-chant | ゴッド・ブレイズ・キャノン |
| ygo-ra-revive | ✗不死鳥 |
| ygo-power-word | - |
| ygo-ice-barrier-trishula | ✗トリシューラ |
| ygo-ice-barrier-lock | - |
| ygo-poltergeist | ショックルーラー / ✗ポルターガイスト |
| ygo-riding-duel | - |
| ygo-hero-handes | - |
| ygo-jack-lemon | ✗ジャック |
| ygo-playmat | 遊戯王 |
| ygo-ra-ancient-spell | ゴッド・ブレイズ・キャノン / ゴッドスライム |
| ygo-kaiju-grydle | - |
| ygo-galaxy-eyes-moon | ✗月面で決闘 / ZEXAL |
| ygo-blackwing | - |
| ygo-card-gunner | ラッシュデュエル / 遊戯王OCG |
| ygo-c-duel-answer | - |
| ygo-c-stardust-chant | - |
| ygo-c-kaiba-two-hits | - |
| ygo-c-ra-original | - |
| dm-duepre | デュエプレ |
| ctl-lemon-sour | 檸檬堂 / レモン |
| ctl-sake-lemon-sour | - |
| ctl-made-in-abyss | メイドインアビス目覚める神秘 / メイドインアビス |
| ctl-tensei-ken | 転生したら剣でした2期 |
| ctl-anki-oss | Anki |
| ctl-pokeca | ピカチュウex / ピカチュウ |
| ctl-rice-cooker | - |
| ctl-moss-image | - |
| ctl-3d-display | - |

## ① 申告（1回目の生成）

- 生成 99回（失敗 0）、平均 2539ms
- 申告のあった生成: 0% (0/99)
- 申告された語（延べ）: 0、文っぽいもの: -

## ② 調査

- 調べた語: 27、成功: 37% (10/27)
- 文っぽい語の成功率: 0% (0/1)
- 語らしい語の成功率: 38% (10/26)
- ジャンル判定できたカードのうちジャンル違い: 57% (4/7)

| 語 | 結果 | 申告元 |
|---|---|---|
| ラー玉 | 失敗: research found no material about the subject | ygo-ra-lemon |
| ニビル | 失敗: research found no material about the subject | ygo-ra-lemon |
| スカノヴァ | 失敗: research found no material about the subject | ygo-ra-lemon |
| マスターデュエル | ○ | ygo-md-lemon-shark |
| ラーの翼神竜 | 失敗: research found no material about the subject | ygo-ra-pumpup |
| KCカップ | 失敗: research found no material about the subject | ygo-ra-kc-mirror |
| ゴッド・ブレイズ・キャノン | 失敗: research found no material about the subject | ygo-ra-chant |
| 死者蘇生 | 失敗: research found no material about the subject | ygo-ra-revive |
| トリシューラ | ✗ジャンル違い | ygo-ice-barrier-trishula |
| 氷水 | ✗ジャンル違い | ygo-ice-barrier-trishula |
| スキルドレイン | 失敗: research found no material about the subject | ygo-ice-barrier-lock |
| ポルターガイスト | ✗ジャンル違い | ygo-poltergeist |
| ショックルーラー | 失敗: research found no material about the subject | ygo-poltergeist |
| ライディングデュエル | 失敗: research found no material about the subject | ygo-riding-duel |
| シャイニング・ネオス・ウィングマン 〔文〕 | 失敗: research found no material about the subject | ygo-hero-handes |
| リゾネーター | ✗ジャンル違い | ygo-jack-lemon |
| 古の呪文 | 失敗: research found no material about the subject | ygo-ra-ancient-spell |
| ゴッドスライム | ○ | ygo-ra-ancient-spell |
| 壊獣 | 失敗: research found no material about the subject | ygo-kaiju-grydle |
| グレイドル | 失敗: research found no material about the subject | ygo-kaiju-grydle |
| ギャラクシーアイズ | 失敗: research found no material about the subject | ygo-galaxy-eyes-moon |
| BF－アーマード・ウィング | 失敗: research found no material about the subject | ygo-blackwing |
| カードガンナー | 失敗: research found no material about the subject | ygo-card-gunner |
| デュエプレ | ○ | dm-duepre |
| メイドインアビス 目覚める神秘 | ok | ctl-made-in-abyss |
| Anki | ok | ctl-anki-oss |
| MOSS-image | ok | ctl-moss-image |

## わかってる度・捏造の疑い（reply）

- わかってる度（投稿に無く材料にある4文字以上の連なりを含む返信）: ジャンルあり 3% (2/75) / 全体 4% (4/99)
- 捏造の疑い（投稿にも材料にも無い固有名詞らしい語を含む返信）: 7% (7/99)
- 出所の分からない語（多い順）: デュエルモンスターズ×2 / パーツを増やさないと×1 / これワンチャン作るために......×1 / nun×1 / らしさ×1 / ショック×1
- 材料から出した語（多い順）: オープンソース×2 / デュエリスト×1 / 宿敵同士×1 / 地球を挟んで対峙×1
