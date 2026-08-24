import {
  MemoryService,
  SEASONAL_WORKS_STATE_KEY,
  SEASONAL_WORK_KINDS as WORK_KINDS,
  isSeasonalWorkKind,
  type SeasonalWork,
  type SeasonalWorkKind as WorkKind,
  type SeasonalWorksState,
} from "@bsky-affirmative-bot/clients";
import { generateContentWithRetry } from "@bsky-affirmative-bot/bot-brain";
import { BOT_TASTE_BRIEF_JA } from "@bsky-affirmative-bot/shared-configs";
import { jstDateString } from "./jstDate.js";

/**
 * botたんが「いま何を見ているか」を具体的な作品名で描けるようにするための、今期の話題作リスト。
 *
 * 取得はグラウンディング付きの Gemini 1回。呼ぶのは日次予定表を作るときだけで、しかも
 * 7日キャッシュするので実質は週1回。step ごとに叩くと1日最大288回になるので、そこは通さない。
 */
export { SEASONAL_WORKS_STATE_KEY, WORK_KINDS };
export type { SeasonalWork, SeasonalWorksState, WorkKind };

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000;
// 1日に作品へ触れる予定は4〜6件。キャッシュは7日もつので、7日ぶんの露出は
// 30件前後になる。種別ごと4件では候補が足りず、同じ作品が週に何度も出る
// （2026-08-24 の配信で同じ曲の話が繰り返された件）。
const MAX_PER_KIND = 8;
const MAX_TOTAL = 64;
/** 直近この日数で予定に出した作品は、次の予定表では避けさせる。 */
const RECENTLY_USED_DAYS = 3;
const MAX_TITLE_LENGTH = 40;
const MAX_ENGLISH_TITLE_LENGTH = 80;
const MAX_HOOK_LENGTH = 180;

/**
 * 除外キーワード。
 *
 * dislikethings.json をそのまま使えないのは、あれが「会話で触れない話題」の説明句
 * （「過激な性的表現」など）であって、作品ジャンルの禁止リストではないため。部分一致には向かない。
 * さらに、あれで一律に弾くとペルソナと矛盾する: botたんは「映画はホラーやスプラッター系が好き」で、
 * 能力バトルものも好み。つまり暴力表現そのものは除外理由にならない。
 * 線引きは「実在の出来事を主題にしているか」に置き、その観点の語だけをここに並べる。
 */
const NG_KEYWORDS = [
  "ドキュメンタリー",
  "実録",
  "戦争",
  "軍事",
  "選挙",
  "政権",
  "内閣",
  "宗教",
  "教団",
  "事件簿",
  "アダルト",
  "エロ",
  "R-18",
  "R18",
];

/**
 * 表記ゆれを吸収してから突き合わせるための正規化。
 *
 * LLM が返す作品名は、全角・半角や大小文字が揺れる。素の includes で比べると
 * 突き合わせが外れ、「使った」印が付かないまま候補に残り続ける
 * （bot_memory_impressions では 2459件中 last_used_at が1件しか入っていなかった）。
 */
export function normalizeForMatch(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, "");
}

/** アニメのクール境界（1/4/7/10月）で切る季節キー。"2026-summer" 形式。 */
export function seasonKey(now: Date = new Date()): string {
  const [year, month] = jstDateString(now).split("-");
  const seasons = ["winter", "spring", "summer", "autumn"] as const;
  return `${year}-${seasons[Math.floor((Number(month) - 1) / 3)]}`;
}

/** グラウンディングのクエリに載せる、人間向けの季節ラベル。 */
export function seasonLabel(now: Date = new Date()): string {
  const [year, month] = jstDateString(now).split("-");
  const names = ["冬", "春", "夏", "秋"];
  return `${year}年 ${names[Math.floor((Number(month) - 1) / 3)]}クール`;
}

export function isSeasonalWorksFresh(
  state: SeasonalWorksState | undefined,
  now: Date = new Date(),
): boolean {
  if (!state || state.works.length === 0) return false;
  if (state.season !== seasonKey(now)) return false;
  const fetchedAt = Date.parse(state.fetchedAt);
  if (!Number.isFinite(fetchedAt)) return false;
  return now.getTime() - fetchedAt < TTL_MS;
}

/** 失敗直後は再試行しない。step は最短5分間隔なので、素通しすると失敗ループになる。 */
export function isInFailureBackoff(
  state: SeasonalWorksState | undefined,
  now: Date = new Date(),
): boolean {
  if (!state?.failedAt) return false;
  const failedAt = Date.parse(state.failedAt);
  if (!Number.isFinite(failedAt)) return false;
  return now.getTime() - failedAt < FAILURE_BACKOFF_MS;
}

