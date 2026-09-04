# 埋め込みモデル評価

Nagi の意味検索と botMemory RAG が使う埋め込みモデルを、**同一コーパス・同一クエリ**で
横並び比較するための評価ハーネス。

発端は Nagi の検索の破綻。「ワルプルギス」で検索してもまどマギ／アニメ系が上位に来ず、
無関係な投稿が並ぶ。現行は Ollama の `snowflake-arctic-embed2`（1024次元）1本。

> **このハーネスは本番コードを一切変更しない。** 本番DBには `SELECT` しか投げない。
> 置き換えるかどうかは、ここで出た数字を見てから別途決める。

## 何を測るか

| Tier | アーム | 依存 |
| --- | --- | --- |
| 1 | `arctic` / `arctic-q` / **`arctic+trgm`（現行本番の再現）** | Ollama (+ pg_trgm) |
| 1 | `ruri310`（ruri-v3-310m） | サイドカー |
| 1 | `bge-dense` / `bge-sparse` / `bge+sparse@aX` | Ollama + サイドカー |
| 1 | `ruri+sparse@aX`（記事の推し構成） | サイドカー |
| 2 | `egemma`（embeddinggemma） / `qwen3-06b` | **Ollama のみ** |
| 2 | `e5-large` / `gemini`（参考） | サイドカー / 課金API |
| 3 | `…+rerank-ruri` / `…+rerank-bge`（cross-encoder） | サイドカー |

`arctic+trgm` が**真のベースライン**。`hybridSearch.ts` の `SEM_WEIGHT 0.7 / LEX_WEIGHT 0.3`
をそのまま再現しているので、「モデル差」と「閾値・融合設計の差」を切り分けられる。

Tier 2 の `egemma` / `qwen3-06b` は Ollama 公式ライブラリにあり、**サイドカーなしで本番へ
載せられる**。勝てば移行コストが最小になるので、Tier 1 と同等に扱うこと。

## 回し方

```bash
# 0. ドライラン。外部通信なし。アーム構成とクエリ件数だけ見る
pnpm embedding:evaluate

# 1. Ollama 側のモデルを取る
ollama pull bge-m3
ollama pull embeddinggemma
ollama pull qwen3-embedding:0.6b

# 2. サイドカーを起動（別ターミナル。ruri-v3 / bge-m3 sparse / リランカー用）
#    この機は VRAM が空かないので CPU で回す。詳細は scripts/embedding-eval/README.md
cd scripts/embedding-eval
python3 -m venv .venv
.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
.venv/bin/pip install -r requirements.txt
EMBED_EVAL_DEVICE=cpu OMP_NUM_THREADS=12 .venv/bin/uvicorn server:app --port 7997

# 3. 本実行（本番DBから read-only でコーパスを取る）
pnpm embedding:evaluate -- --run --corpus-limit=10000

# 4. review.md を人手で採点（判定 列を 0/1/2 で書き換える）
$EDITOR docs/evaluations/embedding/review.md

# 5. 人手採点で再集計
pnpm embedding:evaluate -- --judge=human
```

サイドカーが起動していなければ、それを要するアームは `[SKIP]` されて残りだけが走る。
まず Ollama だけで Tier 1/2 を回し、後からサイドカーを足す進め方でよい。

### botMemory RAG も測る

コーパスは `--source` で切り替える。指標はソースごとに別集計になるので、出力先も分ける。

```bash
pnpm embedding:evaluate -- --run --source=memory --corpus-limit=5000 \
  --out=docs/evaluations/embedding/memory
```

## 主なオプション

