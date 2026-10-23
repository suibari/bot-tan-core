import { MemoryService } from "@bsky-affirmative-bot/clients";
import { botDayRange, type BotOwnPostKind } from "@bsky-affirmative-bot/shared-configs";

/**
 * botたん自身の発言の記憶。定期ポスト（おはよう / 気まぐれ / おやすみ / ひとりごと）の本文と、
 * おやすみで言った「明日やりたいこと」を bot_state の1行に持つ。
 *
 * 相手の発言は bot_memory_documents にあるが、自分の発言はどこにも無かった。そのため
 * 定期ポストは毎回その場の材料から組み立てられ、さっき言ったことの続きを書けず、
 * 前夜に「明日は〇〇したい」と言っても翌日の自分はそれを知らなかった。
 *
 * 書き込むのは biorhythm の step の中だけで、step は重ならないので読み書きは競合しない。
 */
export const SELF_POST_MEMORY_KEY = "self_post_memory";

/** 載せるのは直近24時間ぶん。それより前はダイジェストと行動履歴の役目。 */
const OWN_POST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** ひとりごとは1日8本まで出るので、件数でも絞る。 */
export const MAX_OWN_POSTS = 6;
/** 保存する本文の上限。プロンプトではさらに短く切る。 */
const MAX_STORED_TEXT_LENGTH = 300;

export interface SelfPostMemory {
  posts: { at: string; kind: BotOwnPostKind; text: string }[];
  tomorrowHook?: {
    text: string;
    /** このひとことを載せる bot 日。おやすみを書いた bot 日の翌日。 */
    forBotDate: string;
  };
}

const KINDS: readonly BotOwnPostKind[] = ["morning", "whimsical", "goodnight", "monologue"];

export const emptySelfPostMemory = (): SelfPostMemory => ({ posts: [] });

/** DB の値は古い形・壊れた形でも落ちないように読む。 */
export function normalizeSelfPostMemory(raw: unknown): SelfPostMemory {
  if (!raw || typeof raw !== "object") return emptySelfPostMemory();
  const value = raw as Partial<SelfPostMemory>;
  const posts = Array.isArray(value.posts)
    ? value.posts.filter((post): post is SelfPostMemory["posts"][number] =>
        Boolean(post) &&
        typeof post.at === "string" &&
        typeof post.text === "string" &&
        KINDS.includes(post.kind),
      )
    : [];
  const hook = value.tomorrowHook;
  return {
    posts,
    ...(hook && typeof hook.text === "string" && typeof hook.forBotDate === "string"
      ? { tomorrowHook: { text: hook.text, forBotDate: hook.forBotDate } }
      : {}),
  };
}

export function recordOwnPost(
  state: SelfPostMemory,
  post: { kind: BotOwnPostKind; text: string; now: Date },
): SelfPostMemory {
  const text = post.text.trim().slice(0, MAX_STORED_TEXT_LENGTH);
  if (!text) return state;
  const since = post.now.getTime() - OWN_POST_WINDOW_MS;
  return {
    ...state,
    posts: [
      ...state.posts.filter((item) => Date.parse(item.at) >= since),
      { at: post.now.toISOString(), kind: post.kind, text },
    ].slice(-MAX_OWN_POSTS),
  };
}

/** おやすみを書いた bot 日の翌日に載せる。深夜0〜3時のおやすみも同じ bot 日として数える。 */
export function setTomorrowHook(
  state: SelfPostMemory,
  hook: { text: string; now: Date },
): SelfPostMemory {
  return {
    ...state,
    tomorrowHook: {
      text: hook.text,
      forBotDate: botDayRange(botDayRange(hook.now).end).date,
    },
  };
}

export function recentOwnPostsFor(state: SelfPostMemory, now: Date): SelfPostMemory["posts"] {
  const since = now.getTime() - OWN_POST_WINDOW_MS;
  return state.posts.filter((post) => Date.parse(post.at) >= since).slice(-MAX_OWN_POSTS);
}

export function tomorrowHookFor(state: SelfPostMemory, now: Date): string | undefined {
  const hook = state.tomorrowHook;
  return hook && hook.forBotDate === botDayRange(now).date ? hook.text : undefined;
}

export async function loadSelfPostMemory(): Promise<SelfPostMemory> {
  try {
    return normalizeSelfPostMemory(await MemoryService.getBotState(SELF_POST_MEMORY_KEY));
  } catch (error) {
    console.warn("[WARN][SELF_POST_MEMORY] 読めなかったので空として扱う", error);
    return emptySelfPostMemory();
  }
}

/**
 * 投稿できたあとに呼ぶ。記録に失敗しても投稿は済んでいるので投げない
 * （次のポストが1本ぶん自分の発言を知らないだけで済む）。
 */
export async function rememberOwnPost(post: {
  kind: BotOwnPostKind;
  text: string;
  tomorrowJa?: string;
  now?: Date;
}): Promise<void> {
  const now = post.now ?? new Date();
  try {
    let state = recordOwnPost(await loadSelfPostMemory(), { kind: post.kind, text: post.text, now });
    if (post.tomorrowJa) state = setTomorrowHook(state, { text: post.tomorrowJa, now });
    await MemoryService.setBotState(SELF_POST_MEMORY_KEY, state);
  } catch (error) {
    console.warn("[WARN][SELF_POST_MEMORY] 自分の投稿を記録できなかった", error);
  }
}
