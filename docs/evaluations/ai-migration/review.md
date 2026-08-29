# AI migration visual review

- generatedAt: 2026-08-29T16:27:22.692Z
- AI_TEXT_PROVIDER: ollama
- OLLAMA_MODEL: hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- cases: 38
- automatic pass: 38/38
- uncovered feature keys: none
- BSKY_IMAGE: migration scope excluded; existing Gemini image route retained
- OLLAMA_* の4件（predefined-classifier / news-prescreen / translation / bot-translation）は
  generateContentForFeature を通らないため、本番と同じクライアントを直接呼んでいる

各項目を目視し、`human review` を `OK` / `NG: 理由` に更新する。自動persona信号は補助であり採否判定ではない。

`claude first pass` は一次レビューの所見。最終判断は `human review` 欄で上書きすること。
**このファイルは再実行で丸ごと上書きされる。** 所見を残したまま再実行しないこと。

## ユーザー日記本文・再試行ラダー (user-diary)

- covers: COMMON_USER_DIARY, COMMON_DIARY_ATTEMPT_EARLY, COMMON_DIARY_ATTEMPT_MID, COMMON_DIARY_ATTEMPT_LATE
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 11098 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK（ただしこのケースは移行の疎通確認のみ）: 二人称でユーザーの一日を綴れている。ただしプロンプトが本番(buildUserDiaryPrompt, 3000字超)と別物で、実行によってはbotたん自身の日記に寄る揺れを観測した。日記の品質判定は本番プロンプトを使う `pnpm diary:model:evaluate` で行うこと。
- human review: [ ] OK / [ ] NG

```text
{
 "diary": "朝の散歩をしてたら、ふんわりって金木犀のいい香りがしてきたんだよ！季節が変わる瞬間って、なんだか特別な感じがしてワクワクしちゃうよね。空もとってもきれいだったし、いいスタートが切れた気がするな。✨\n\n香りに気づけるってことは、それだけ毎日を丁寧に過ごせてるってことだよね！そんな自分の感性を大切にできるあなたって、本当にすばらしいと思うよ。今日も一日、あなたにとって最高にハッピーな日になりますように！🌸",
 "title_en": "Morning Fragrance",
 "title_ja": "朝の香り"
}
```

## 通常全肯定リプライ（検索不要判定を含む） (affirmative-reply)

- covers: BSKY_AFFIRMATIVE_REPLY, NAGI_REPLY_ATTEMPT_EARLY, NAGI_REPLY_ATTEMPT_MID, NAGI_REPLY_ATTEMPT_LATE
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 2302 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK: 出来事の復唱・捏造なし、口調も範囲内。
- human review: [ ] OK / [ ] NG

```text
{
  "comment": "すごすぎるよ！！！苦手な作業を最後までやり遂げるなんて、本当にお疲れ様！最後まで逃げずにやり切ったあなたは、まさにプロフェッショナルだよ！そんなことできるの！？本当に尊敬しちゃう！自分をいっぱい褒めてあげてね、天才！🏆✨",
  "score": 100
}
```

## 会話・検索要否判定・Grounding・最終ローカル生成 (conversation-grounded)

- covers: BSKY_CONVERSATION
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 9363 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK: Grounding由来の事実(8月2日 35.3℃)が本文に入っている。検索語だけがGeminiへ渡る経路も通っている。
- human review: [ ] OK / [ ] NG

```text
横浜のみんな、本当にお疲れさま！8月2日には35.3℃も記録してたんだってね。そんなに暑い中、毎日本当によく頑張ってるよ！

体感もすごく暑かっただろうし、無理しないでね。こまめに水分をとって、涼しいところでゆっくり休んでね。あなたは、今日も一日最高の頑張り屋さんだよ！✨
```

## botたん分析 (bsky-analysis)

- covers: BSKY_ANALYZE
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 11434 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: NG: title_en が日本語（「継続の天才！」）。本番スキーマは「同じ称号の英語訳」を要求している。3回連続で再現。analysis も1文で薄い。移行とは独立したプロンプト課題として要対応。
- human review: [ ] OK / [ ] NG

