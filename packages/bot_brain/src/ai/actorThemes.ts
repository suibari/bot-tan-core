/**
 * 「その人がふだん何について書いているか」をローカルLLMで言葉にし、ニュース記事との
 * 突合まで担う。全肯定ニュースの動的枠に付ける「おすすめの理由：〜」の材料。
 *
 * ## なぜ埋め込みではなくLLMなのか
 *
 * 当初はテーマを埋め込んで記事ベクトルとの cosine 距離で選ぶ設計だったが、実測で
 * 成立しないと分かった。裸の語（「音楽愛」「車好き」）とニュース見出しの距離は
 * 0.911〜1.06 に潰れ、順位もほぼ乱数（「車好き」→アイドルMV、「愛猫家」→庭の記事）。
 * クエリ接頭辞を付けても改善しない。語は文書でもクエリでもないため。
 *
 * そこで距離を捨て、LLMに直接「どのテーマに当たるか、当たらなければ none」を判定させる。
 * 尺度の問題が消え、「当たらない」を明示的に選べるのが効く。
 *
 * ## 呼び出し位置
 *
 * リクエスト経路では絶対に呼ばない。ワーカーが先に計算して nagi.news_reasons へ置き、
 * AppView はそれを読むだけにする（モデレーションと同じ「保存してから判定」）。
 */
import { ollamaChat } from "../ollamaChat.js";

/** 1人あたりのテーマ数の上限。多いと突合プロンプトが膨らみ、粒度も粗くなる。 */
export const MAX_ACTOR_THEMES = 6;
/** テーマ抽出に渡す投稿数。多すぎると num_ctx を食う。 */
export const THEME_SOURCE_POSTS = 40;
/**
 * 1回の突合で見る記事数。
 *
 * 一致した記事だけを掲載する方針なので、ここが狭いとセクションが常に空になる。
 * 本番実測では10件/人で 200ペア中12件しか当たらなかった（＝当たりは希少）ので、
 * 当たりの機会そのものを増やす。ローカルLLMの1リクエストなのでコストは横ばい。
 */
export const MAX_MATCH_ARTICLES = 30;

const THEME_SCHEMA = {
  type: "object",
  properties: {
    themes: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_ACTOR_THEMES,
    },
  },
  required: ["themes"],
} as const;

const THEME_SYSTEM_PROMPT = `あなたはSNSの投稿群を読んで、その人がふだん書いている話題を洗い出す担当です。

出力する話題の条件:
- その人が繰り返し書いている具体的な題材だけを挙げる（例: 猫、ラーメン、自作PC、クラシック音楽、登山、育児）。
- 1つを2〜10文字程度の日本語の名詞句にする。文にしない。
- 多くて${MAX_ACTOR_THEMES}個。少なくてよい。該当がなければ空配列。

挙げてはいけないもの:
- 性格や気分の評価（やさしい、元気、ポジティブ、丁寧 など）。話題ではない。
- あいさつ、返信、実況、独り言など内容の無いもの。
- SNSの機能名やサービス名そのもの（フォロー、リポスト、Bluesky など）。
- 1度しか出てこない題材。

JSONだけを返してください。`;

/** 投稿本文からテーマを抽出する。Ollama 不通なら例外を投げる（呼び出し側が次回へ回す）。 */
export async function extractActorThemes(posts: string[]): Promise<string[]> {
  const sample = posts
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length >= 4)
    .slice(0, THEME_SOURCE_POSTS);
  if (sample.length < 5) return [];
  const raw = await ollamaChat(
    "OLLAMA_ACTOR_THEMES",
    [
      { role: "system", content: THEME_SYSTEM_PROMPT },
      {
        role: "user",
        content: sample.map((text, i) => `${i + 1}. ${text}`).join("\n"),
      },
    ],
    // num_predict は必ず送る（省くと生成枠が残りコンテキスト任せになり空応答を招く）。
    { maxTokens: 256, temperature: 0, format: THEME_SCHEMA, timeoutMs: 60_000 },
  );
  return normalizeThemes(raw);
}

/** LLM 出力の掃除。重複・空・長すぎる語を落とす。抽出結果の検証はここに集約する。 */
export function normalizeThemes(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const themes = (parsed as { themes?: unknown })?.themes;
  if (!Array.isArray(themes)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of themes) {
    if (typeof item !== "string") continue;
    const theme = item.replace(/[#＃\s]/g, "").trim();
    // 20文字を超えるものは名詞句ではなく文なので落とす。
    if (!theme || theme.length > 20 || seen.has(theme)) continue;
    seen.add(theme);
    out.push(theme);
    if (out.length >= MAX_ACTOR_THEMES) break;
  }
  return out;
}

const MATCH_SYSTEM_PROMPT = `あなたは、ある人の関心テーマと、ニュース記事の見出しを突き合わせる担当です。

記事ごとに、その人のテーマのうち**実際にその記事の題材と重なるもの**を1つだけ選びます。
どれとも重ならなければ null を選びます。

厳しく判定してください:
- 「なんとなく明るい」「その人が好きそう」では選ばない。題材が重なっているかだけを見る。
- テーマ一覧に無い言葉を作らない。必ず与えられた語をそのまま返す。
- 迷ったら null。理由は出さないほうがましで、外した理由を出すのがいちばん悪い。

記事は入力と同じ順序・同じ件数で返してください。JSONだけを返してください。`;

const matchSchema = (count: number) =>
  ({
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: { type: ["string", "null"] },
        minItems: count,
        maxItems: count,
      },
    },
    required: ["matches"],
  }) as const;

/**
 * テーマ一覧と記事見出しを突き合わせ、記事ごとに当たったテーマ（無ければ null）を返す。
 * 戻り値の長さは必ず `titles` と同じ。
 */
export async function matchNewsToThemes(
  themes: string[],
  titles: string[],
): Promise<Array<string | null>> {
  const articles = titles.slice(0, MAX_MATCH_ARTICLES);
  if (!themes.length || !articles.length) return titles.map(() => null);
  const raw = await ollamaChat(
    "OLLAMA_NEWS_THEME_MATCH",
    [
      { role: "system", content: MATCH_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `テーマ: ${themes.join(" / ")}`,
          "",
          "記事:",
          ...articles.map((title, i) => `${i + 1}. ${title}`),
        ].join("\n"),
      },
    ],
    {
      // 記事数に比例させる。num_predict が足りないと配列が途中で切れ、
      // JSON パースに失敗して全件 null（＝理由が一切出ない）に落ちる。
      maxTokens: 128 + articles.length * 16,
      temperature: 0,
      format: matchSchema(articles.length),
      timeoutMs: 60_000,
    },
  );
  return normalizeMatches(raw, themes, titles.length);
}

/**
 * 突合結果の掃除。**テーマ一覧に無い語は捨てる**（LLM が語を作って理由を捏造するのを塞ぐ）。
 * 件数が合わない場合も null で埋め、記事と理由がずれないようにする。
 */
export function normalizeMatches(
  raw: string,
  themes: string[],
  count: number,
): Array<string | null> {
  const allowed = new Set(themes);
  const out: Array<string | null> = new Array(count).fill(null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const matches = (parsed as { matches?: unknown })?.matches;
  if (!Array.isArray(matches)) return out;
  for (let i = 0; i < count && i < matches.length; i++) {
    const value = matches[i];
    if (typeof value === "string" && allowed.has(value)) out[i] = value;
  }
  return out;
}