/**
 * 新形式「種別<TAB>日本語名<TAB>英語名<TAB>日本語フック<TAB>英語フック」と、
 * 旧形式「種別<TAB>名前」の両方をパースする。
 *
 * grounding 併用時は responseSchema を付けられない（Google Search と排他）ので、
 * 構造は正規表現とバリデーションで担保する。generateSingleResponse を使わないのは、
 * あちらが `[...]` を全消しして引用マーカーごと本文を壊すため。
 */
export function parseSeasonalWorks(text: string): SeasonalWork[] {
  const perKind = new Map<WorkKind, SeasonalWork[]>();
  const seen = new Set<string>();

  for (const rawLine of text.split("\n")) {
    // 箇条書き記号・連番・検索引用マーカーを落とす。
    const line = rawLine
      .replace(/\[\d+\]/g, "")
      .replace(/^\s*[-*・]\s*/, "")
      .replace(/^\s*\d+[.)]\s*/, "")
      .trim();
    if (!line) continue;

    const match = line.match(/^([A-Za-z]+)\s*(?:\t|[:：])\s*(.+)$/);
    if (!match) continue;
    const kind = match[1].toLowerCase();
    if (!isSeasonalWorkKind(kind)) continue;

    const [rawTitle, rawTitleEn, rawHookJa, rawHookEn] = match[2]
      .split("\t")
      .map((value) => value.trim());
    const title = rawTitle?.replace(/^[「『"']|[」』"']$/g, "").trim();
    if (!title || title.length > MAX_TITLE_LENGTH) continue;
    if (NG_KEYWORDS.some((word) => title.includes(word))) continue;
    const titleEn = rawTitleEn?.replace(/^[「『"']|[」』"']$/g, "").trim();
    const hookJa = rawHookJa?.trim();
    const hookEn = rawHookEn?.trim();
    const hasCompleteHook = Boolean(titleEn && hookJa && hookEn);
    if (
      (titleEn && titleEn.length > MAX_ENGLISH_TITLE_LENGTH) ||
      (hookJa && hookJa.length > MAX_HOOK_LENGTH) ||
      (hookEn && hookEn.length > MAX_HOOK_LENGTH) ||
      (!hasCompleteHook && (titleEn || hookJa || hookEn))
    ) {
      continue;
    }

    const dedupeKey = `${kind}\u0000${title}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const works = perKind.get(kind) ?? [];
    if (works.length >= MAX_PER_KIND) continue;
    works.push({
      kind,
      title,
      ...(hasCompleteHook
        ? { titleEn, hookJa, hookEn }
        : {}),
    });
    perKind.set(kind, works);
  }

  // 種別ごとに丸めたあと、全体上限で切る。1種別が全部持っていかないよう順序は WORK_KINDS 順。
  const works: SeasonalWork[] = [];
  for (const kind of WORK_KINDS) {
    works.push(...(perKind.get(kind) ?? []));
  }
  return works.slice(0, MAX_TOTAL);
}

export const SEASONAL_WORKS_PROMPT = (label: string) =>
  `いま（${label}）の日本で話題になっている、放送中・配信中・連載中・上映中・発売中のものを検索して教えてください。
選ぶ相手は、次の趣味を持つ10代の女の子です。

${BOT_TASTE_BRIEF_JA}

出力形式（厳守）:
* 1行1件、「種別<TAB>日本語の正式名称<TAB>英語の正式名称<TAB>日本語のネタフック<TAB>英語のネタフック」だけを書く。
* 種別は ${WORK_KINDS.join(" / ")} のいずれか。
  - hobby はフィギュア、プラモデル、ボードゲーム、かわいい雑貨などの新作。
  - music は曲名かアルバム名。
* ネタフックは、作品に実際にある場面・構図・人物・アイテムを、日記の比喩へ転用できる一文で要約する。台詞の引用、重大なネタバレ、推測は書かない。
* 日本語・英語とも検索で確認できた事実だけを書き、各フックは180文字以内にする。
* 説明・順位・記号・引用・URL・注記は一切書かない。
* 各種別ごとに最大${MAX_PER_KIND}件、合計${MAX_TOTAL}行以内。
* 見出しや前置きの文は書かない。

選ぶ基準:
* 上の趣味に合っていて、いま友達と話題にできるもの。
* 種別ごとに1件も見つからなければ、その種別は行ごと省略してよい（無理に埋めない）。
* 次を**主題とする**ものは除外する：実在の戦争・軍事、政治・国際情勢、宗教、差別、実在の事件や犯罪、性的表現を主目的とするもの。
  - フィクションのホラー、スプラッター、バトル、ミステリーは**除外しない**（この子の好みです）。
* 実在が確認できないものは書かない。`;

async function loadState(): Promise<SeasonalWorksState | undefined> {
  const raw = await MemoryService.getBotState(SEASONAL_WORKS_STATE_KEY);
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Partial<SeasonalWorksState>;
  if (typeof value.season !== "string" || typeof value.fetchedAt !== "string") {
    return undefined;
  }
  return {
    season: value.season,
    fetchedAt: value.fetchedAt,
    ...(typeof value.failedAt === "string" ? { failedAt: value.failedAt } : {}),
    works: Array.isArray(value.works)
      ? value.works.filter(
          (work): work is SeasonalWork =>
            Boolean(work) &&
            typeof (work as SeasonalWork).title === "string" &&
            isSeasonalWorkKind(String((work as SeasonalWork).kind)),
        )
      : [],
  };
}

/**
 * 今期の話題作。キャッシュが生きていれば DB 1 read で返す。
 *
 * 取得に失敗しても投げない。前回の works があればそれを、無ければ空配列を返し、
 * 呼び出し側（日次予定表）は作品セクションごと省く。「無い日を語らせない」方針。
 */
export async function ensureSeasonalWorks(
  now: Date = new Date(),
): Promise<SeasonalWork[]> {
  const state = await loadState();
  if (isSeasonalWorksFresh(state, now)) return state!.works;
  if (isInFailureBackoff(state, now)) return state?.works ?? [];

  try {
    const response = await generateContentWithRetry({
      feature: "BIORHYTHM_SEASONAL_WORKS",
      // 32行のリスト＋grounding の付随テキストで投稿用の上限を超えうる。投稿にはならず、
      // 余計な行は parseSeasonalWorks が落とすので、長さでのやり直しは無駄。
      maxTextLength: null,
      contents: [SEASONAL_WORKS_PROMPT(seasonLabel(now))],
      // grounding と responseSchema は排他なので、構造は parseSeasonalWorks が担保する。
      config: { tools: [{ googleSearch: {} }] },
    });
    const works = parseSeasonalWorks(response.text ?? "");
    if (works.length === 0) throw new Error("No seasonal works parsed");

    const next: SeasonalWorksState = {
      season: seasonKey(now),
      fetchedAt: new Date(now.getTime()).toISOString(),
      works,
    };
    await MemoryService.setBotState(SEASONAL_WORKS_STATE_KEY, next);
    console.log(`[INFO][BIORHYTHM] Seasonal works refreshed: ${works.length} items`);
    return works;
  } catch (error) {
    console.error("[ERROR][BIORHYTHM] Failed to refresh seasonal works:", error);
    await MemoryService.setBotState(SEASONAL_WORKS_STATE_KEY, {
      season: state?.season ?? seasonKey(now),
      fetchedAt: state?.fetchedAt ?? new Date(0).toISOString(),
      failedAt: new Date(now.getTime()).toISOString(),
      works: state?.works ?? [],
    } satisfies SeasonalWorksState).catch(() => {});
    return state?.works ?? [];
  }
}

/** プロンプトを日本語で通すための種別ラベル。 */
const KIND_LABELS_JA: Record<WorkKind, string> = {
  anime: "アニメ",
  manga: "漫画",
  game: "ゲーム",
  drama: "ドラマ",
  movie: "映画",
  novel: "小説",
  music: "音楽",
  hobby: "ホビー",
};

/** 直近 RECENTLY_USED_DAYS 日のうちに予定へ出した作品名。 */
export function recentlyUsedTitles(
  works: SeasonalWork[],
  now: Date = new Date(),
): string[] {
  const since = now.getTime() - RECENTLY_USED_DAYS * 24 * 60 * 60 * 1000;
  return works
    .filter((work) => {
      const used = Date.parse(work.lastUsedAt ?? "");
      return Number.isFinite(used) && used >= since;
    })
    .map((work) => work.title);
}

/**
 * 使った作品に印を付けて書き戻す。日次予定表を保存した直後に1回だけ呼ぶ。
 *
 * **候補からは外さない。** music のように候補が数件しかない種別だと、外した瞬間に
 * その枠ごと消えてしまう。避けるかどうかはプロンプトで伝える。
 */
export function applyUsedMarks(
  works: SeasonalWork[],
  titles: string[],
  usedAt: string,
): SeasonalWork[] | undefined {
  const wanted = new Set(
    titles.map((title) => normalizeForMatch(title)).filter(Boolean),
  );
  if (wanted.size === 0) return undefined;
  let marked = 0;
  const next = works.map((work) => {
    if (!wanted.has(normalizeForMatch(work.title))) return work;
    marked++;
    return { ...work, lastUsedAt: usedAt };
  });
  return marked > 0 ? next : undefined;
}

export async function markSeasonalWorksUsed(
  titles: string[],
  now: Date = new Date(),
  deps: {
    load?: typeof loadState;
    save?: (state: SeasonalWorksState) => Promise<unknown>;
  } = {},
): Promise<number> {
  const load = deps.load ?? loadState;
  const save = deps.save
    ?? ((state: SeasonalWorksState) =>
      MemoryService.setBotState(SEASONAL_WORKS_STATE_KEY, state));

  const state = await load();
  if (!state || state.works.length === 0) return 0;
  const usedAt = new Date(now.getTime()).toISOString();
  const works = applyUsedMarks(state.works, titles, usedAt);
  if (!works) return 0;

  await save({ ...state, works });
  return works.filter((work) => work.lastUsedAt === usedAt).length;
}

/** 日次予定表のプロンプトに差し込むブロック。空なら何も出さない。 */
export function buildSeasonalWorksSection(
  works: SeasonalWork[],
  now: Date = new Date(),
): string {
  if (works.length === 0) return "";
  const kinds = WORK_KINDS.map((kind) => KIND_LABELS_JA[kind]).join("・");
  const recent = recentlyUsedTitles(works, now);
  const avoid = recent.length > 0
    ? `\n  - **直近${RECENTLY_USED_DAYS}日で使ったので、今日は次の候補を避けてください**（他に選べるものが無いときだけ使ってよい）：「${recent.join("」「")}」`
    : "";
  return `
-----いま話題のもの（検索で取得した実在の名前）-----
* ${kinds} に触れる予定を作るときは、**必ず下の候補から具体的な名前を選んで予定文に書いてください。**
  - **「${MEDIA_GENERIC_NOUNS.slice(0, 8).join("」「")}」のような一般名詞だけで予定を書いてはいけません。**
    「アニソンを聴く」ではなく「『◯◯』の主題歌を聴く」、「ゲームをする」ではなく「『◯◯』を進める」と書くこと。
  - 候補から名前を選べないなら、**その予定は作品に触れない別の内容にしてください**（散歩、料理、片付けなど）。中途半端に一般名詞で濁さないこと。
  - **候補にない名前を書いてはいけません**（実在しないものを作らないこと）。
  - 1日のうち作品に触れる予定は4〜6件を目安にして、**同じ種別に偏らせないこと**（アニメばかりにしない。ドラマ・小説・音楽・ホビーも混ぜる）。
  - **Sleep（夢の中）の予定こそ作品名を出してください。**「かっこいいロボットが戦ってる夢」「不思議な能力バトルの夢」のような一般名詞で終わらせず、「『◯◯』のロボットに乗ってる夢」のように候補の作品名で書くこと。
  - Study 中の予定にだけは作品名を入れないこと（勉強中なので）。
  - ホビーは「見る」ではなく、組み立てる・飾る・眺める・遊ぶといった予定にすること。${avoid}
${JSON.stringify(works.map(({ kind, title }) => ({ kind, title })))}`;
}

/**
 * 作品に触れていそうなのに固有名詞が無い予定を見つける。
 *
 * 「お気に入りのアニソンを聴きながら」のような一般名詞のままの予定を作られると、
 * 描写側がどう頑張っても固有名詞にならない（描写は予定を情景に起こすだけなので）。
 * プロンプトの指示だけでは守られなかったので、生成後に機械で検査して作り直させる。
 */
export const MEDIA_GENERIC_NOUNS = [
  "アニメ",
  "アニソン",
  "ゲーム",
  "漫画",
  "ドラマ",
  "映画",
  "小説",
  "フィギュア",
  "プラモデル",
];

/** 検査用。「マンガ」の表記ゆれだけ表示用リストに足す形で吸収する。 */
const GENERIC_NOUN_PATTERNS = [
  ...MEDIA_GENERIC_NOUNS.map((noun) => new RegExp(noun)),
  /マンガ/,
  /プラモ/,
];

export function findGenericMediaEvents<T extends { status: string; activity: string }>(
  events: T[],
  works: SeasonalWork[],
  additionalNames: string[] = [],
): T[] {
  if (works.length === 0 && additionalNames.length === 0) return [];
  const titles = [...works.map((work) => work.title), ...additionalNames];
  return events.filter((event) => {
    // 勉強中は作品名を入れない方針なので対象外。
    if (event.status === "Study") return false;
    if (!GENERIC_NOUN_PATTERNS.some((pattern) => pattern.test(event.activity))) return false;
    return !titles.some((title) => event.activity.includes(title));
  });
}