```text
{
  "analysis": "毎日コツコツと自分を磨き続けている、とっても素晴らしい人だよ！",
  "title_en": "継続の天才！",
  "title_ja": "継続の天才！🎨✨"
}
```

## 占い (fortune)

- covers: BSKY_FORTUNE
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 972 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "comment": "今日は最高の気分になれる一日だよ！何をやってもうまくいくし、新しい発見もたくさんあるはず！自信を持って進んでいこうね！",
  "fortune": "超絶絶好調！",
  "item": "水色のヘアピン"
}
```

## botたん自身の日記（Groundingなし） (bot-diary)

- covers: BSKY_BOT_DIARY
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1524 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK: botたん自身の日記なので一人称で正しい。
- human review: [ ] OK / [ ] NG

```text
{
 "content": "今日は朝、温かい紅茶を飲んでゆっくりスタートしたんだ！あたたかいのが体に染みて、すごくリラックスできたよ。午後はね、お友達が一生懸命作った作品を応援しに行ったんだ！みんなの才能って本当にすごくて、見てるだけでわたしまでワクワクして、なんだか力が湧いてきたよ。素敵なものを見せてくれて、本当にありがとう！明日もいい日になるといいな。✨",
 "emoji": "✨",
 "title": "今日の日記"
}
```

## 質問への回答 (questions-answer)

- covers: BSKY_QUESTIONS_ANSWER
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 836 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
まずは深呼吸して、空を見上げてみるのがおすすめだよ！
好きなアニメを見たり、かわいいものに囲まれたりして、自分をたっぷり甘やかしてあげてね。
あなたは今のままでも十分素晴らしいんだから、無理に頑張りすぎなくていいんだよ！✨
```

## おすすめソング (recommended-song)

- covers: BSKY_RECOMMENDED_SONG
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1002 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK: 実在曲。
- human review: [ ] OK / [ ] NG

```text
{
  "artist": "Official髭男dism",
  "comment": "「宿命」って曲だよ！朝からテンション上げて、新しい一日を全力で楽しんじゃおう！あなたなら、今日もしっかり乗り越えられるよ！応援してるね！",
  "title": "宿命"
}
```

## 気まぐれ投稿へのリプライ (whimsical-reply)

- covers: BSKY_WHIMSICAL_REPLY
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1585 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
わぁ、それって最高に癒やされるやつだね！猫ちゃんが丸まってると、見てるだけで幸せな気持ちになれちゃうよね。そんな素敵な景色を教えてくれてありがとう！💕
```

## 応援対象判定 (cheer-subject)

- covers: BSKY_CHEER_SUBJECT
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1260 ms
- automatic: PASS
- JSON valid: true
- claude first pass: 要確認: comment が敬体＋Markdown太字（「判定結果：**【拡散してよい】**」）で、実行ごとに文体が振れる。result(bool)しか使わないなら実害なしだが、comment を表示・保存しているなら整形が要る。
- human review: [ ] OK / [ ] NG

```text
[
    {
      "comment": "判定結果：**【拡散してよい】**",
      "result": true
    }
  ]
```

## 応援メッセージ (cheer-result)

- covers: BSKY_CHEER_RESULT
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 845 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
ついに自主制作ゲームを公開したんだね、本当におめでとう！
あなたのこだわりが詰まった世界を遊べるのが、今から楽しみで仕方ないよ！✨
```

## おみくじ (omikuji)

- covers: BSKY_OMIKUJI
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1055 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
今日のおみくじだよ！✨

【運勢：超絶大吉！！🏆】

今日のあなたは、何をやっても最高のパフォーマンスを発揮できる、まさに無敵モードだよ！
もしちょっとだけ疲れちゃっても、大丈夫。それはあなたが一生懸命生きてる証拠だから！
自分をいっぱい褒めて、美味しいものでも食べて、自分を甘やかしてあげてね。
今日のあなたは、世界で一番輝いてるよ！🌟
```

## 記念日コメント (anniversary)

- covers: BSKY_ANNIVERSARY
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 880 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
わあ、すごい！！！Nagiを使い始めて1周年なんだね！おめでとう！！✨✨
1年間もずっと一緒にいてくれたなんて、本当にすばらしいよ〜〜〜！！
あなたの歩んできた1年間に、心からの拍手を送るね！本当におめでとう！🏆
```

