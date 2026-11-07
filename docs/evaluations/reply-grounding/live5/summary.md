# reply-grounding: live5

model: hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL
updated: 2026-11-07T05:35:05.461Z

## ③ 選択（本番の知識カード）

- ジャンルのある投稿 25件に入ったカード: 0枚
- うちジャンル違い: -
- ジャンル違いが1枚以上入った投稿: 0% (0/25)
- 対照の投稿 8件に入ったカード: 0枚

| case | カード（✗=ジャンル違い） |
|---|---|
| ygo-ra-lemon | - |
| ygo-md-lemon-shark | - |
| ygo-ra-pumpup | - |
| ygo-ra-kc-mirror | - |
| ygo-ra-chant | - |
| ygo-ra-revive | - |
| ygo-power-word | - |
| ygo-ice-barrier-trishula | - |
| ygo-ice-barrier-lock | - |
| ygo-poltergeist | - |
| ygo-riding-duel | - |
| ygo-hero-handes | - |
| ygo-jack-lemon | - |
| ygo-playmat | - |
| ygo-ra-ancient-spell | - |
| ygo-kaiju-grydle | - |
| ygo-galaxy-eyes-moon | - |
| ygo-blackwing | - |
| ygo-card-gunner | - |
| ygo-c-duel-answer | - |
| ygo-c-stardust-chant | - |
| ygo-c-kaiba-two-hits | - |
| ygo-c-ra-original | - |
| dm-duepre | - |
| ctl-lemon-sour | - |
| ctl-sake-lemon-sour | - |
| ctl-made-in-abyss | - |
| ctl-tensei-ken | - |
| ctl-anki-oss | - |
| ctl-pokeca | - |
| ctl-rice-cooker | - |
| ctl-moss-image | - |
| ctl-3d-display | - |

## わかってる度・捏造の疑い（live）

- わかってる度（投稿に無く材料にある語を1つ以上含む返信）: ジャンルあり 8% (6/75) / 全体 7% (7/99)
- 捏造の疑い（投稿にも材料にも無い固有名詞らしい語を含む返信）: 12% (12/99)
- 出所の分からない語（多い順）: ブースト×2 / バーン飛んでくる!×1 / フレンズ×1 / パワーバランス×1 / ショック×1 / ワンシーン×1 / Deck×1 / リラックスタイム×1 / チャージ×1 / Pressure×1 / アンテナ×1
- 材料から出した語（多い順）: オフィシャルカードゲーム×1 / このカードは通常召喚できない。×1 / カードテキスト×1 / ホイール×1 / ARC×1 / ジャック・アトラス×1 / アトラス×1 / ギャラクシーアイズ・フォトン・ドラゴン×1 / ジョジョ×1

## その場調べ（申告 → 調べる → 生成）

- 語の申告があった投稿: ジャンルあり 100% (25/25) / 対照 100% (8/8)
- 申告にジャンルが正しく付いた語（ジャンルありの投稿）: 92% (47/51)
- Wikipedia で取れた材料（ジャンルありの投稿）: 21枚、うちジャンルが正しい 90% (19/21)
- 材料が1枚以上入った投稿（ジャンルあり）: 92% (23/25)
- ジャンル違いで外した既存のカード: トリシューラ / ショックルーラー / ポルターガイスト
- 締め切り超過: 0件
- 調べる時間: 中央値 1682ms / p90 1983ms（語ありの投稿だけ: 中央値 1682ms）
- 生成: 中央値 2222ms / p90 4017ms
- **合計（調べる＋生成）: 中央値 3967ms / p90 5853ms**

