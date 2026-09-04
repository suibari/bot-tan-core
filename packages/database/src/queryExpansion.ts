import { aiModel } from "@bsky-affirmative-bot/shared-configs";

/**
 * 検索クエリの別名展開。「まどマギ」→「まどマギ 魔法少女まどか☆マギカ」のように、
 * LLM が別名を知っている固有名詞だけを膨らませてから埋め込む。
 *
 * ## なぜ要るか
 *
 * 埋め込みモデル（qwen3-embedding:0.6b）は日本語のネットスラング的な略称の語彙が薄い。
 * 実測（docs/evaluations/embedding-semantic/）では「まどマギ」のクエリ埋め込みが
 * 文書空間の中心付近に落ち、関連文書と無関係文書がどちらも距離 0.463〜0.465 に潰れて
 * 順位が実質ランダムになっていた（あいまい検索の1〜2位に「コメダでマターリ」
 * 「マックのお月見」が出ていた症状の正体）。正式名称を足すと 0.465 → 0.352 まで下がる。
 *
 * ## 設計上の決定
 *
 * **別名は「コーパスの言語」で出す。クエリの言語ではない。** 検索対象が日本語の投稿
 * なので、日本語の別名だけを足す。これが両方向を同時に満たす:
 *   日本語クエリ: まどマギ → 魔法少女まどか☆マギカ         (nDCG@10 0.641 → 1.000)
 *   英語クエリ:   kantai collection → 艦隊これくしょん      (該当ヒット 0/10 → 10/10)
 * 逆に日本語クエリへ英語別名を足すと悪化する（zelda に The Legend of Zelda を足した版は
 * 0.287 → 0.225）。日本語コーパスからクエリベクトルが離れるため。
 *
 * **知らない語は触らない。** LLM が空配列を返したらクエリを素通しする。全クエリを一律に
 * 膨らませる方式（散歩 → ウォーキング 散策 運動…）も測ったが、固有名詞は上がる代わりに
 * 一般語 0.650 → 0.629 / 感情 0.553 → 0.518 と広く下げて、全体では現行を下回った。
 * 別名限定なら固有名詞以外の4カテゴリが**現行と完全に一致**する（悪化しようがない）。
 *
 * ## 失敗しても検索は止めない
 *
 * 生成に失敗・タイムアウト・未設定のときは元のクエリをそのまま返す。展開はあくまで
 * 上積みで、これが無くても検索は成立する。
 */

/**
 * 生成自体は1秒未満だが、生成側 Ollama は `OLLAMA_NUM_PARALLEL=1` なので
 * **bot の返信生成の後ろで順番待ちする**。空いていれば約0.8秒、混んでいると実測14秒。
 * 8秒だと混雑時に必ず落ちてサーキットが開き、展開が事実上死ぬので余裕を取る。
 *
 * 待たされるのは「botたんの気まぐれ」パネルだけで、🔍一致 は別リクエスト
 * （`mode` がクエリ文字列で分かれている）なので即座に返る。
 */
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * 連続失敗時に叩き続けない。ollamaEmbed と同じ考え方。
 * ただし失敗の主因は「混雑による順番待ち」で恒久的な障害ではないため、
 * 埋め込み側（60秒）より短くして復帰を早める。
 */
const DEFAULT_COOLDOWN_MS = 30_000;
/**
 * これより長いクエリは展開しない。長文は「検索語」ではなく文章で、別名の出番が無い。
 * 評価クエリの最長は16文字（「落ち込んでいるときに励まされた話」）。
 */
const DEFAULT_MAX_QUERY_LEN = 30;
/** プロセス内キャッシュの上限。検索語は繰り返されるので効きがよい。 */
const CACHE_LIMIT = 500;
/** 足す別名の個数上限。多いほどクエリがぼやける。 */
const MAX_ALIASES = 3;

let unavailableUntil = 0;
const cache = new Map<string, string>();

const positiveEnvNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** 既定は無効。env で明示的に開くまで挙動を変えない。 */
export function queryExpansionEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SEARCH_QUERY_EXPANSION?.trim() ?? "");
}