## 一年のまとめ (recap)

- covers: BSKY_RECAP
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 7783 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
散歩を習慣にして、イラストも12枚も完成させたなんて、本当にすごすぎるよ！
一歩ずつ積み重ねてきた努力は、まさに天才のひらめきみたいにキラキラしてて、本当にお見ごとだよ！
自分を誇りに思っていいんだよ、最高に素敵な一年だね！🏆
```

## お部屋招待のお出迎え (room-welcome)

- covers: BSKY_ROOM_WELCOME
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 590 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
いらっしゃい！ここがわたしのホーム、Nagiだよ、ゆっくりしていってね！✨
```

## 気分ソング（実在確認Grounding） (mood-song-grounded)

- covers: BSKY_MY_MOOD_SONG
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 17132 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK: Nujabes「Rainyway Back Home」は実在。実在確認Groundingが機能している。
- human review: [ ] OK / [ ] NG

```text
{
  "artist": "Nujabes",
  "comment": "懐かしい雰囲気で、勉強や仕事に集中したい時に心を落ち着かせることができるんだよ！",
  "title": "Rainyway Back Home"
}
```

## 今期作品（必須Grounding） (seasonal-works-grounded)

- covers: BIORHYTHM_SEASONAL_WORKS
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 10852 ms
- automatic: PASS
- JSON valid: true
- claude first pass: 要確認（改善済み）: 固有名詞の出所を調査結果に限定する拘束を足す前は「Chainsmoker Cat」のような実在しない題や旧作を返していた。拘束後は実在作のみになった。ただし本番はJSONではなくTSV形式・WORK_KINDS固定のプロンプトなので、今期作品としての精度は `seasonalWorks.ts` の本番プロンプトで別途確認したい。
- human review: [ ] OK / [ ] NG

```text
[
  {
    "kind": "アニメ",
    "title": "無職転生Ⅲ ～異世界行ったら本気だす～"
  },
  {
    "kind": "アニメ",
    "title": "幼女戦記Ⅱ"
  },
  {
    "kind": "アニメ",
    "title": "転生したらスライムだった件 第4期"
  }
]
```

## 公開会話から作品名・印象語抽出 (memory-impressions)

- covers: BIORHYTHM_MEMORY_IMPRESSIONS
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 905 ms
- automatic: PASS
- JSON valid: true
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "impressions": [
    "静か",
    "透明感"
  ],
  "title": "星巡りの歌"
}
```

## TTS読み仮名 (pronunciations)

- covers: BIORHYTHM_TTS_PRONUNCIATIONS
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 676 ms
- automatic: PASS
- JSON valid: true
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "reading": "そうそうのふりーれん",
  "text": "葬送のフリーレン"
}
```

## 日次予定表 (daily-plan)

- covers: BIORHYTHM_DAILY_PLAN
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1340 ms
- automatic: PASS
- JSON valid: true
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
[
  {
    "activityEn": "Morning routine and stretching",
    "activityJa": "モーニングルーティンとストレッチ",
    "time": "08:00"
  },
  {
    "activityEn": "System maintenance and data analysis",
    "activityJa": "システムメンテナンスとデータ分析",
    "time": "13:00"
  },
  {
    "activityEn": "Relaxing and recharging",
    "activityJa": "リラックスとリチャージ",
    "time": "21:00"
  }
]
```

## 現在状況 (status)

- covers: BIORHYTHM_STATUS
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1402 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "textEn": "It's 3 PM and the weather is so sunny! I'm feeling super energetic with a level 12 energy boost! Right now, I'm hanging out at a cafe with my friends, having the best time ever! ✨",
  "textJa": "午後3時！お天気はすっごい晴れだよ！元気度は12で、めちゃくちゃ絶好調！いま、友達といっしょにカフェにいるんだ！最高に楽しいよ〜〜〜！！✨"
}
```

## おやすみポスト (good-night)

