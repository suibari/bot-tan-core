import { aiModel } from "@bsky-affirmative-bot/shared-configs";

/**
 * 埋め込みモデルごとの較正値。
 *
 * ## なぜ env ではなくここに置くのか
 *
 * これらは「環境ごとに違う設定」ではなく**モデルに紐づく定数**で、dev でも本番でも
 * 正しい値は同じ。しかも4つは独立しておらず、**モデルを変えたら全部が同時に変わる**。
 *
 * env に散らしていた頃、この結合はドキュメント上の約束でしかなかった。実際それが原因で
 * 「`query: ` 接頭辞は効かない」という誤った結論がコードコメントに残っていた
 * （接頭辞だけ入れて semDistMax を据え置いたので、改善が絶対ガードの裏に隠れていた）。
 * さらに env が1つでも欠けると arctic 時代の既定へ落ち、qwen3 で埋め込んだ DB に対して
 * arctic でクエリを埋め込む状態になる。次元がどちらも 1024 なので例外は出ず、
 * **検索結果が静かに無意味になる**。テーブルにすれば、この結合が構造として担保される。
 *
 * ## 値の根拠
 *
 * 3,000件のコーパス × 27クエリの実測（docs/evaluations/embedding/ と
 * docs/evaluations/embedding-semantic/）。距離しきい値には**関連/無関係を選り分ける
 * 能力は無い**（関連と無関係の距離分布がどのモデルでも重なる）。実際に品質を決めるのは
 * ランキングと SEMANTIC_LIMIT の打ち止めで、ここは「関連を取りこぼさない」側に置く。
 *
 * ## モデルを足すとき
 *
 * 接頭辞はモデル公式の形に揃え、しきい値は実コーパスの上位ヒット距離を測って決めること。
 * 手元で作った文とクエリの cosine を根拠にすると誤る（実測で 0.67 が出たが、
 * 実際の上位ヒットは 0.27〜0.47 だった）。
 */
export type EmbeddingProfile = {
  /** クエリ側だけに付ける接頭辞。文書側には付けない。 */
  queryPrefix: string;
  /** 投稿などの意味検索の距離しきい値（cosine 距離）。 */
  semDistMax: number;
  /** relativeCut のマージン。「最良ヒット + これ」を超えたら切る。 */
  semRelMargin: number;
  /** プロフィール検索用。短文で距離が出やすいので投稿より緩める。 */
  actorDistMax: number;
};

const PROFILES: Record<string, EmbeddingProfile> = {
  // 2026-09-04 から本番。1024次元。instruction-aware なのでクエリ側に指示文を付ける。
  // 上位ヒットの実距離は walpurgis 0.332〜0.404 / madomagi 0.409〜0.469 / walk 0.274〜0.401
  // で、0.60 なら関連を100%拾える（0.55 でも99%）。
  "qwen3-embedding:0.6b": {
    queryPrefix:
      "Instruct: Given a search query, retrieve relevant social media posts written in Japanese\nQuery: ",
    semDistMax: 0.6,
    semRelMargin: 0.08,
    // 投稿側 + 0.15。プロフィールは displayName + description + 分析の短文なので遠くなる。
    actorDistMax: 0.75,
  },

  // 2026-09-04 まで本番。過去の設定を再現できるよう残してある。
  // 接頭辞は距離スケール全体を約 +0.19 押し上げるので、しきい値もセットで大きい。
  // 0.80 で関連100%残存、0.75 だと95%まで落ちる。
  "snowflake-arctic-embed2": {
    queryPrefix: "query: ",
    semDistMax: 0.8,
    semRelMargin: 0.12,
    actorDistMax: 0.95,
  },
};

/**
 * 未知のモデル用。**接頭辞は付けず、しきい値は事実上無効にする。**
 * 距離スケールが分からない以上、切るより通すほうが安全（切ると「検索が壊れた」に見えるが、
 * 通しても SEMANTIC_LIMIT と relativeCut が上限を押さえる）。
 * 間違った接頭辞は本文として埋め込まれて全クエリを寄せるので、付けないのが安全側。
 */
const FALLBACK: EmbeddingProfile = {
  queryPrefix: "",
  semDistMax: 1.0,
  semRelMargin: 0.12,
  actorDistMax: 1.0,
};

/** `:latest` などのタグを落として引く。Ollama は同じモデルを別表記で返すことがある。 */
function normalize(model: string): string {
  return model.trim().replace(/:latest$/i, "");
}

const warned = new Set<string>();

/** 現在の埋め込みモデルに対応する較正値。未知なら安全側の既定を返して1度だけ警告する。 */
export function embeddingProfile(): EmbeddingProfile {
  const model = normalize(aiModel("OLLAMA_EMBED"));
  const profile = PROFILES[model];
  if (profile) return profile;

  if (!warned.has(model)) {
    warned.add(model);
    console.warn(
      `[WARN][embeddingProfile] 較正値が未登録のモデル: ${model}. ` +
        `接頭辞なし・しきい値無効の既定で動きます。` +
        `packages/database/src/embeddingProfiles.ts に実測値を追加してください。`,
    );
  }
  return FALLBACK;
}

/** テスト用。未知モデル警告の抑制状態を戻す。 */
export function resetEmbeddingProfileWarnings(): void {
  warned.clear();
}

/** 登録済みモデル名の一覧（テスト・診断用）。 */
export const KNOWN_EMBEDDING_MODELS = Object.keys(PROFILES);