| オプション | 既定 | 意味 |
| --- | --- | --- |
| `--run` | — | 付けないとドライラン（外部通信なし） |
| `--source=posts\|memory` | `posts` | コーパスの取得元。クエリセットと出力先の既定もこれに追従する |
| `--queries-file=PATH` | `--source` に追従 | クエリセットを明示する。既定は posts→`scripts/fixtures/embeddingQueries.json`、memory→`scripts/fixtures/embeddingQueriesMemory.json` |
| `--corpus-limit=N` | `10000` | コーパス件数。まず 3000 で試すと速い |
| `--arms=a,b` | 全部 | 測るアームを絞る（rerank の土台は自動で足される）。**`result.json` は指定したアームだけで作り直されるので、集計に全アームを残したいなら絞らずに回すこと**（埋め込みはキャッシュされるので2回目以降は速い） |
| `--queries=id,id` | 全部 | クエリを絞る。定性確認に使う |
| `--judge=llm\|human\|none` | `llm` | 採点の出どころ |
| `--rerank-base=armId` | `arctic+trgm`,`ruri+sparse@a0.7` | リランカーを載せる土台 |
| `--refresh` | — | 埋め込み・sparse・trgm のキャッシュを捨てて取り直す |
| `--resume` | — | 前回の人手採点を引き継ぐ |
| `--with-gemini` | — | 課金経路を開く（`--gemini-cap` 回で強制停止） |
| `--out=DIR` / `--cache=DIR` | `--source` に追従 / `.cache/embedding-eval` | 出力先。posts→`docs/evaluations/embedding`、memory→`docs/evaluations/embedding-memory`。分けないと memory の実行が posts の `result.json` を上書きして人手採点が消える |

## 出力

| ファイル | 中身 |
| --- | --- |
| `result.json` | 全アームの top-20・信号ごとの生スコア・採点キーの対応表 |
| `review.md` | ブラインド採点表（アーム名は伏せ、並びもシャッフル） |
| `summary.md` | nDCG@10 / P@1 / P@5 / MRR / Recall@20、カテゴリ別、判断表 |

コーパス本文と埋め込みは `.cache/embedding-eval/`（gitignore 済み）にだけ置く。
**実ユーザーの投稿本文なので `docs/` にもリポジトリにも入れない。**
`review.md` にも本文が載るため、コミットする前に中身を確認すること。

## 判断基準

現行本番 `arctic+trgm` に対して、候補が次を**同時に**満たすこと。

1. `proper-noun` カテゴリの nDCG@10 が明確に上（＝「ワルプルギス」が実際に直っている）
2. 全カテゴリ平均の nDCG@10 が劣化していない

`summary.md` の「判断」節がこの2条件を自動で判定して ✅ を付ける。
併せて、そのアームが**サイドカー常駐を要するか**（`依存` 列）を移行コストとして見ること。

ただし ✅ だけで決めないこと。下の「結果表の読み方」のとおり、この数字は
あいまい検索セクション単体の実力ではない。実際 2026-09-04 の判断では、
✅ が付いた `egemma` を**採らなかった**（全体平均では勝つが固有名詞で負けるため）。
移行コストは「サイドカー常駐」だけでなく**次元**も見ること — 1024次元同士なら
`embedding` を NULL にするだけだが、768次元へ移るとスキーマ変更が要る。

## 注意

- **LLM-as-judge は下書き。** 日本語の固有名詞では判定がぶれる。`--judge=human` の数字で
  判断すること。`summary.md` は LLM 採点のままだと冒頭に警告を出す。
- **Ollama に `num_ctx` を送らない。** 評価スクリプトが本番と違う num_ctx を送ると
  runner が作り直され、同居アプリまで巻き込む（AGENTS.md「Ollama の num_ctx」）。
  `pnpm test:embedding` がリクエスト本体を直接検査している。
- **評価は本番と同じ `ollama-embed`(11435) を使う。** このインスタンスは
  `OLLAMA_MAX_LOADED_MODELS=1` なので、**評価がモデルを切り替えるたびに本番用のモデルが
  追い出される**。CPU 上の 0.6〜1.2GB クラスなので1回あたり数秒で済み、実測では
  6分間に3回（本番の埋め込みリクエストが細っている時間帯）だったが、
  再埋め込みのような一括処理と同時に回すと双方が遅くなる。
  **バックフィル中に評価を回さないこと。** 逆も同じ。
