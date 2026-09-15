import { isSearxngConfigured, searxngSearch } from "../api/searxng/index.js";

/**
 * お絵描きの依頼に出てくる既存作品のキャラクターを、Danbooru のタグへ解決する。
 *
 * ## なぜ Danbooru か
 * 生成モデル（Animagine XL 4.0）は Danbooru のタグで学習されていて、キャラクターは
 * `shimakaze (kancolle)` のような **キャラクタータグ1語で呼び出せる**。ただし綴りが
 * 1文字でも違うと効かず、gemma にタグを書かせると知らないキャラほど尤もらしい嘘を書く。
 * Danbooru の wiki は日本語名を other_names に持っている（「島風」「島風(艦これ)」「ぜかまし」）
 * ので、投稿に書かれた名前のまま引いて、実在するタグだけを使う。
 *
 * ## 外見タグも足す
 * 2026-09-16 に同一シードで比べたところ、クレヨン LoRA 込みでは名前タグだけだと
 * 島風は「うさ耳リボンと縞ニーソの誰か」が小さく描かれるだけだった。Danbooru の共起タグ
 * （related_tag）から髪・目・服を足すと、はっきり本人になった。
 * 共起タグには露出系（島風なら panties が 0.56）も上位に来るので、**許可リストで拾う**。
 *
 * ## 失敗しても throw しない
 * 解決できなかったキャラは返さないだけ。呼び出し側は botたんの絵へ戻す。
 */

export type CharacterRequest = {
  /** 投稿に書かれた名前（原文のまま）。 */
  name: string;
  /** 作品名。分からなければ空文字。同名キャラの見分けに使う。 */
  series: string;
};

export type ResolvedCharacter = {
  request: CharacterRequest;
  /** プロンプトに入れる形（アンダースコアは空白へ）。例: `shimakaze (kancolle)` */
  tag: string;
  /** 作品タグ。例: `kantai collection`。取れなければ undefined。 */
  series?: string;
  countTag: "1girl" | "1boy";
  appearance: string[];
  postCount: number;
};

const DEFAULT_BASE_URL = "https://danbooru.donmai.us";
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "bsky-affirmative-bot/1.0 (+https://github.com/suibari/bsky-affirmative-bot)";

/** これより投稿の少ないタグはモデルが覚えていない。誤ったタグを掴んだ可能性も高い。 */
export const MIN_CHARACTER_POST_COUNT = 30;
/** 同名キャラの見分けで作品を調べる候補数。1候補につき1回 API を叩く。 */
const MAX_SERIES_CHECKS = 3;
const MAX_APPEARANCE_TAGS = 10;
const MIN_APPEARANCE_FREQUENCY = 0.25;

const CATEGORY_COPYRIGHT = 3;
const CATEGORY_CHARACTER = 4;

/** `DANBOORU_BASE_URL=off` で解決を止める（キャラ名の依頼は botたんの絵に戻る）。 */
export function isCharacterLookupEnabled(): boolean {
  return process.env.DANBOORU_BASE_URL?.trim().toLowerCase() !== "off";
}