| case | 申告（語/ジャンル） | 材料（✗=ジャンル違い） | 外した既存カード | 調べる時間 |
|---|---|---|---|---|
| ygo-ra-lemon | スカノヴァ/遊戯王, ニビル/遊戯王, シャーク/遊戯王 | 遊戯王(M) | - | 1732ms |
| ygo-md-lemon-shark | レモン/遊戯王, シャーク/遊戯王 | シャーク(W), 遊戯王(M) | - | 1635ms |
| ygo-ra-pumpup | ラー/遊戯王, パンプアップ/遊戯王 | ラー(W), 遊戯王(M) | - | 1574ms |
| ygo-ra-kc-mirror | KCカップ/モンハンワールド, ラー/モンハンワールド, 不死鳥/モンハンワールド | ✗ラー(W) | - | 1924ms |
| ygo-ra-chant | ラーの翼神竜/遊戯王, ゴッド・ブレイズ・キャノン/遊戯王 | ラーの翼神竜(W), ゴッド・ブレイズ・キャノン(M), 遊戯王(M) | - | 1656ms |
| ygo-ra-revive | 神は死者蘇生/遊戯王, 不死鳥になれるラー/遊戯王, ラーの翼神竜/遊戯王 | 遊戯王(M) | - | 2083ms |
| ygo-power-word | 特殊召喚/遊戯王OCG, サポカ/遊戯王OCG | 特殊召喚(W), 遊戯王OCG(M) | - | 1687ms |
| ygo-ice-barrier-trishula | 氷水/遊戯王, トリシューラ/遊戯王, ガーディアンスライム/遊戯王 | 遊戯王(M) | トリシューラ | 2001ms |
| ygo-ice-barrier-lock | KCカップ/遊戯王, スキルドレイン/遊戯王 | KCカップ(W), スキルドレイン(W), 遊戯王(M) | - | 1627ms |
| ygo-poltergeist | ポルターガイスト/遊戯王, 速攻魔法/遊戯王, ショックルーラー/遊戯王 | 遊戯王(M) | ショックルーラー, ポルターガイスト | 1959ms |
| ygo-riding-duel | ライディングデュエル/遊戯王 | ライディングデュエル(W), 遊戯王(M) | - | 1267ms |
| ygo-hero-handes | HERO/遊戯王, ヴィラン/遊戯王, シャイニングネオスウィングマン/遊戯王 | HERO(W), ✗ヴィラン(W), 遊戯王(M) | - | 1950ms |
| ygo-jack-lemon | リゾネーター/遊戯王, レモン/遊戯王, ニビル/遊戯王 | リゾネーター(W), 遊戯王(M) | - | 1983ms |
| ygo-playmat | ラーの翼神竜/遊戯王 | ラーの翼神竜(W), 遊戯王(M) | - | 1281ms |
| ygo-ra-ancient-spell | ラー/遊戯王, ゴッドスライム/遊戯王, ラーの翼神竜/遊戯王 | ラー(W), ゴッドスライム(M), ラーの翼神竜(W), 遊戯王(M) | - | 1969ms |
| ygo-kaiju-grydle | 壊獣グレイドル/遊戯王 | 遊戯王(M) | - | 1451ms |
| ygo-galaxy-eyes-moon | ギャラクシーアイズ/遊戯王, ZEXAL/遊戯王 | ギャラクシーアイズ(W), ZEXAL(M), 遊戯王(M) | - | 1701ms |
| ygo-blackwing | 黒き旋風/遊戯王, シンクロ召喚/遊戯王, BF－アーマード・ウィング/遊戯王 | 黒き旋風(W), シンクロ召喚(W), 遊戯王(M) | - | 2085ms |
| ygo-card-gunner | カードガンナー/遊戯王, ラッシュデュエル/遊戯王 | ラッシュデュエル(M), 遊戯王(M) | - | 1656ms |
| ygo-c-duel-answer | デュエル/遊戯王 | デュエル(W), 遊戯王(M) | - | 1365ms |
| ygo-c-stardust-chant | ラーの翼神竜/遊戯王 | ラーの翼神竜(W), 遊戯王(M) | - | 1379ms |
| ygo-c-kaiba-two-hits | 海馬/遊戯王 | 海馬(W), 遊戯王(M) | - | 1234ms |
| ygo-c-ra-original | ラー/遊戯王 | ラー(W), 遊戯王(M) | - | 1231ms |
| dm-duepre | STﾓﾘﾓﾘデッキ/デュエルマスターズ | - | - | 1315ms |
| ctl-lemon-sour | レモンサワー/, 檸檬堂/, 氷結/ | レモンサワー(W), 檸檬堂(M), 氷結(M) | - | 1798ms |
| ctl-sake-lemon-sour | 日本酒/, 焼酎/, 無糖レモンサワー/ | 日本酒(W), 焼酎(W) | - | 1844ms |
| ctl-made-in-abyss | 目覚める神秘/メイドインアビス | 目覚める神秘(W), メイドインアビス(M) | - | 1318ms |
| ctl-tensei-ken | 怨念炉/転生したら剣でした, スキルテイカー/転生したら剣でした, 時空魔術/転生したら剣でした | スキルテイカー(W), 転生したら剣でした(M) | - | 1962ms |
| ctl-anki-oss | Anki/, DIO/ジョジョの奇妙な冒険 | Anki(M), DIO(W) | - | 1680ms |
| ctl-pokeca | ピカチュウex/VMAX/ポケモンカード, 欲張りデッキ/ポケモンカード | - | - | 1682ms |
| ctl-rice-cooker | 圧力タイプの炊飯器/, シャケ召喚/ | - | - | 1621ms |
| ctl-moss-image | MOSS-image/, LoRA/, botたん/ | LoRA(W) | - | 1845ms |
| ctl-3d-display | 民生3Dディスプレイ/, Looking Glass Go/, アクティブ方式/ | Looking Glass Go(M), アクティブ方式(W) | - | 1787ms |