- **VRAM。** GPU 16GB のうち Ollama の gemma-4-26B が 11.8GB を占め、空きは 2GB 強。
  サイドカーの3モデルは載らないので **CPU で回す**（`EMBED_EVAL_DEVICE=cpu`）。
  無理に載せると gemma が追い出され、同居アプリの生成が丸ごと崩れる。
- **距離しきい値は `SEM_DIST_MAX` も `SEM_REL_MARGIN` も関連/無関連を分離できない。**
  下の「2026-09-04 の結果」を参照。どちらもモデルごとのスケール合わせと件数調整であって、
  品質装置ではない。クエリ接頭辞を足すだけでも距離スケールが +0.19 動くので、
  接頭辞やモデルを変えるときは**必ずセットで測り直す**こと。
- 置き換えに進む場合、埋め込み列は全6テーブルで 1024次元固定
  （`packages/database/src/schema.ts` / `nagiSchema.ts`）。ruri-v3 と embeddinggemma は
  768次元なので、スキーマ変更と全件再埋め込みが要る。`qwen3-embedding:0.6b` は 1024次元
  なのでスキーマ変更なしで差し替えられる。

## 本番への反映（2026-09-04）

評価の結論を2段階で入れた。

**Stage 1 — env のみ（再埋め込みなし）**: `OLLAMA_QUERY_PREFIX="query: "` と
`SEARCH_SEM_DIST_MAX=0.80` / `SEARCH_SEM_REL_MARGIN=0.12` / `SEARCH_ACTOR_SEM_DIST_MAX=0.95`。
本番DBに対する前後比較で、あいまい検索「ワルプルギス」の
`hewwo` / `おっひるー` / `:nurupo:` / `:orz:` が消え、hybrid モードは上位8件すべてが
まどマギ投稿になった。「散歩」も関連ヒットが 3/10 → 6/10。

**Stage 2 — `qwen3-embedding:0.6b` へ差し替え**: 1024次元同士なのでスキーマ変更なし。
`packages/database/src/ollamaEmbed.ts` の `embedSearchQuery()` にクエリ接頭辞を集約し、
Nagi 検索（`hybridSearch.embedQuery`）と botMemory RAG（`searchBotMemory`）の両方が経由する。
文書側（`embeddingWorker` / `botMemoryEmbeddingWorker` / `upsertPost` /
`findFollowersByTopic`）は接頭辞なしの `generateEmbedding(s)` のまま。
しきい値は `SEARCH_SEM_DIST_MAX=0.60` / `SEARCH_SEM_REL_MARGIN=0.08` /
`SEARCH_ACTOR_SEM_DIST_MAX=0.75`。全件再埋め込みは `scripts/reembedAll.mts`。

はまった点:

- **接頭辞の `\n`。** dotenv も `node --env-file` も**二重引用符内**の `\n` は実改行へ
  展開する（単引用符は展開しない）。systemd の `Environment=` や docker の `-e` は
  展開しないので、`searchQueryPrefix()` が残った `\n` を保険で展開する。
- **`affirmative_bot.posts` にはワーカーが無い。** `upsertPost` 時にしか埋まらないので、
  NULL に落としただけでは誰も埋め直さない。`reembedAll.mts` がこの表だけ直接埋める。
  初版はこの表を NULL 化対象から外していたため旧ベクトルが残り、「0行」で素通りした。
- **しきい値はコーパス上の実距離で決めること。** 手元で作った文と適当なクエリの
  cosine 距離（0.67）を根拠にすると誤る。実際の上位ヒットは walpurgis 0.332〜0.404 /
  madomagi 0.409〜0.469 / walk 0.274〜0.401 で、0.60 を余裕で通る。
