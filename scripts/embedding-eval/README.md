# 埋め込み評価サイドカー

`scripts/evaluateEmbeddingModels.mts` が使う、**評価専用**の推論サーバ。
Ollama から取れないものだけをここに載せる。

| 用途 | 理由 |
| --- | --- |
| ruri-v3 系 (`cl-nagoya/ruri-v3-*`) | Ollama 公式ライブラリに v3 がない |
| bge-m3 の sparse (lexical weights) | Ollama の `bge-m3` は dense しか返さない |
| cross-encoder リランカー | Ollama に該当機能がない |
| `intfloat/multilingual-e5-large` | Ollama 公式ライブラリにない |

**本番経路には入れない。** 評価を回すときだけ起動し、終わったら落とすこと。
本番の埋め込みは `packages/database/src/ollamaEmbed.ts` が Ollama を叩く経路のまま。

## 起動

```bash
cd scripts/embedding-eval
python3 -m venv .venv
.venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch
.venv/bin/pip install -r requirements.txt

EMBED_EVAL_DEVICE=cpu OMP_NUM_THREADS=12 \
  .venv/bin/uvicorn server:app --host 127.0.0.1 --port 7997
```

**この機では CPU で回す。** GPU は 16GB のうち Ollama の gemma-4-26B が 11.8GB を
占めており、空きは 2GB 強しかない。ruri-310m + bge-m3 + reranker で fp16 約 3GB
必要なので載らない。無理に載せると gemma が追い出され、同居している全アプリの生成が
崩れる（AGENTS.md「Ollama の num_ctx」で起きたのと同じ壊れ方）。

GPU で回したいときは、先に Ollama を止めて VRAM を空け、CUDA 版 torch を入れ直すこと。

初回はモデルを Hugging Face から落とすので時間がかかる。ロードは遅延なので、
最初のリクエストが一番遅い。

## 疎通確認

```bash
curl -s localhost:7997/health | jq

# ruri-v3 は 768 次元
curl -s localhost:7997/dense -H 'content-type: application/json' \
  -d '{"model":"cl-nagoya/ruri-v3-310m","texts":["検索文書: テスト"]}' \
  | jq '.dim'

# sparse は {token_id: weight} の辞書
curl -s localhost:7997/sparse -H 'content-type: application/json' \
  -d '{"texts":["ワルプルギスの夜"]}' | jq '.weights[0] | length'
```

## 環境変数

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `EMBED_EVAL_DEVICE` | `auto` | `cuda` / `cpu` / `auto` |
| `EMBED_EVAL_FP16` | cuda なら `1` | 半精度で載せるか |

評価スクリプト側の接続先は `EMBED_EVAL_SIDECAR_URL`（既定 `http://127.0.0.1:7997`）。

## 実測メモ（i5-12400F 12コア / CPU / 2026-09-04）

初回リクエストはモデルのダウンロードとロードを含むので極端に遅い。2回目以降が本来の速度。

| エンドポイント | モデル | 初回（DL+ロード込み） |
| --- | --- | --- |
| `/dense` | `cl-nagoya/ruri-v3-310m` | 38 秒（768次元） |
| `/dense` | `intfloat/multilingual-e5-large` | — （1024次元） |
| `/sparse` | `BAAI/bge-m3` | 103 秒 |
| `/rerank` | `cl-nagoya/ruri-v3-reranker-310m` | 32 秒 |

モデルはプロセス内に積みっぱなしになる。全部触ると RAM を数 GB 使うので、
メモリが厳しければアームを分けて回し、間でサイドカーを再起動する。

uvicorn の worker は 1 のままにする。増やすと同じモデルを worker 数だけ積む。
