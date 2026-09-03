"""埋め込みモデル評価専用のサイドカー。

Ollama から取れないものだけをここに載せる:

  - ruri-v3 系 (cl-nagoya/ruri-v3-*)   … Ollama 公式ライブラリに v3 がない
  - bge-m3 の sparse (lexical weights) … Ollama の bge-m3 は dense しか返さない
  - cross-encoder リランカー           … Ollama に該当機能がない

**本番経路には一切入れない。** 評価を回すときだけ起動し、終わったら落とすこと。
本番の埋め込みは packages/database/src/ollamaEmbed.ts が Ollama を叩く経路のまま。

起動:
    pip install -r requirements.txt
    uvicorn server:app --host 127.0.0.1 --port 7997

環境変数:
    EMBED_EVAL_DEVICE   cuda | cpu | auto (既定: auto)
    EMBED_EVAL_FP16     1 なら半精度 (既定: cuda のとき 1)

VRAM の注意: 同じ機で Ollama の gemma-4-26B (12GB) が動いている。ruri-310m +
bge-m3 + reranker で fp16 約 3GB 積む。余裕がなければ EMBED_EVAL_DEVICE=cpu に
落とすこと。数千件のコーパスなら CPU でも数分で終わる。
"""

from __future__ import annotations

import os
import threading
from typing import Dict, List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="embedding-eval sidecar")

# ---------------------------------------------------------------------------
# デバイス選択
# ---------------------------------------------------------------------------


def _resolve_device() -> str:
    requested = (os.environ.get("EMBED_EVAL_DEVICE") or "auto").lower()
    if requested in ("cuda", "cpu"):
        return requested
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


DEVICE = _resolve_device()
USE_FP16 = os.environ.get("EMBED_EVAL_FP16", "1" if DEVICE == "cuda" else "0") == "1"

# モデルのロードは重い。プロセス内で一度だけ行い、以降は使い回す。
# uvicorn の worker は 1 前提（複数 worker にすると同じモデルを人数分積む）。
_lock = threading.Lock()
_dense_models: Dict[str, object] = {}
_rerankers: Dict[str, object] = {}
_bge_m3 = None


def _dense_model(name: str):
    with _lock:
        if name not in _dense_models:
            from sentence_transformers import SentenceTransformer

            _dense_models[name] = SentenceTransformer(name, device=DEVICE)
        return _dense_models[name]


def _reranker(name: str):
    with _lock:
        if name not in _rerankers:
            from FlagEmbedding import FlagReranker

            _rerankers[name] = FlagReranker(name, use_fp16=USE_FP16, devices=DEVICE)
        return _rerankers[name]


def _bge_m3_model():
    global _bge_m3
    with _lock:
        if _bge_m3 is None:
            from FlagEmbedding import BGEM3FlagModel

            _bge_m3 = BGEM3FlagModel(
                "BAAI/bge-m3", use_fp16=USE_FP16, devices=DEVICE
            )
        return _bge_m3


# ---------------------------------------------------------------------------
# リクエスト/レスポンス
# ---------------------------------------------------------------------------


class DenseRequest(BaseModel):
    model: str
    # 接頭辞（ruri なら "検索クエリ: " / "検索文書: "）は**呼び出し側で付けて渡す**。
    # ここで暗黙に付けると、評価アームごとの差が見えなくなる。
    texts: List[str] = Field(default_factory=list)


class DenseResponse(BaseModel):
    dim: int
    embeddings: List[List[float]]


class SparseRequest(BaseModel):
    texts: List[str] = Field(default_factory=list)


class SparseResponse(BaseModel):
    # bge-m3 の lexical_weights。{token_id(文字列): weight} の疎ベクトル。
    # 語彙は XLM-R の 250k なので密ベクトルには展開せず、辞書のまま返す。
    weights: List[Dict[str, float]]


class RerankRequest(BaseModel):
    model: str
    query: str
    texts: List[str] = Field(default_factory=list)


class RerankResponse(BaseModel):
    scores: List[float]


@app.get("/health")
def health() -> dict:
    return {
        "device": DEVICE,
        "fp16": USE_FP16,
        "dense_loaded": sorted(_dense_models.keys()),
        "reranker_loaded": sorted(_rerankers.keys()),
        "bge_m3_loaded": _bge_m3 is not None,
    }


@app.post("/dense", response_model=DenseResponse)
def dense(req: DenseRequest) -> DenseResponse:
    if not req.texts:
        return DenseResponse(dim=0, embeddings=[])
    try:
        model = _dense_model(req.model)
        vectors = model.encode(
            req.texts,
            batch_size=16,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
    except Exception as error:  # noqa: BLE001 - 評価ハーネスへ理由を返したい
        raise HTTPException(status_code=500, detail=f"{type(error).__name__}: {error}")
    embeddings = [[float(x) for x in row] for row in vectors]
    return DenseResponse(dim=len(embeddings[0]), embeddings=embeddings)


@app.post("/sparse", response_model=SparseResponse)
def sparse(req: SparseRequest) -> SparseResponse:
    if not req.texts:
        return SparseResponse(weights=[])
    try:
        output = _bge_m3_model().encode(
            req.texts,
            batch_size=8,
            return_dense=False,
            return_sparse=True,
            return_colbert_vecs=False,
        )
    except Exception as error:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"{type(error).__name__}: {error}")
    weights = [
        {str(token): float(weight) for token, weight in row.items()}
        for row in output["lexical_weights"]
    ]
    return SparseResponse(weights=weights)


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest) -> RerankResponse:
    if not req.texts:
        return RerankResponse(scores=[])
    try:
        raw = _reranker(req.model).compute_score(
            [[req.query, text] for text in req.texts], normalize=True
        )
    except Exception as error:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"{type(error).__name__}: {error}")
    scores = raw if isinstance(raw, list) else [raw]
    return RerankResponse(scores=[float(s) for s in scores])