- **モデルを遅いものへ替えるとバッチのタイムアウトが破綻する。**
  `OLLAMA_EMBED_TIMEOUT_MS` はクエリ1本を基準に 5000ms と決めてあったが、埋め込みワーカーは
  16件をまとめて投げる。実測（qwen3 / CPU）は 1件 約330ms・16件 約4.4秒で、固定5秒だと
  常時ぎりぎり。超えるたび `ollamaEmbed.ts` の cooldown が60秒開き、**再埋め込みだけでなく
  利用者の検索も含めて埋め込みが全面停止する**。実際、再埋め込みの実効速度が
  64→96→192→32 行/分 と振動し、`bot_memory_documents` は 80行で止まった。
  → タイムアウトを件数比例（`OLLAMA_EMBED_TIMEOUT_PER_ITEM_MS`、既定1500ms）にして解消。
  **埋め込みモデルを替えるときは必ずバッチ1回の実測を取ること。**
- **評価ハーネスのベースラインを env 追従にしない。** `ENCODERS` の `arctic` は
  `OLLAMA_EMBED_MODEL` を既定にしていたため、本番を qwen3 へ替えた瞬間に
  ベースラインまで qwen3 になり「現行との比較」が成立しなくなった。固定名に直した。

## ⚠ 結果表の読み方（2026-09-04 追記）

**このハーネスはコーパス全体でランキングするが、本番のあいまい検索はそうではない。**
`semanticConditions`（`apps/nagi_appview/src/queries/hybridSearch.ts`）は一致セクションと
排他にするため **ILIKE ヒット（本文に検索語がそのまま入っている行）を除外**する。
ハーネスはこれを模していないので、`summary.md` の数字は
**hybrid モード（タイプアヘッド既定）と一致セクションを含めた総合力**であって、
あいまい検索セクション単体の実力ではない。

除外して測り直すと順位が変わる:

| アーム | 全体（ハーネス既定） | 全体（ILIKE除外） | 固有名詞（既定） | 固有名詞（除外） |
|---|---:|---:|---:|---:|
| `egemma` | 0.632 | **0.517** | 0.351 | 0.185 |
| `ruri310` | 0.653 | 0.485 | 0.554 | **0.362** |
| `qwen3-06b` | 0.639 | 0.415 | 0.458 | 0.263 |
| `arctic-q` | 0.548 | 0.363 | 0.356 | 0.179 |
| `arctic` | 0.343 | 0.230 | 0.162 | 0.040 |

qwen3 の優位の多くは「語をそのまま含む投稿を上位に出す力」から来ており、
その部分は本番では一致セクションへ回る。それでも旧 arctic からは除外後でも
0.230 → 0.415 と改善しているので採用の判断は変わらない。
egemma は全体平均では勝つが**固有名詞では qwen3 より下**（0.185 対 0.263）で、
今回の起点だった症状の領域が悪化するため採らなかった。

### 埋め込みモデルでは直らない領域がある

ILIKE 除外後の固有名詞クエリを1本ずつ見ると:

| クエリ | qwen3 | egemma | ruri310 | 除外後プール / うち関連 |
|---|---:|---:|---:|---|
| **walpurgis** | **0.000** | **0.000** | **0.000** | 7件 / **0件** |
| madomagi | 0.457 | 0.836 | 0.658 | 19件 / 10件 |
| zelda | 0.145 | 0.307 | 0.530 | 95件 / 18件 |
| jujutsu | 0.395 | 0.066 | 0.690 | 76件 / 18件 |

**「ワルプルギス」は全モデルが 0.000。** どのアームも、語を含まない関連投稿を
top-20 に1件も出せていない。一方 madomagi のプールには「魔法少女まどか☆マギカの
ポスター」のような、ワルプルギスの語を含まない関連投稿が10件ある。
つまり**拾えるはずの投稿が存在するのに、どの埋め込みモデルも見つけられていない**。
ここはモデル交換では動かない語彙ギャップで、doc2query 的な文書拡張か
クエリ拡張でしか埋まらない。次はそれを測る。

## botMemory RAG を測るときの注意

