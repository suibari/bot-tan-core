# reply-grounding: live8

model: hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL
updated: 2026-11-08T12:55:00.567Z

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

- わかってる度（投稿に無く材料にある4文字以上の連なりを含む返信）: ジャンルあり 19% (14/74) / 全体 19% (19/98)
- 捏造の疑い（投稿にも材料にも無い固有名詞らしい語を含む返信）: 16% (16/98)
- 出所の分からない語（多い順）: ショック×2 / Deck×1 / デッキビルド×1 / ステップ×1 / SHARP×1 / ナンバーワン×1 / ツッコミ×1 / ブースト×1 / シリアス×1 / ユーモアセンス×1 / ギリギリ×1 / ハッピー×1 / チャージ×1 / Pressure×1 / クリエイター×1 / スマート×1
- 材料から出した語（多い順）: ラーの翼神竜×4 / KCカップ×3 / ネオ童実野シティ×2 / コントロール×2 / レモンの風味×2 / 自分のデッキ×1 / 闇遊戯vs闇マリク戦×1 / 攻撃力アップ×1 / 召喚成功時×1 / LPを払×1 / 豊かな自然×1 / リコたちがアビスの深界七層×1 / 足を踏み入れる冒険×1 / アビスの深界七層×1 / 挑む物語×1

## その場調べ（申告 → 調べる → 生成）

- 語の申告があった投稿: ジャンルあり 96% (24/25) / 対照 100% (8/8)
- 申告にジャンルが正しく付いた語（ジャンルありの投稿）: 92% (44/48)
- その場で取れた材料（ジャンルありの投稿）: 26枚（Wikipedia 4 / Web 22）、うちジャンルが正しい 96% (25/26)
- 材料が1枚以上入った投稿（ジャンルあり）: 92% (23/25)
- ジャンル違いで外した既存のカード: トリシューラ / ショックルーラー / ポルターガイスト
- 締め切り超過: 6件
- 調べる時間: 中央値 4394ms / p90 6002ms（語ありの投稿だけ: 中央値 4394ms）
- 生成: 中央値 4244ms / p90 6901ms
- **合計（調べる＋生成）: 中央値 8996ms / p90 11394ms**