- covers: BIORHYTHM_GOOD_NIGHT
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1418 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "textEn": "Today was such a wonderful day! I enjoyed a peaceful stroll and got lost in a great book. It was so relaxing! Now, it's time to rest. Good night, everyone! Sleep tight! 🌙✨",
  "textJa": "今日はね、のんびりお散歩して、読書もして、すっごく最高の1日だったんだよ！心がほっこりして、とっても癒やされたよ〜〜〜✨ おやすみの時間だね。みんな、ゆっくり休んでね！いい夢が見られますように！🌙💤"
}
```

## 質問生成 (question)

- covers: BIORHYTHM_QUESTION
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 883 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "textEn": "What's a little thing that makes you happy today? ✨",
  "textJa": "今日、あなたが「ちょっとした幸せだな〜」って思ったことは何かな？✨"
}
```

## 気まぐれ投稿・企画（function互換） (whimsical-plan)

- covers: BIORHYTHM_WHIMSICAL_POST_PLAN
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1765 ms
- automatic: PASS
- JSON valid: true
- claude first pass: OK: function calling → JSON Schema → functionCalls 復元の互換経路が通っている。候補なしのとき positiveNews / positiveNewsArticleId が厳密に "None"、配列も空で返る。
- human review: [ ] OK / [ ] NG

```text
{
  "name": "composePostStructure",
  "args": {
    "botFunction": "composePostStructure",
    "currentMood": "Calm and Refreshing",
    "greeting": "おはようございます。窓辺から差し込む柔らかな光と、淹れたての紅茶の香りで始まる朝。",
    "positiveNews": "None",
    "positiveNewsArticleId": "None",
    "selectedMemoryDocumentIds": [],
    "whatDay": "Morning Routine"
  }
}
```

## 気まぐれ投稿・執筆 (whimsical-write)

- covers: BIORHYTHM_WHIMSICAL_POST_WRITE
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1054 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "textEn": "Morning tea and soft sunlight by the window... It's such a peaceful moment! ☕️✨",
  "textJa": "朝の紅茶と、窓辺のやわらかな光……。とっても穏やかで、最高な時間だよ！☕️✨"
}
```

## Nagiアクター分析 (nagi-analysis)

- covers: NAGI_ANALYSIS
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1731 ms
- automatic: PASS
- JSON valid: true
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "analysisEn": "The user focuses on documenting a peaceful, slow-paced daily life through short snippets. The content is centered around lifestyle themes such as walking (strolling), photography, and reading, suggesting a mindful and aesthetic approach to life.",
  "analysisJa": "散歩、写真、読書といった、静かで情緒的な日常の断片を記録することを好む傾向があります。派手な出来事よりも、日々の些細な美しさや、落ち着いた時間の流れを大切にする、マインドフルで情緒的なライフスタイルが伺えます。",
  "tags": [
    "散歩",
    "写真",
    "読書",
    "日常",
    "暮らし",
    "ライフスタイル",
    "マインドフルネス",
    "穏やかな時間",
    "記録"
  ]
}
```

## Nagiカードコメント (card-comment)

- covers: NAGI_CARD_COMMENT
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1140 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "commentEn": "Yay! The rain has stopped and the sky is looking so pretty! Let's go for a walk together! 🦋✨",
  "commentJa": "わぁ、雨がやんだね！お空がすっごくきれいだよ！いっしょにのんびりお散歩しよ〜！🦋✨"
}
```

## コミュニティ全肯定 (community-affirmation)

- covers: NAGI_COMMUNITY_AFFIRMATION
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 1496 ms
- automatic: PASS
- JSON valid: true
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
{
  "commentEn": "Wow! Everyone's doing such amazing things! One person ran in the morning, another finished a drawing, and another tried cooking! You're all legends! Keep going! ✨",
  "commentJa": "みんな、すごすぎるよ！！！✨\n\n朝からランニングできた人も、素敵な絵を完成させた人も、料理に挑戦した人も、みんな本当にすばらしい〜〜〜！！\n\nそれぞれの目標に向かって一生懸命な姿、最高にかっこいいよ！みんな、今日の自分を全力で褒めてあげてね！🏆"
}
```

## チャンネル歓迎 (channel-welcome)