function baseUrl(): string {
  return (process.env.DANBOORU_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function danbooru<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${baseUrl()}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(Number(process.env.DANBOORU_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`danbooru ${path} HTTP ${response.status}`);
  return (await response.json()) as T;
}

type WikiPage = { title?: unknown; other_names?: unknown };
type Tag = { name?: unknown; post_count?: unknown; category?: unknown };
type RelatedTags = { related_tags?: Array<{ tag?: Tag; frequency?: unknown }> };

/** 「Hatsune Miku」→「hatsune_miku」。英語の投稿（Nagi）の名前をタグとして直接試す。 */
export function toDanbooruTag(text: string): string | null {
  const tag = text.trim().toLowerCase().replace(/\s+/g, "_");
  return /^[\x21-\x7e]+$/.test(tag) ? tag : null;
}

/** プロンプトに入れる形。サイドカーは括弧を重み記法として読まないので、エスケープしない。 */
const promptForm = (tag: string) => tag.replace(/_/g, " ");

/** 日本語名から wiki を引く。other_names は完全一致で、表記ゆれは Danbooru 側が持っている。 */
async function wikiTitlesByOtherName(name: string): Promise<Map<string, string[]>> {
  const pages = await danbooru<WikiPage[]>("wiki_pages.json", {
    "search[other_names_match]": name,
    only: "title,other_names",
    limit: "10",
  });
  const titles = new Map<string, string[]>();
  for (const page of Array.isArray(pages) ? pages : []) {
    if (typeof page.title !== "string") continue;
    const otherNames = Array.isArray(page.other_names)
      ? page.other_names.filter((value): value is string => typeof value === "string")
      : [];
    titles.set(page.title, otherNames);
  }
  return titles;
}

async function fetchTags(names: string[]): Promise<Array<{ name: string; postCount: number; category: number }>> {
  if (names.length === 0) return [];
  const tags = await danbooru<Tag[]>("tags.json", {
    "search[name_comma]": names.join(","),
    only: "name,post_count,category",
    limit: String(names.length),
  });
  return (Array.isArray(tags) ? tags : []).flatMap((tag) =>
    typeof tag.name === "string"
      ? [{ name: tag.name, postCount: Number(tag.post_count) || 0, category: Number(tag.category) }]
      : [],
  );
}

/**
 * 共起タグ。**失敗しても空で続ける。** 投稿の多いタグ（hatsune_miku, 14万件）は
 * related_tag が HTTP 500 を返す（2026-09-16 実測）。そういうキャラほどモデルが
 * 名前だけで描けるので、外見・作品なしでキャラタグだけ使えば足りる。
 */
async function relatedTags(tag: string, category: "general" | "copyright", limit: number) {
  try {
    const body = await danbooru<RelatedTags>("related_tag.json", { query: tag, category, limit: String(limit) });
    return (body.related_tags ?? []).flatMap((entry) =>
      typeof entry.tag?.name === "string"
        ? [{ name: entry.tag.name, frequency: Number(entry.frequency) || 0 }]
        : [],
    );
  } catch (error) {
    console.warn(`[WARN][IMGGEN_CHARACTER] ${tag} の共起タグ(${category})が取れなかった:`, String(error));
    return [];
  }
}

/**
 * Danbooru で見つからない名前を、検索エンジン経由で Danbooru の URL から拾う。
 * wiki の other_names に無い呼び方（略称・愛称の一部）はここでしか取れない。
 */
async function titlesFromSearch(request: CharacterRequest): Promise<string[]> {
  if (!isSearxngConfigured()) return [];
  try {
    const { hits } = await searxngSearch(`${request.name} ${request.series} danbooru`.replace(/\s+/g, " "));
    const titles = new Set<string>();
    for (const hit of hits) {
      const match = hit.url.match(/danbooru\.donmai\.us\/(?:wiki_pages\/|posts\?tags=)([^&#?/]+)/);
      if (!match) continue;
      try {
        titles.add(decodeURIComponent(match[1].replace(/\+/g, " ")).trim().replace(/\s+/g, "_").toLowerCase());
      } catch {
        // 壊れたエスケープは捨てる。
      }
    }
    return [...titles];
  } catch (error) {
    console.warn("[WARN][IMGGEN_CHARACTER] 検索でのキャラ解決に失敗:", error);
    return [];
  }
}

/** 作品名を作品タグの集合にする。「艦これ」→ kantai_collection。 */
async function seriesTags(series: string): Promise<Set<string>> {
  if (!series.trim()) return new Set();
  const names = new Set((await wikiTitlesByOtherName(series)).keys());
  const direct = toDanbooruTag(series);
  if (direct) names.add(direct);
  const tags = await fetchTags([...names]);
  return new Set(tags.filter((tag) => tag.category === CATEGORY_COPYRIGHT).map((tag) => tag.name));
}

/**
 * 外見として拾ってよい共起タグ。**許可リストにする。** 除外リストだけだと、
 * 露出系のタグが新しい言い回しで来るたびにすり抜ける。
 */
const APPEARANCE_PATTERN =
  /(hair|eyes|ahoge|twintails|ponytail|braid|bangs|sidelocks|hair bun|animal ears|cat ears|fox ears|dog ears|rabbit ears|tail|horns|wings|halo|hat|beret|cap|hood|ribbon|bow|hairband|headband|headgear|headdress|hairclip|glasses|eyepatch|freckles|mole|fang|dark skin|gloves|thighhighs|pantyhose|kneehighs|socks|boots|shoes|loafers|sandals|skirt|dress|shirt|blouse|jacket|coat|uniform|serafuku|sailor collar|collar|necktie|neckerchief|scarf|kimono|haori|hakama|japanese clothes|vest|sweater|hoodie|cape|cloak|armor|apron|shorts|pants|sleeves|earrings|necklace|choker|armband|belt|mask|gakuran|suit)/;

const APPEARANCE_EXCLUDE =
  /(\(|panties|underwear|breast|cleavage|navel|nipple|highleg|micro|thong|bikini|swimsuit|lingerie|\bbra\b|garter|\bass\b|groin|midriff|crop top|revealing|nude|naked|see-through|torn|wet|bare|no pants|no shoes|pantyshot|upskirt|hair over|hand in|holding|looking|open clothes|open shirt|off shoulder|strapless|sideboob|underboob|backless|skindentation|shiny skin|tan|blood|injury|bandage)/;

const COLORS =
  "(?:black|brown|blonde|white|grey|silver|red|pink|orange|yellow|green|aqua|blue|purple|light brown|light blue|light purple|dark blue|dark green)";

/**
 * 1人に1つしか無い属性。共起タグは集合絵の他キャラまで拾うので、竈門炭治郎が
 * long hair / short hair / black hair / brown hair を全部持ってくる。頻度の高いほうだけ残す。
 */
const EXCLUSIVE_GROUPS = [
  /^(?:very long|long|medium|short|very short) hair$/,
  new RegExp(`^${COLORS} hair$`),
  new RegExp(`^${COLORS} eyes$`),
];

/**
 * 共起タグから外見だけを拾う。「gloves」と「elbow gloves」が両方来たら細かいほうを残す。
 * 性別は 1girl と 1boy（male focus）の頻度で決める（竈門炭治郎は 1boy 0.41 / 1girl 0.39 と
 * 拮抗するので male focus を足す）。
 */
export function pickAppearance(related: Array<{ name: string; frequency: number }>): {
  countTag: "1girl" | "1boy";
  appearance: string[];
} {
  const frequency = (name: string) => related.find((tag) => tag.name === name)?.frequency ?? 0;
  const countTag = frequency("1boy") + frequency("male_focus") > frequency("1girl") ? "1boy" : "1girl";

  const candidates = [...related]
    .sort((a, b) => b.frequency - a.frequency)
    .filter((tag) => tag.frequency >= MIN_APPEARANCE_FREQUENCY)
    .map((tag) => promptForm(tag.name))
    .filter((tag) => APPEARANCE_PATTERN.test(tag) && !APPEARANCE_EXCLUDE.test(tag))
    // 頻度順に並べてあるので、同じ組の2つ目以降は捨てる。
    .filter((tag, index, all) => {
      const group = EXCLUSIVE_GROUPS.find((pattern) => pattern.test(tag));
      return !group || all.findIndex((other) => group.test(other)) === index;
    });
  const specific = candidates.filter(
    (tag) => !candidates.some((other) => other !== tag && other.endsWith(` ${tag}`)),
  );
  return { countTag, appearance: specific.slice(0, MAX_APPEARANCE_TAGS) };
}

type Candidate = { name: string; postCount: number; otherNames: string[] };

async function resolveOne(request: CharacterRequest): Promise<ResolvedCharacter | null> {
  const titles = await wikiTitlesByOtherName(request.name);
  const direct = toDanbooruTag(request.name);
  if (direct && !titles.has(direct)) titles.set(direct, []);

  let tags = (await fetchTags([...titles.keys()])).filter(
    (tag) => tag.category === CATEGORY_CHARACTER && tag.postCount >= MIN_CHARACTER_POST_COUNT,
  );
  if (tags.length === 0) {
    const searched = (await titlesFromSearch(request)).filter((title) => !titles.has(title));
    tags = (await fetchTags(searched.slice(0, 20))).filter(
      (tag) => tag.category === CATEGORY_CHARACTER && tag.postCount >= MIN_CHARACTER_POST_COUNT,
    );
  }
  if (tags.length === 0) return null;

  const candidates: Candidate[] = tags
    .map((tag) => ({ ...tag, otherNames: titles.get(tag.name) ?? [] }))
    .sort((a, b) => b.postCount - a.postCount)
    .slice(0, MAX_SERIES_CHECKS);

  // 同名キャラ（島風は艦これとアズールレーンに居る）を作品で見分ける。
  const copyrights = await Promise.all(
    candidates.map(async (candidate) => (await relatedTags(candidate.name, "copyright", 3))[0]?.name),
  );
  const wanted = await seriesTags(request.series).catch(() => new Set<string>());
  const series = request.series.trim();
  const pickIndex = (() => {
    if (series) {
      // 「島風(艦これ)」のように作品名込みの別名を持っていれば、それが一番確か。
      const byOtherName = candidates.findIndex((candidate) =>
        candidate.otherNames.some((otherName) => otherName.includes(series)),
      );
      if (byOtherName >= 0) return byOtherName;
      const byCopyright = copyrights.findIndex((copyright) => copyright && wanted.has(copyright));
      if (byCopyright >= 0) return byCopyright;
    }
    return 0; // 投稿数の多いほう。
  })();

  const chosen = candidates[pickIndex];
  const { countTag, appearance } = pickAppearance(await relatedTags(chosen.name, "general", 60));
  return {
    request,
    tag: promptForm(chosen.name),
    ...(copyrights[pickIndex] && copyrights[pickIndex] !== "original"
      ? { series: promptForm(copyrights[pickIndex]!) }
      : {}),
    countTag,
    appearance,
    postCount: chosen.postCount,
  };
}

/**
 * 依頼されたキャラをまとめて解決する。解決できなかったものは落とす（順序は保つ）。
 * 同じタグに解決された重複も落とす（「島風」と「ぜかまし」）。
 */
export async function resolveCharacters(requests: CharacterRequest[]): Promise<ResolvedCharacter[]> {
  if (requests.length === 0 || !isCharacterLookupEnabled()) return [];
  const resolved: ResolvedCharacter[] = [];
  for (const request of requests) {
    try {
      const character = await resolveOne(request);
      if (!character) {
        console.warn("[WARN][IMGGEN_CHARACTER] キャラを解決できなかった:", request);
        continue;
      }
      if (resolved.some((other) => other.tag === character.tag)) continue;
      console.log(
        `[INFO][IMGGEN_CHARACTER] ${request.name}(${request.series || "?"}) -> ${character.tag} ` +
          `[${character.series ?? "?"}] posts=${character.postCount} ${character.countTag} ` +
          `appearance=${character.appearance.join(", ")}`,
      );
      resolved.push(character);
    } catch (error) {
      console.warn("[WARN][IMGGEN_CHARACTER] キャラ解決に失敗:", request, error);
    }
  }
  return resolved;
}