| case | 申告（語/ジャンル） | 材料（W=Wikipedia S=Web M=記憶、✗=ジャンル違い） | 外した既存カード | 調べる時間 |
|---|---|---|---|---|
| ygo-ra-lemon | スカノヴァ/遊戯王, ニビル/遊戯王, シャーク/遊戯王 | スカノヴァ(S), 遊戯王(M) | - | 2987ms |
| ygo-md-lemon-shark | レモン/遊戯王, シャーク/遊戯王 | レモン(S), シャーク(W), 遊戯王(M) | - | 3843ms |
| ygo-ra-pumpup | ラー/遊戯王, パンプアップ/遊戯王 | ラー(S), 遊戯王(M) | - | 2415ms |
| ygo-ra-kc-mirror | KCカップ/モンハンワールド, ラー/モンハンワールド, 不死鳥/モンハンワールド | - | - | 6006ms⏱ |
| ygo-ra-chant | ラーの翼神竜/遊戯王, ゴッド・ブレイズ・キャノン/遊戯王 | ラーの翼神竜(S), ゴッド・ブレイズ・キャノン(M), 遊戯王(M) | - | 2471ms |
| ygo-ra-revive | 神は死者蘇生/遊戯王, 不死鳥になれるラー/遊戯王, ラーの翼神竜/遊戯王 | 神は死者蘇生(S), 遊戯王(M) | - | 6002ms⏱ |
| ygo-power-word | 特殊召喚/遊戯王OCG, サポカ/遊戯王OCG | 特殊召喚(S), 遊戯王OCG(M) | - | 2531ms |
| ygo-ice-barrier-trishula | 氷水/遊戯王, トリシューラ/遊戯王, ガーディアンスライム/遊戯王 | 氷水(S), 遊戯王(M) | トリシューラ | 6002ms⏱ |
| ygo-ice-barrier-lock | KCカップ/遊戯王, スキルドレイン/遊戯王 | KCカップ(S), スキルドレイン(W), 遊戯王(M) | - | 4610ms |
| ygo-poltergeist | ポルターガイスト/遊戯王, 速攻魔法/遊戯王, ショックルーラー/遊戯王 | ポルターガイスト(S), 遊戯王(M) | ショックルーラー, ポルターガイスト | 6001ms⏱ |
| ygo-riding-duel | ライディングデュエル/遊戯王 | ライディングデュエル(S), 遊戯王(M) | - | 2174ms |
| ygo-hero-handes | HERO/遊戯王, ヴィラン/遊戯王, シャイニングネオスウィングマン/遊戯王 | HERO(S), ✗ヴィラン(W), 遊戯王(M) | - | 4474ms |
| ygo-jack-lemon | リゾネーター/遊戯王, レモン/遊戯王, ニビル/遊戯王 | リゾネーター(S), 遊戯王(M) | - | 5143ms |
| ygo-playmat | ラーの翼神竜/遊戯王 | ラーの翼神竜(S), 遊戯王(M) | - | 3767ms |
| ygo-ra-ancient-spell | ラー/遊戯王, ゴッドスライム/遊戯王, ラーの翼神竜/遊戯王 | ラー(S), ゴッドスライム(M), ラーの翼神竜(W), 遊戯王(M) | - | 4393ms |
| ygo-kaiju-grydle | 壊獣グレイドル/遊戯王 | 壊獣グレイドル(S), 遊戯王(M) | - | 5337ms |
| ygo-galaxy-eyes-moon | ギャラクシーアイズ/遊戯王, ZEXAL/遊戯王 | ギャラクシーアイズ(S), ZEXAL(M), 遊戯王(M) | - | 5195ms |
| ygo-blackwing | BF－アーマード・ウィング/遊戯王 | 遊戯王(M) | - | 6002ms⏱ |
| ygo-card-gunner | カードガンナー/遊戯王, ラッシュデュエル/遊戯王 | カードガンナー(S), ラッシュデュエル(M), 遊戯王(M) | - | 4613ms |
| ygo-c-duel-answer | - | - | - | 6001ms⏱ |
| ygo-c-stardust-chant | ラーの翼神竜/遊戯王 | ラーの翼神竜(S), 遊戯王(M) | - | 3952ms |
| ygo-c-kaiba-two-hits | 海馬/遊戯王 | 海馬(S), 遊戯王(M) | - | 4394ms |
| ygo-c-ra-original | ラー/遊戯王 | ラー(S), 遊戯王(M) | - | 4493ms |
| dm-duepre | STﾓﾘﾓﾘデッキ/デュエルマスターズ | STﾓﾘﾓﾘデッキ(S) | - | 4215ms |
| ctl-lemon-sour | レモンサワー/, 檸檬堂/, 氷結/ | レモンサワー(M), 檸檬堂(M), 氷結(M) | - | 4254ms |
| ctl-sake-lemon-sour | 日本酒/, 焼酎/, 無糖レモンサワー/ | 日本酒(S), 焼酎(W) | - | 5542ms |
| ctl-made-in-abyss | 目覚める神秘/メイドインアビス | 目覚める神秘(M), メイドインアビス(M) | - | 3250ms |
| ctl-tensei-ken | 怨念炉/転生したら剣でした, スキルテイカー/転生したら剣でした, 時空魔術/転生したら剣でした | 怨念炉(S), 転生したら剣でした(M) | - | 5746ms |
| ctl-anki-oss | Anki/, DIO/ジョジョの奇妙な冒険 | Anki(M), DIO(S) | - | 5351ms |
| ctl-pokeca | ピカチュウex/VMAX/ポケモンカード, 欲張りデッキ/ポケモンカード | ピカチュウex/VMAX(S) | - | 2440ms |
| ctl-rice-cooker | 圧力タイプの炊飯器/, シャケ召喚/ | - | - | 4243ms |
| ctl-moss-image | MOSS-image/, LoRA/, botたん/ | MOSS-image(S), LoRA(W) | - | 2521ms |
| ctl-3d-display | 民生3Dディスプレイ/, Looking Glass Go/, アクティブ方式/ | Looking Glass Go(M), アクティブ方式(W) | - | 2587ms |
