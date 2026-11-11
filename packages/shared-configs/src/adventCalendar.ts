/**
 * Nagi のアドベントカレンダー（12/1〜12/25）。
 *
 * 毎日ひとつ、botたんがみんなの今年のポストから嬉しい「もの・できごと」を選んで、
 * Nagi ユーザーみんなへのプレゼントカードにする。
 *
 * **日付の区切りは JST 0:00**（カードの 4:00 境界ではない）。カレンダーの「◯日」は
 * 暦どおりに開くもので、公開の少し前にサーバが選んでおき、0:00 にだけ見せる。
 */

export const ADVENT_DAYS = 25;
/** botたんが選ぶ時刻は、公開（JST 0:00）のこれだけ前。LLM が遅れても 0:00 に間に合わせる。 */
export const ADVENT_SELECT_LEAD_MS = 60 * 60_000;
/** 対象にするポストの起点。Nagi のリリース月（2026-07）から。 */
export const ADVENT_POSTS_SINCE = "2026-07-01T00:00:00+09:00";

const JST_OFFSET_MS = 9 * 60 * 60_000;

/** その年の12月 day 日 JST 0:00。 */
export function adventPublishAt(year: number, day: number): Date {
  return new Date(Date.UTC(year, 11, day) - JST_OFFSET_MS);
}

export function adventSelectAt(year: number, day: number): Date {
  return new Date(adventPublishAt(year, day).getTime() - ADVENT_SELECT_LEAD_MS);
}

/** いまの JST の年。 */
export function adventYear(now: Date = new Date()): number {
  return new Date(now.getTime() + JST_OFFSET_MS).getUTCFullYear();
}

/** 公開済みの最新の日（0 = まだ1日も開いていない）。12/26 以降は 25 のまま。 */
export function adventOpenedDay(year: number, now: Date = new Date()): number {
  let opened = 0;
  for (let day = 1; day <= ADVENT_DAYS; day += 1)
    if (adventPublishAt(year, day).getTime() <= now.getTime()) opened = day;
  return opened;
}

/** 選出を始めてよい日（選出時刻を過ぎた日）。 */
export function adventDueDays(year: number, now: Date = new Date()): number[] {
  const days: number[] = [];
  for (let day = 1; day <= ADVENT_DAYS; day += 1)
    if (adventSelectAt(year, day).getTime() <= now.getTime()) days.push(day);
  return days;
}

export const isAdventDay = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= ADVENT_DAYS;

/** 12月に Nagi を始めた人か（JST）。 */
export function joinedInAdventMonth(year: number, joinedAt: Date): boolean {
  const from = Date.UTC(year, 11, 1) - JST_OFFSET_MS;
  const until = Date.UTC(year + 1, 0, 1) - JST_OFFSET_MS;
  return joinedAt.getTime() >= from && joinedAt.getTime() < until;
}

export type AdventCandidatePost = {
  uri: string;
  cid: string;
  did: string;
  text: string;
  /** 本人が直した値があればそちら。 */
  valence: number;
  createdAt: number;
};

export type AdventCandidateUser = {
  did: string;
  /** 過去のアドカレで選ばれたことがあるか。 */
  picked: boolean;
  joinedThisMonth: boolean;
  /** その人の候補。valence の高い順・新しい順で最大 ADVENT_POSTS_PER_USER 件。 */
  posts: AdventCandidatePost[];
};

export const ADVENT_POSTS_PER_USER = 3;

/** 日ごとに並びが変わり、同じ日なら何度走らせても同じ並びになる軽いハッシュ（FNV-1a）。 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 候補者の並び。
 *
 * 1. まだ選ばれていない人を先に（選ばれた人は、ほかに候補がいなくなったときだけ）
 * 2. 12月に始めた人を先に
 * 3. あとは日ごとのくじ引き
 *
 * **投稿数や気分の強さでは並べない。** たくさん書く人や大げさに書く人が毎回先頭に来るのを
 * 避けるため。適切な候補が1件でもあれば、投稿の少ない人も同じくじに入る。
 * 最終的に「嬉しさが伝わるか」はモデルが候補を読んで決める。
 */
export function rankAdventCandidates(
  users: readonly AdventCandidateUser[],
  seed: string,
): AdventCandidateUser[] {
  return users
    .filter((user) => user.posts.length > 0)
    .map((user) => ({ user, lot: hash(`${seed}:${user.did}`) }))
    .sort(
      (a, b) =>
        Number(a.user.picked) - Number(b.user.picked) ||
        Number(b.user.joinedThisMonth) - Number(a.user.joinedThisMonth) ||
        a.lot - b.lot,
    )
    .map(({ user }) => ({
      ...user,
      posts: [...user.posts]
        .sort((a, b) => b.valence - a.valence || b.createdAt - a.createdAt)
        .slice(0, ADVENT_POSTS_PER_USER),
    }));
}

/** ポストをモデルへ渡すときの最大文字数。長文は頭だけで嬉しさが読み取れる。 */
export const ADVENT_POST_TEXT_LIMIT = 400;
