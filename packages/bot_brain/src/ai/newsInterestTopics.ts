/**
 * botたんが覚えた固有名（bot_memory の印象語）を、ニュース取得に使える**広いジャンル**へ
 * 一般化する。全肯定ニュースの取得クエリをみんなの嗜好へ寄せるための材料。
 *
 * ## なぜ固有名をそのまま検索しないのか
 *
 * 印象語は会話に出てきた作品名・商品名・人名で入ってくる。そのまま NewsData の q に
 * すると、当たるのは公式発表と宣伝だけで、当たらない日は0件になる。1日20クレジット
 * しかない取得枠を、特定の固有名の有無に賭ける形になってしまう。
 *
 * 欲しいのは「その人がアニメを見る人だ」という一段上の情報のほうで、そこまで広げれば
 * 記事は毎日ある。個々の記事がその人に刺さるかどうかは、掲載後にニュース推薦
 * （nagi.news_reasons / 埋め込み最近傍）が面倒を見る。**取得を広く、選択を細かく**。
 *
 * ## 検証はジャンル名との照合だけ
 *
 * LLM に自由に書かせると固有名がそのまま返ってくる（それでは一般化になっていない）。
 * そこで出力は下のジャンル名と照合し、合致しなければ捨てる。ジャンル名はそのまま
 * NewsData の検索語にもなるので、ジャンルごとの検索式は持たない。
 * actorThemes.ts の normalizeMatches と同じ「一覧に無い語は捨てる」方針。
 */
import { ollamaChat } from "../ollamaChat.js";

/**
 * ニュース取得に使えるジャンルの一覧。
 *
 * 粒度の基準は「日本語ニュースが毎日1件はある広さ」。作品名・人名・商品名は入れない
 * （それは一般化の対象であって、結果ではない）。**そのまま NewsData の検索語になる**
 * ので、1語で成立する言葉にしておくこと。
 */
export const NEWS_INTEREST_GENRES: readonly string[] = [
  "アニメ", "マンガ", "ゲーム", "アイドル", "音楽", "映画", "ドラマ", "小説",
  "お笑い", "将棋", "猫", "犬", "動物園", "水族館", "料理", "スイーツ",
  "コーヒー", "旅行", "鉄道", "自動車", "宇宙", "科学", "AI", "ガジェット",
  "職人", "手芸", "イラスト", "美術", "写真", "園芸", "登山", "キャンプ",
  "スポーツ", "野球", "サッカー", "健康", "育児", "ファッション", "歴史",
  "祭り", "自然",
];

const GENRES = new Set(NEWS_INTEREST_GENRES);

/** 一覧にあるジャンルか。取得側はこれを通ったものだけを検索語に使う。 */
export function isNewsInterestGenre(value: string): boolean {
  return GENRES.has(value);
}

/** 1回の一般化に渡す印象語の数。多いと num_ctx を食い、判定も粗くなる。 */
export const MAX_LABELS_PER_CALL = 30;
/** 一度に面倒を見る印象語の総数。上位からこの数だけ見る。 */
export const MAX_INTEREST_LABELS = 120;

const SYSTEM_PROMPT = `あなたは、SNSの会話に出てきた言葉を「ニュース検索に使える広いジャンル」へ置き換える担当です。

入力は作品名・商品名・人名・趣味の言葉などの一覧です。
それぞれについて、次のジャンル一覧から**もっとも近いものを1つだけ**選んでください。
どれにも当てはまらなければ null を選びます。

ジャンル一覧:
${NEWS_INTEREST_GENRES.join(" / ")}

守ること:
- 入力の言葉をそのまま返さない。必ずジャンル一覧の語をそのまま返す。
- 作品名・商品名は、それが属するジャンルへ置き換える。
- 人名は、その人が主に活動している分野のジャンルにする。分からなければ null。
- あいさつ・感情・SNSの機能名など、話題として成立しないものは null。
- 迷ったら null。間違ったジャンルを選ぶより、選ばないほうがよい。

入力と同じ順序・同じ件数で返してください。JSONだけを返してください。`;

const responseSchema = (count: number) =>
  ({
    type: "object",
    properties: {
      topics: {
        type: "array",
        items: { type: ["string", "null"] },
        minItems: count,
        maxItems: count,
      },
    },
    required: ["topics"],
  }) as const;

/**
 * LLM 出力の掃除。**ジャンル一覧に合致しない語は捨てる**（固有名がそのまま検索へ
 * 漏れるのを塞ぐ）。件数が合わなくてもラベルとジャンルがずれないよう null で埋める。
 */
export function normalizeInterestTopics(
  raw: string,
  count: number,
): Array<string | null> {
  const out: Array<string | null> = new Array(count).fill(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const topics = (parsed as { topics?: unknown })?.topics;
  if (!Array.isArray(topics)) return out;
  for (let i = 0; i < count && i < topics.length; i++) {
    const value = topics[i];
    if (typeof value === "string" && GENRES.has(value)) out[i] = value;
  }
  return out;
}

/** 印象語1件と、その重み（推薦されたものほど大きい）。 */
export interface InterestLabel {
  label: string;
  weight: number;
}

export interface GeneralizedInterestTopic {
  topic: string;
  /** そのジャンルへ寄せられた印象語の重みの合計。取得クエリの優先順位になる。 */
  score: number;
  /** そのジャンルへ寄せられた印象語の数。ログと運用確認のため。 */
  labelCount: number;
}

async function mapChunk(labels: string[]): Promise<Array<string | null>> {
  const raw = await ollamaChat(
    "OLLAMA_NEWS_INTEREST_TOPICS",
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: labels.map((label, i) => `${i + 1}. ${label}`).join("\n"),
      },
    ],
    {
      // 件数に比例させる。足りないと配列が途中で切れ、パース失敗＝全件 null になる。
      maxTokens: 128 + labels.length * 16,
      temperature: 0,
      format: responseSchema(labels.length),
      timeoutMs: 60_000,
    },
  );
  return normalizeInterestTopics(raw, labels.length);
}

/**
 * 印象語の一覧をジャンルへ畳む。Ollama 不通なら例外を投げる（呼び出し側が次回へ回す）。
 *
 * 重みは「同じジャンルへ寄った印象語の重みの合計」。そのジャンルの作品名が何度も
 * 会話に出ているコミュニティなら上位に来る、という素朴な数え方でよい。
 */
export async function generalizeInterestLabels(
  labels: InterestLabel[],
): Promise<GeneralizedInterestTopic[]> {
  const input = labels
    .filter((item) => item.label.trim() && item.weight > 0)
    .slice(0, MAX_INTEREST_LABELS);
  if (!input.length) return [];

  const scores = new Map<string, { score: number; labelCount: number }>();
  for (let start = 0; start < input.length; start += MAX_LABELS_PER_CALL) {
    const chunk = input.slice(start, start + MAX_LABELS_PER_CALL);
    const mapped = await mapChunk(chunk.map((item) => item.label));
    chunk.forEach((item, i) => {
      const topic = mapped[i];
      if (!topic) return;
      const current = scores.get(topic) ?? { score: 0, labelCount: 0 };
      current.score += item.weight;
      current.labelCount += 1;
      scores.set(topic, current);
    });
  }

  return [...scores.entries()]
    .map(([topic, value]) => ({ topic, ...value }))
    .sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic));
}
