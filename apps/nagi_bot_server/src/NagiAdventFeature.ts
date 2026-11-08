import {
  db,
  nagiActors,
  nagiAdventCards,
  nagiAdventRejections,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import {
  generateAdventPick,
  type AdventPickResult,
} from "@bsky-affirmative-bot/bot-brain";
import {
  ADVENT_POSTS_PER_USER,
  ADVENT_POSTS_SINCE,
  ADVENT_POST_TEXT_LIMIT,
  adventPublishAt,
  adventSelectAt,
  joinedInAdventMonth,
  rankAdventCandidates,
  type AdventCandidatePost,
  type AdventCandidateUser,
} from "@bsky-affirmative-bot/shared-configs";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * アドベントカレンダーの1日ぶんのカードを選ぶ。
 *
 * 「計算はサーバ、読み解きと選択はモデル」の分担（ゼンカツ部長賞と同じ）。
 * サーバは除外条件と優先順位（未選出 > 12月に始めた人 > くじ）で候補者を並べ、
 * 数人ずつモデルへ渡す。モデルが「どれも載せられない」と返したら次の数人へ進む。
 */

/** 1回にモデルへ渡す人数。1人3件までなので最大18件。 */
export const ADVENT_USERS_PER_BATCH = 6;
/** 1日に試す回数の上限。超えたら気分の足切りを1段ゆるめてやり直す。 */
const MAX_BATCHES = 5;
/** 気分の足切り（-5〜+5）。まずはっきり嬉しいものから。 */
const VALENCE_STEPS = [3, 2] as const;
/** 短すぎるポストは「もの・できごと」が読み取れない。 */
const MIN_TEXT_LENGTH = 12;

const botDids = (): string[] => [
  ...new Set(
    [process.env.NAGI_BOT_DID, process.env.BSKY_DID].filter(
      (did): did is string => !!did,
    ),
  ),
];

type CandidateRow = {
  uri: string;
  cid: string;
  did: string;
  text: string;
  valence: number;
  created_at: string | Date;
  joined_at: string | Date;
  picked: boolean;
};

/**
 * 候補のポスト。1人あたり気分の高い順・新しい順に ADVENT_POSTS_PER_USER 件まで。
 *
 * 除外するもの:
 * - こっそり（返信はスレッドの最初の投稿で判定）・削除済み・botたん
 * - 自動判定のラベル付き・判定待ち・本人のセルフラベル付き・CW（`||`）付き
 * - ブログ記事、他人への返信（自分のスレッドへの続きの返信は入れる）
 * - プロフィールにラベルが付いた人（アバターをカードに載せるため）
 * - すでにカードになったポスト、その年に botたんが「どれも載せられない」と判断した回のポスト
 *
 * 3行日記は posts に射影済みなので、そのまま対象になる。
 */
export async function loadAdventCandidates(input: {
  year: number;
  day: number;
  minValence: number;
  /** その日すでにモデルへ見せて選ばれなかったポスト。 */
  excludeUris?: Iterable<string>;
  /**
   * 選出履歴を DB（advent_cards）ではなく呼び出し側が持つ。シミュレーション用で、
   * advent_cards が無い DB（本番の読み取り専用接続など）でも動く。
   */
  history?: AdventHistory;
  /** 対象ポストの上限時刻。省略時はその日の選出時刻。 */
  until?: Date;
}): Promise<AdventCandidateUser[]> {
  const history = input.history;
  const excludeUris = [
    ...(input.excludeUris ?? []),
    ...(history?.usedUris ?? []),
    ...(history?.rejectedUris ?? []),
  ];
  // AGENTS.md: raw sql に Date を直接補間しない。ISO 文字列＋明示キャスト。
  const since = new Date(ADVENT_POSTS_SINCE).toISOString();
  const until = (input.until ?? adventSelectAt(input.year, input.day)).toISOString();
  const excluded = botDids();
  const rows = await db.execute<CandidateRow>(sql`
    with eligible as (
      select p.uri, p.cid, p.did, p.text,
             coalesce(m.user_valence, m.valence)::int as valence,
             p.record_created_at as created_at,
             pr.created_at as joined_at,
             row_number() over (
               partition by p.did
               order by coalesce(m.user_valence, m.valence) desc, p.record_created_at desc
             ) as rank
        from nagi.posts p
        join nagi.post_moods m
          on m.post_uri = p.uri and m.cid = p.cid and m.expressive
        join nagi.actors a on a.did = p.did and a.status = 'active'
        join nagi.profiles pr on pr.did = p.did
        left join nagi.posts root on root.uri = p.reply_root_uri
        left join nagi.posts parent on parent.uri = p.reply_parent_uri
       where p.deleted_at is null
         and not p.kossori
         and p.record_created_at >= ${since}::timestamptz
         and p.record_created_at < ${until}::timestamptz
         and coalesce(m.user_valence, m.valence) >= ${input.minValence}
         and p.moderation_version is not null
         and cardinality(p.moderation_labels) = 0
         and cardinality(p.self_labels) = 0
         and cardinality(pr.moderation_labels) = 0
         and position('||' in p.text) = 0
         and char_length(btrim(p.text)) >= ${MIN_TEXT_LENGTH}
         and coalesce(p.record_json->>'article', '') <> 'true'
         and (
           p.reply_root_uri is null
           or (root.did = p.did and parent.did = p.did
               and not root.kossori and root.deleted_at is null)
         )
         ${excluded.length ? sql`and p.did not in (${sql.join(excluded.map((did) => sql`${did}`), sql`, `)})` : sql``}
         ${excludeUris.length ? sql`and p.uri not in (${sql.join(excludeUris.map((uri) => sql`${uri}`), sql`, `)})` : sql``}
         ${history ? sql`` : sql`and not exists (
           select 1 from nagi.advent_cards used where used.post_uri = p.uri
         )
         and not exists (
           select 1 from nagi.advent_rejections r
            where r.post_uri = p.uri and r.year = ${input.year}
         )`}
    )
    select e.uri, e.cid, e.did, e.text, e.valence, e.created_at, e.joined_at,
           ${history ? sql`false` : sql`exists (
             select 1 from nagi.advent_cards c
              where c.did = e.did and c.year = ${input.year}
           )`} as picked
      from eligible e
     where e.rank <= ${ADVENT_POSTS_PER_USER}
  `);

  const users = new Map<string, AdventCandidateUser>();
  for (const row of rows) {
    const post: AdventCandidatePost = {
      uri: row.uri,
      cid: row.cid,
      did: row.did,
      text: row.text,
      valence: Number(row.valence),
      createdAt: new Date(row.created_at).getTime(),
    };
    const joinedAt = new Date(row.joined_at);
    const user = users.get(row.did) ?? {
      did: row.did,
      picked: Boolean(row.picked) || Boolean(history?.pickedDids.has(row.did)),
      joinedThisMonth: history?.isNewcomer
        ? history.isNewcomer(joinedAt)
        : joinedInAdventMonth(input.year, joinedAt),
      posts: [],
    };
    user.posts.push(post);
    users.set(row.did, user);
  }
  return [...users.values()];
}

/** シミュレーション用の選出履歴。 */
export type AdventHistory = {
  usedUris: Set<string>;
  pickedDids: Set<string>;
  /** 「どれも載せられない」と判断された回のポスト。 */
  rejectedUris: Set<string>;
  /** 「12月に始めた人」の判定を差し替える（12月より前に試すとき用）。 */
  isNewcomer?: (joinedAt: Date) => boolean;
};

/** モデルに1回見せた結果。シミュレーションの記録用。 */
export type AdventBatchLog = {
  minValence: number;
  rejectedAll?: boolean;
  candidates: { did: string; name: string; text: string; valence: number; picked: boolean; newcomer: boolean }[];
  pick: number;
};

const jstDate = (ms: number) =>
  new Date(ms + 9 * 60 * 60_000).toISOString().slice(0, 10);

type Picker = typeof generateAdventPick;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * 並べた候補者を数人ずつモデルへ渡し、最初に選ばれた1件を返す。
 * 選ばれなかった候補群は、その日のうちは二度と渡さない。
 * 試す回数（maxBatches）を超えたら undefined。呼び出し側が足切りをゆるめてやり直す。
 */
export async function pickAdventCard(input: {
  day: number;
  ranked: AdventCandidateUser[];
  names: Map<string, string>;
  picker?: Picker;
  maxBatches?: number;
  /** モデルに見せたポスト。足切りをゆるめてやり直すとき、同じものを見せ直さない。 */
  shown?: Set<string>;
  onBatch?: (log: Omit<AdventBatchLog, "minValence">) => void;
  /** モデルが回ごと不採用にしたポスト。その年はもう候補にしない。 */
  onReject?: (uris: string[]) => Promise<void> | void;
}): Promise<{ post: AdventCandidatePost; result: AdventPickResult } | undefined> {
  const picker = input.picker ?? generateAdventPick;
  const maxBatches = input.maxBatches ?? MAX_BATCHES;
  // 優先度の違う人を同じ回に混ぜない。混ぜるとモデルが後回しにすべき人を選びうるので、
  // 「12月に始めた人を優先」「選ばれた人は候補がある限り後回し」が守れない。
  // 回の順: 未選出の新規 → 未選出 → 選出済み。
  const tier = (user: AdventCandidateUser) => (user.picked ? 2 : user.joinedThisMonth ? 0 : 1);
  const batches = [0, 1, 2]
    .flatMap((level) =>
      chunk(input.ranked.filter((user) => tier(user) === level), ADVENT_USERS_PER_BATCH),
    )
    .slice(0, maxBatches);
  for (const users of batches) {
    const posts = users.flatMap((user) => user.posts);
    for (const post of posts) input.shown?.add(post.uri);
    const result = await picker({
      day: input.day,
      candidates: posts.map((post) => ({
        displayName: input.names.get(post.did)?.trim() || "この人",
        date: jstDate(post.createdAt),
        text: post.text.slice(0, ADVENT_POST_TEXT_LIMIT),
      })),
    });
    const byDid = new Map(users.map((user) => [user.did, user]));
    input.onBatch?.({
      pick: result.pick,
      rejectedAll: result.rejectedAll,
      candidates: posts.map((post) => ({
        did: post.did,
        name: input.names.get(post.did)?.trim() || "この人",
        text: post.text,
        valence: post.valence,
        picked: Boolean(byDid.get(post.did)?.picked),
        newcomer: Boolean(byDid.get(post.did)?.joinedThisMonth),
      })),
    });
    if (result.pick >= 1 && posts[result.pick - 1])
      return { post: posts[result.pick - 1], result };
    if (result.rejectedAll) await input.onReject?.(posts.map((post) => post.uri));
  }
  return undefined;
}

/**
 * year 年 12 月 day 日のカードを選ぶ（書き込みはしない）。候補が尽きたら undefined。
 */
export async function chooseAdventCard(
  year: number,
  day: number,
  options: { history?: AdventHistory; until?: Date; onBatch?: (log: AdventBatchLog) => void } = {},
) {
  const shown = new Set<string>();
  for (const minValence of VALENCE_STEPS) {
    const users = await loadAdventCandidates({
      year,
      day,
      minValence,
      excludeUris: shown,
      history: options.history,
      until: options.until,
    });
    if (!users.length) continue;
    const ranked = rankAdventCandidates(users, `${year}-12-${day}`);
    const profiles = await db
      .select({
        did: nagiProfiles.did,
        displayName: nagiProfiles.displayName,
        avatarCid: nagiProfiles.avatarCid,
        handle: nagiActors.handle,
      })
      .from(nagiProfiles)
      .innerJoin(nagiActors, eq(nagiActors.did, nagiProfiles.did))
      // 人数は利用者数で頭打ち（数百人規模）なので、まとめて引く。
      .where(inArray(nagiProfiles.did, ranked.map((user) => user.did)));
    const profileByDid = new Map(profiles.map((profile) => [profile.did, profile]));
    const names = new Map(profiles.map((profile) => [profile.did, profile.displayName]));

    const history = options.history;
    const chosen = await pickAdventCard({
      day,
      ranked,
      names,
      shown,
      onBatch: options.onBatch && ((log) => options.onBatch!({ ...log, minValence })),
      onReject: async (uris) => {
        if (history) {
          for (const uri of uris) history.rejectedUris.add(uri);
          return;
        }
        // 選出が失敗して再試行になっても、判断は残す。
        await db
          .insert(nagiAdventRejections)
          .values(uris.map((postUri) => ({ year, postUri })))
          .onConflictDoNothing();
      },
    });
    if (!chosen) continue;
    const profile = profileByDid.get(chosen.post.did);
    if (!profile) continue;
    return { ...chosen, profile };
  }
  return undefined;
}

/**
 * year 年 12 月 day 日のカードを選んで書く。すでにあれば何もしない（再実行で増えない）。
 * 候補が尽きたら例外にして、ジョブの再試行に回す（その間に新しいポストが増えうる）。
 */
export async function runNagiAdvent(year: number, day: number): Promise<void> {
  const [existing] = await db
    .select({ day: nagiAdventCards.day })
    .from(nagiAdventCards)
    .where(and(eq(nagiAdventCards.year, year), eq(nagiAdventCards.day, day)))
    .limit(1);
  if (existing) return;

  const chosen = await chooseAdventCard(year, day);
  if (!chosen) throw new Error(`advent: no card could be picked for ${year}-12-${day}`);
  await db
    .insert(nagiAdventCards)
    .values({
      year,
      day,
      did: chosen.post.did,
      postUri: chosen.post.uri,
      postCid: chosen.post.cid,
      titleJa: chosen.result.titleJa,
      titleEn: chosen.result.titleEn,
      commentJa: chosen.result.commentJa,
      commentEn: chosen.result.commentEn,
      displayName: chosen.profile.displayName,
      handle: chosen.profile.handle,
      avatarCid: chosen.profile.avatarCid,
      publishAt: adventPublishAt(year, day),
    })
    .onConflictDoNothing();
}
