# AI Agent Rules for bsky-affirmative-bot

## Database timestamp parameters

Drizzle の `sql` テンプレートへ JavaScript の `Date` を直接補間してはいけない。
Drizzle 管理下の timestamp 列に結び付かない raw パラメータは、postgres.js へ
`Date` のまま渡り、クエリ送信時に次の例外を起こす。

```text
TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string ...
Received an instance of Date
```

### 禁止例

```ts
sql`dismissal.expires_at > ${now}`;
sql`${now} < scheduled_end_at`;
sql`${sql.param(now)} < scheduled_end_at`;
```

`sql.param(date)` だけでは timestamp 列のエンコーダが付かないため、安全策にはならない。
raw SQL の相関サブクエリ内でも同じ規則を適用すること。

### Drizzle 管理下の列

timestamp 列と値を `eq`、`gt`、`gte`、`lt`、`lte` などの型付き演算子で比較する。
相関サブクエリは `notExists`、`and`、`alias` と型付き列を組み合わせる。

```ts
gt(dismissal.expiresAt, now);
lt(job.expiresAt, now);
```

これにより、列のエンコーダが `Date` をPostgreSQL用の文字列へ変換する。

### ORM定義のない外部テーブル

やむを得ずraw SQLを使う場合は、ISO 8601文字列へ変換し、PostgreSQL側の型を
明示する。

```ts
const currentTime = now.toISOString();
sql`${currentTime}::timestamptz < scheduled_end_at`;
```

### レビューとテスト

- 日時を含むraw `sql`を追加・変更したら、`${date}`や`${now}`の直接補間がないか確認する。
- `.toSQL()`でSQL文字列だけを確認しても、この不具合は検出できない。`params`に
  `Date`インスタンスが残っていないことも検証する。
- 可能な限り、Drizzleとpostgres.jsの実ドライバ境界を通るテストを追加する。
- raw SQLが必要な場合は、ISO文字列への変換と明示キャストをテスト対象にする。

## Ollama の num_ctx

**Ollama へのリクエストに `options.num_ctx` を入れてはいけない。**
サーバ側の `OLLAMA_CONTEXT_LENGTH`（LLM 機の
`/etc/systemd/system/ollama.service.d/override.conf`）が唯一の源で、
送らないクライアントは全員そこに乗る。

Ollama は num_ctx が違うと**同じモデルでも runner を作り直す**。11GB の 26B が
丸ごと読み直され、同じ Ollama を共用している別アプリまで巻き込む。

### 禁止例

```ts
options: { num_ctx: ollamaTextContextLength(), num_predict: 1024 }
options: { num_ctx: 16384, temperature: 0 }
```

2026-09-02 の実測では、32768 と 4096 が交互に来て `load_tensors` が **1時間に114回**。
I/O を食い切り（`%iowait` 36% に対し `%user` 17%）、同居している ARDY の生成が
17秒 → 129秒 → 300秒超（タイムアウト）と崩れた。

### 正しい形

```ts
options: { num_predict: numPredict, temperature }
```

`num_predict` は**必ず送る**。省くと Ollama 既定の `-1`（＝残りコンテキストまで）になり、
プロンプトが num_ctx を埋めた瞬間に生成余地が数トークンになる。エラーにはならず、
リプライが空文字や表示名だけになって投稿される。

`temperature` も**必ず送る**。以前は呼び出し側が指定したときだけ載せていたので、
リプライ生成だけが Modelfile 側の既定（gemma 系は 0.8〜1.0）で走っていた。いちばん
事実の読み取りが要る経路が、いちばん揺れる設定になっていたということ。既定値は
`ollamaDefaultTemperature()`（`ollamaBudget.ts`、既定 0.6 / env `OLLAMA_TEMPERATURE`）が
持ち、`generateOllamaContent` が未指定なら載せる。0 にはしないこと — ペルソナの
言い回しが毎回同じになる。

### ollamaTextContextLength() の役割

この関数は**送る値ではなく、プロンプト予算の計算がサーバ既定をミラーするためのもの**。
Ollama は num_predict を考慮せずプロンプトを num_ctx まで詰めるので、出力枠は
`ollamaBudget.ts` が先に取り置く。そのために「サーバがいくつで動いているか」だけは
知っている必要がある。

VRAM が足りなくなったら、**まず systemd の `OLLAMA_CONTEXT_LENGTH` を下げ、それから**
`OLLAMA_TEXT_CONTEXT_LENGTH` を同じ値へ合わせる。順序を逆にすると予算計算だけが
小さくなり、プロンプトが無駄に切り詰められる。
ズレは `biorhythm_server` の健康監視が `/api/ps` の `context_length` と突き合わせて
`[WARN][OLLAMA_CTX]` を出す。

## プロンプトの並び順

**ユーザの投稿はプロンプトのいちばん後ろに置く。**

`prepareOllamaGrounding` の `<grounding_research>` と `formatBotContext` の bot 状況
（直近24時間の行動履歴で最悪4000字）は、どちらも contents の末尾へ積まれる。プロンプトを
1本の文字列で組み立てると、今回のユーザ投稿の**後ろ**に数千字が続く形になる。26B の
量子化モデルはそこで主体や時制を取り違える。

2026-09-05 の実例:

- 「**子供のやってる**ポケモンのぞいたら…名前つけてて草」→「**すいぱり**、センスが最高すぎるよ」（行為者のすり替え）
- 「EO5-5**終わらせたら**、感想をまとめないとな」→「**クリアおめでとう**！」（未完了を完了として祝った）

そのため肯定リプライは contents を `[指示ブロック, ユーザ投稿, 画像…]` に分け、
`groundingAnchor: 'first'` で調査ブロックを指示側へ寄せている（`ScoredPromptParts`）。
プロンプトへ材料を足すときは**指示側**へ入れること。ユーザ投稿より後ろに置いてよいのは
画像パートだけ（画像は投稿の一部）。

実際に何がどの順で送られたかは `AI_PROMPT_DUMP_DIR` を設定すると JSON で確認できる。

### レビューとテスト

- Ollama を叩くコードを追加・変更したら、`options` に `num_ctx` が無いことを確認する。
- `options` に `temperature` が載ることも確認する（`num_ctx` と違い、こちらは必須）。
- 評価スクリプト（`scripts/evaluateLocalModels.mts` など）も対象。ここが本番と違う
  num_ctx を送ると、評価を回すだけでリロード地獄を起こす。
- リクエスト本体を組み立てるコードにはテストを添え、`num_ctx` を含めないことを検証する。
- OpenAI 互換 `/v1/chat/completions` は `options` を黙って捨てるので自動的にサーバ既定へ
  乗る。ネイティブ `/api/chat` を使うのは `think: false` を送るためであって、
  num_ctx を送るためではない。