function aliasPrompt(query: string): string {
  return [
    "あなたは日本語の検索を補助するアシスタントです。",
    "与えられた検索語が**作品名・製品名・団体名などの固有名詞**で、かつ",
    "別の呼ばれ方（正式名称・略称・原語表記）があるなら、それらを挙げてください。",
    "",
    "規則:",
    "  - 固有名詞でない普通の言葉（散歩・仕事・猫など）は**必ず空配列**",
    "  - 別名を知らない固有名詞も**空配列**。推測で書かない",
    `  - 別名がある場合のみ、**日本語表記のみ**で正式名称・別称を${MAX_ALIASES}個まで`,
    "  - 英語・ローマ字の表記は入れない（検索対象が日本語の投稿のため。",
    "    検索語自体が英語やローマ字でも、返す別名は日本語にすること）",
    "  - 元の検索語の単なる言い換えや部分一致は入れない",
    "",
    "例:",
    '  入力: エヴァ        → ["エヴァンゲリオン", "新世紀エヴァンゲリオン"]',
    "  入力: 散歩          → []",
    '  入力: ポケモン      → ["ポケットモンスター"]',
    "  入力: 落ち込んだ話  → []",
    "",
    `検索語: ${query}`,
    "",
    "aliases に配列で入れて返してください。別名が無ければ空配列。",
  ].join("\n");
}

/**
 * Ollama ネイティブ `/api/chat` のリクエスト本体。
 *
 * **options に num_ctx を入れない。** サーバの OLLAMA_CONTEXT_LENGTH が唯一の源で、
 * 違う値を送ると同じモデルでも runner が作り直され、同居アプリごと巻き込む
 * （AGENTS.md「Ollama の num_ctx」）。num_predict は必ず送る。
 * OpenAI 互換ではなくネイティブを使うのは `think: false` を送るため。
 * テストから検証するため export している。
 */
export function buildAliasRequestBody(
  model: string,
  prompt: string,
  maxTokens: number,
) {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    // reasoning に生成枠を食わせない。切らないと aliases が空のまま返る。
    think: false,
    format: {
      type: "object",
      properties: { aliases: { type: "array", items: { type: "string" } } },
      required: ["aliases"],
    },
    options: {
      temperature: 0,
      num_predict: maxTokens,
    },
  };
}

/**
 * LLM の返した別名を絞る。
 * - 空・重複・元クエリと同一は捨てる
 * - **元のクエリを含む別名も捨てる**（「ウマ娘」→「ウマ娘 プリティーダービー」のような
 *   単なる語尾追加。プロンプトでも禁じているがすり抜けるので、コード側で確実に落とす）
 */
export function filterAliases(query: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const alias = String(item ?? "").trim();
    if (!alias) continue;
    const lower = alias.toLowerCase();
    if (lower === q || lower.includes(q) || seen.has(lower)) continue;
    seen.add(lower);
    out.push(alias);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

/**
 * 検索クエリを別名で膨らませる。展開できなければ元のクエリをそのまま返す。
 * 呼び出し側は戻り値をそのまま埋め込めばよい。
 */
export async function expandSearchQuery(query: string): Promise<string> {
  const text = query.trim();
  if (!text || !queryExpansionEnabled()) return text;

  const maxLen = positiveEnvNumber(
    "SEARCH_QUERY_EXPANSION_MAX_LEN",
    DEFAULT_MAX_QUERY_LEN,
  );
  if (text.length > maxLen) return text;

  const cached = cache.get(text);
  if (cached !== undefined) return cached;

  const baseUrl = process.env.OLLAMA_BASE_URL;
  if (!baseUrl || Date.now() < unavailableUntil) return text;
  // ネイティブ経路。OpenAI 互換だと think を切れない。
  const nativeUrl = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");

  const timeoutMs = positiveEnvNumber(
    "SEARCH_QUERY_EXPANSION_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
  );
  const cooldownMs = positiveEnvNumber(
    "SEARCH_QUERY_EXPANSION_COOLDOWN_MS",
    DEFAULT_COOLDOWN_MS,
  );

  try {
    const response = await fetch(`${nativeUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildAliasRequestBody(
          aiModel("OLLAMA_QUERY_EXPANSION"),
          aliasPrompt(text),
          256,
        ),
      ),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const content = ((await response.json()) as any)?.message?.content ?? "";
    const aliases = filterAliases(text, JSON.parse(content)?.aliases);
    const expanded = aliases.length ? `${text} ${aliases.join(" ")}` : text;

    // 先頭から捨てる素朴な上限。検索語は偏るので LRU まではしなくてよい。
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(text, expanded);
    unavailableUntil = 0;
    return expanded;
  } catch (error) {
    unavailableUntil = Date.now() + cooldownMs;
    console.warn(
      `[WARN][queryExpansion] 展開に失敗したので元のクエリを使う（${cooldownMs}ms 抑制）`,
      error,
    );
    return text;
  }
}

/** テスト用。プロセス内キャッシュとサーキットを初期化する。 */
export function resetQueryExpansionState(): void {
  cache.clear();
  unavailableUntil = 0;
}
