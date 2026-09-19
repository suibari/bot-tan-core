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

## 画像の実効解像度

**モデルへ送る画像は `prepareModelImages`（`packages/bot_brain/src/ai/imagePreprocess.ts`）を
必ず通すこと。** 生の blob を base64 にして `inlineData` へ入れる新しい経路を足してはいけない。

gemma4 の視覚エンコーダは**実効896px相当で頭打ち**になる。2026-09-06 の実測
（`/api/chat` の `prompt_eval_count` 差分）:

| 入力 | 画像トークン | 小さい文字の読み取り |
|---|---|---|
| 512x794 | 244 | 「全肖定」「A+Pまたは一枚」 |
| 896x1389 | 317 | 「レヤー」「A+Proto京校」 |
| 2000x3100（原寸） | 317 | 「botだん」「A+Photo商店」 |

つまり PDS の原寸 blob（実測 2.5MB）を送っても、モデルが見る情報量は 896px と変わらない。
**縮小は純粋な軽量化であって、詳細の回復にはならない。** 詳細を戻す唯一のレバーはタイル分割で、
「全体1枚 303tok」で誤読していた画像内の文字が「全体+2x3タイル 1,947tok」でほぼ正確になった。
タイルは既定で有効（`AI_IMAGE_TILES`、既定4枚・`0` で無効）。追加コストは実測 0.3 秒未満
（画像整形 104→119ms、生成 1,456〜1,553→1,555〜1,853ms、プロンプト 6,857→7,948 トークン）。

`@napi-rs/canvas` の `loadImage` は**壊れた入力で reject せず永久に固まる**
（`Buffer.from([1,2,3])` で再現）。`prepareModelImages` は署名判定とタイムアウトで塞いでいる。
自前でデコードを書くとここを踏む。

画像の並びは「全体 → そのタイル」を守ること。`fitOllamaMessages` は画像を**後ろから**落とすので、
この順序であれば予算が苦しいときに細部から捨てられ、全体像が最後まで残る。

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

## 定期ワーカーの回し方

**`setInterval` で tick を直に回してはいけない。**
`apps/nagi_bot_server/src/workerLoop.ts` の `startWorkerLoop` を使う。

`setInterval` は前回の完了を待たない。1件ずつ掴むキューワーカーをこれで回すと、
ジョブが溜まっているとき「1回の処理時間 ÷ 間隔」本が同時に走る。総評生成は実測3.2秒
なので、1秒間隔なら再起動後のバックログを**4本並列**で処理し、そのぶん Ollama を殴る。
間隔を詰めるほど並列数が増える、という逆向きの効き方をする。

掴み取りのリース（`state` / `lease_expires_at`）はこれを防げない。あれはプロセスを
またぐ重複を止めるもので、同一プロセス内で重なった tick は**別の行を掴んで進む**だけ。

### 禁止例

```ts
setInterval(() => { void run().catch(console.error); }, WORKER_INTERVAL_MS);
```

### 正しい形

```ts
startWorkerLoop({ name: "ZENKATSU", intervalMs: WORKER_INTERVAL_MS, tick: run });
```

`name` は `[ERROR][<name>]` として出るログの識別子。起動直後に一度回すなら
`immediate: true`（ガード込みで走る）。戻り値の timer は必要なら `.unref()` する。

### 間隔の決め方

**その経路でユーザーが待っているのかを先に確かめる。** 待っている処理には、たいてい
コミット直後に叩く即時起動の口がある（総評なら AppView → `POST /zenkatsu/run`）。
そちらがあるなら、定期ワーカーが担うのは回収だけ ——
通知のHTTPが落ちたとき・リースが切れたとき・失敗のバックオフ待ち —— なので、
間隔は体感の待ち時間に乗らない。秒単位まで詰めても**速くならず、並列だけが増える**。

即時起動の口には in-flight ガードをかけないこと。ユーザーのペースでしか来ないので
並列は暴れず、ここで弾くと待っている本人の結果が次の tick まで遅れる。

### レビューとテスト

- ワーカーを追加・変更したら、`setInterval` を直に書いていないか確認する。
  既存の手書きガード（`if (processing) return`）も見つけたら `startWorkerLoop` へ寄せる。
- 間隔を縮める変更は、その経路に即時起動の口が無いことを確認してから出す。
  あるなら縮めても速くならない。
- 間隔を縮めるときは「1回の処理時間 ÷ 間隔」を並列数として見積もる。LLM を呼ぶ
  ワーカーなら、その本数がそのまま Ollama への同時リクエストになる。
- `setTimeout` チェーンで次を予約する形（`NagiThemeWorker`）は元から重ならないので対象外。