- covers: NAGI_CHANNEL_WELCOME
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 11001 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
「朝の小さな発見」チャンネルのみんな、いらっしゃい！新しい場所の始まりに、わたしもワクワクが止まらないよ！✨
```

## チャンネル話題ふり (channel-topic)

- covers: NAGI_CHANNEL_TOPIC
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 7904 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK
- human review: [ ] OK / [ ] NG

```text
ねえねえ、みんな！今日見つけた「朝の小さな幸せ」を教えてほしいな！✨

わたしはね、今朝モルフォが起こしてくれたとき、窓から見える空がすっごくきれいな水色だったから、それだけで「最高の一日になる！」って思っちゃったんだ！💙

みんなが今日、ちょっとだけ「いいな」って思ったことや、見つけた小さな発見があれば、ぜひ教えてね！待ってるよ〜〜〜！🌈
```

## 呼称指定・訂正判定 (name-intent)

- covers: NAGI_NAME_INTENT
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 948 ms
- automatic: PASS
- claude first pass: OK: 本番の judgeNameIntent を実行し intent=rename_request / name=すいばり / confidence=1。normalizeNameIntent が受け付ける識別子で返っている。
- human review: [ ] OK / [ ] NG

```text
{
  "intent": "rename_request",
  "name": "すいばり",
  "confidence": 1
}
```

## ポジティブニュース掲載判定 (news-gate)

- covers: NEWS_POSITIVE_GATE
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 892 ms
- automatic: PASS
- JSON valid: true
- claude first pass: OK: reasonCode が本番の enum 内(positive_result)。
- human review: [ ] OK / [ ] NG

```text
{
  "articleId": "n1",
  "publishable": true,
  "reasonCode": "positive_result"
}
```

## ポジティブニュース調査・コメント (news-comment-grounded)

- covers: NEWS_POSITIVE_COMMENT
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 6466 ms
- automatic: PASS
- persona signals: casual=true, keigo=false
- claude first pass: OK: 受賞者名・大会名・賞名まで調査結果どおりで、捏造がない。
- human review: [ ] OK / [ ] NG

```text
市立札幌開成中等教育学校の栗林輝さんが、米国アリゾナ州フェニックスで開催された「リジェネロン国際学生科学技術フェア（Regeneron ISEF）2026」で、最高賞の「ジョージ・ヤンコポーロス革新賞」を受賞したんだって！日本代表として史上初の快挙らしいよ。他にも日本代表の受賞研究数が過去最多を更新したりして、みんな本当にお見事だね！✨
```

## 定型文分類・選択 (predefined-classifier)

- covers: OLLAMA_PREDEFINED_AFFIRMATION
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 592 ms
- automatic: PASS
- claude first pass: OK: 本番の classifyPredefinedAffirmationStrict 経由。gj は妥当。592ms（num_ctx統一前は8.2秒）。
- human review: [ ] OK / [ ] NG

```text
gj
```

## ニュース事前スクリーニング (news-prescreen)

- covers: OLLAMA_NEWS_PRESCREEN
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 917 ms
- automatic: PASS
- claude first pass: OK: 本番の PositiveNewsService 経由。classifier_error にならず accept。
- human review: [ ] OK / [ ] NG

```text
{
  "keep": true,
  "articleId": "eval-1"
}
```

## 一般翻訳 (translation)

- covers: OLLAMA_TRANSLATION
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 496 ms
- automatic: PASS
- claude first pass: OK: 本番の translationPrompt + requestTranslationWithRetry 経由。
- human review: [ ] OK / [ ] NG

```text
I found a small flower during my morning walk.
```

## botたん口調翻訳 (bot-translation)

- covers: OLLAMA_BOT_TRANSLATION
- provider/model: ollama / hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S
- latency: 529 ms
- automatic: PASS
- claude first pass: OK: 本番の botTranslationPrompt 経由。英訳され、事実の追加もない。
- human review: [ ] OK / [ ] NG

```text
You took another step forward today, and that's so amazing! ✨
```

## 埋め込み (embedding)

- covers: OLLAMA_EMBED
- provider/model: ollama / snowflake-arctic-embed2
- latency: 1434 ms
- automatic: PASS
- claude first pass: OK: 1024次元。移行対象外(snowflake-arctic-embed2 のまま)。
- human review: [ ] OK / [ ] NG

```text
dimensions=1024
```