`--source=memory` のクエリセット（`scripts/fixtures/embeddingQueriesMemory.json`）は
**「botに届いた投稿本文そのもの」**でなければならない。本番の呼び出しは全て
`searchBotMemory({ query: text })` で、`text` は受信した投稿の本文をそのまま渡している
（`apps/bsky_bot_server/src/features/replyai.ts:206,215,229` と
`apps/nagi_bot_server/src/nagiReplyContext.ts:116,127`）。

つまりこれは「検索語 → 文書」ではなく**「投稿 → 過去の関連記憶」**の検索で、
Nagi 検索用の短い検索語で測ると両方について誤った結論が出る。
`embedSearchQuery()` のクエリ接頭辞がこの対称的なタスクでも有効かどうかは、
ここで実測して決めること。

## 2026-09-04 の結果

`nagi.posts` 3000件 × 27クエリ × 25アーム。人手915件 + LLM下書き714件の混在採点。
数字は `summary.md` / `result.json`。

| アーム | nDCG@10 | 固有名詞 | 依存 | 次元 |
|---|---:|---:|---|---|
| `ruri+sparse@a0.7+rerank-ruri` | 0.690 | 0.468 | sidecar | 768+sparse |
| `ruri310` | 0.653 | **0.554** | sidecar | 768 |
| `qwen3-06b` | 0.639 | 0.458 | ollama のみ | 1024 |
| `egemma` | 0.632 | 0.351 | ollama のみ | 768 |
| `arctic-q` | 0.548 | 0.356 | ollama のみ | 1024 |
| `arctic+trgm`（当時の本番） | 0.366 | 0.214 | ollama+postgres | 1024 |

分かったこと:

1. **ruri + bge-m3 sparse（記事の推奨）はこのコーパスでは再現しない。** sparse 融合は
   ruri310 単体を下げる（α=0.9 で 0.640 / 0.7 で 0.609 / 0.3 で 0.553）。α をどう振っても
   単体 0.653 に届かない。SNS の短文では sparse の語彙一致がノイズ側に効く。
2. **`query: ` 接頭辞は効く。** nDCG 0.366 → 0.548、固有名詞 0.214 → 0.356。
   `walpurgis` / `madomagi` は 0.697 / 0.668 → **どちらも 1.000**。文書側の再埋め込みは不要。
3. **かつて「接頭辞は効かない」と結論した原因は `SEM_DIST_MAX`。** 接頭辞は距離スケールを
   約 +0.19 押し上げるので、0.65 のままだと `arctic-q` は top-10 の 162/270 を切り落とす。
4. **短文ノイズは接頭辞かモデル交換で自然に消える。** 無関連ヒットの本文長中央値は
   素の `arctic` で 11文字、`arctic-q` 243文字、`qwen3-06b` 230文字。
   → 最小文字数フィルタのような追加装置は要らない。
5. **両しきい値に選別能力はない。** 関連ヒットと無関連ヒットの距離分布が重なる:

   | アーム | 関連 dist p50 | 無関連 dist p50 |
   |---|---:|---:|
   | `arctic` | 0.480 | 0.511 |
   | `arctic-q` | 0.666 | 0.707 |
   | `qwen3-06b` | 0.403 | 0.404 |
   | `egemma` | 0.584 | 0.586 |
   | `ruri310` | 0.162 | 0.150 ← 無関連のほうが近い |

   `relativeCut`（best + `SEM_REL_MARGIN`）も同様で、どのマージンでも
   「関連の残存率 ≒ 無関連の通過率」。実際に効いているのは `SEMANTIC_LIMIT = 10` の
   打ち止めとランキングそのもの。→ しきい値は**関連を落とさない側**に置く。
6. `bluearchive` が全アーム 0.000 なのはモデルのせいではなく、3000件のコーパスに
   ブルアカ投稿がほぼ無いため。固有名詞カテゴリの平均はこの手の「話題が薄い」クエリに
   引っ張られて低めに出る。
