import {
  db,
  nagiActors,
  nagiMutes,
  nagiPosts,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import {
  type ActorView,
  type MuteSubjectType,
  type MutesView,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { ApiError } from "../middleware/errors.js";
import { normalizeTag, postLacksTags } from "./tags.js";

/**
 * ビューアのミュート対象。**このデータが本人以外のレスポンスへ混ざらないよう注意すること**
 * （ミュートは非公開情報。フィルタ条件として使うだけで、一覧は getMutesView からしか出さない）。
 */
export type MuteSet = { actors: string[]; tags: string[] };
export const EMPTY_MUTES: MuteSet = { actors: [], tags: [] };

/** タグの長さ上限。投稿の tag facet（Bluesky と同じ640バイト）に収まる範囲で十分。 */
const MAX_TAG_LENGTH = 640;

/**
 * ビューアのミュート一覧。未ログイン(viewerDid なし)なら空＝何もフィルタしない。
 * リクエストごとに1回だけ引き、各クエリへ MuteSet を渡し回す。
 */
export async function loadMutes(viewerDid?: string): Promise<MuteSet> {
  if (!viewerDid) return EMPTY_MUTES;
  const rows = await db
    .select({ subjectType: nagiMutes.subjectType, subject: nagiMutes.subject })
    .from(nagiMutes)
    .where(eq(nagiMutes.muterDid, viewerDid));
  if (!rows.length) return EMPTY_MUTES;
  return {
    actors: rows.flatMap((r) => (r.subjectType === "actor" ? [r.subject] : [])),
    tags: rows.flatMap((r) => (r.subjectType === "tag" ? [r.subject] : [])),
  };
}

/**
 * ミュート対象 DID を text[] パラメータとして1回だけ束縛する。
 * sql.param が必須。素の配列を埋めると ($1, $2, ...) というレコード構成子に展開され、
 * text[] へのキャストが壊れる（ミュート1件のときだけ偶然動いてしまうので気付きにくい）。
 */
export const mutedActorsParam = (mutes: MuteSet) =>
  sql`${sql.param(mutes.actors)}::text[]`;

/**
 * 共有TL・検索に共通の、ミュート由来の可視性条件。and(...) にそのまま撒ける配列を返す。
 * 判定は3点:
 *  1. 投稿者本人がミュート対象なら出さない
 *  2. スレッドルートの著者がミュート対象なら、他人の返信もふくめて出さない
 *     （ルートを見たくない相手なら、その会話自体も興味がないという整理）
 *  3. ミュートしたタグを持つなら出さない（旧チャンネル投稿はチャンネル名のタグとして見る）
 * apply で経路ごとに切り替える: プロフィールフィードは両方 false。タグ TL は開いたタグだけを
 * exceptTag で外す（自分で開いたタグまで隠すと、そのタグのページが空になるため）。
 */
export function muteVisibility(
  mutes: MuteSet,
  apply: { actors: boolean; tags: boolean; exceptTag?: string },
): SQL[] {
  const conditions: SQL[] = [];
  if (apply.actors && mutes.actors.length) {
    const actors = mutedActorsParam(mutes);
    conditions.push(notInArray(nagiPosts.did, mutes.actors));
    conditions.push(sql`
      case
        when ${nagiPosts.replyRootUri} is null then true
        else coalesce((
          select thread_root.did <> all(${actors})
          from nagi.posts as thread_root
          where thread_root.uri = ${nagiPosts.replyRootUri}
            and thread_root.deleted_at is null
        ), false)
      end
    `);
  }
  const tags = apply.tags
    ? mutes.tags.filter((tag) => tag !== apply.exceptTag)
    : [];
  if (tags.length) conditions.push(postLacksTags(tags));
  return conditions;
}

/**
 * 会話グループ化の代表選出 `not exists (... sib ...)` に足す条件。
 * これが無いと、スレッドの最新投稿がミュート相手だったときに代表が1件も残らず、
 * スレッドごと TL から消える（1つ前の非ミュート投稿へフォールバックさせるための条件）。
 */
export const sibNotMuted = (mutes: MuteSet, apply: boolean) =>
  apply && mutes.actors.length
    ? sql` and sib.did <> all(${mutedActorsParam(mutes)})`
    : sql``;

/** 設定画面のミュート一覧。認証した本人の分しか組み立てないこと。 */
export async function getMutesView(viewerDid: string): Promise<MutesView> {
  const mutes = await loadMutes(viewerDid);
  return {
    actors: await fetchActorViews(mutes.actors),
    tags: [...mutes.tags].sort(),
  };
}

/** ミュート済みだが AppView 未取り込みの相手でも解除できるよう、行が無くても DID は返す。 */
async function fetchActorViews(dids: string[]): Promise<ActorView[]> {
  if (!dids.length) return [];
  const rows = await db
    .select({ actor: nagiActors, profile: nagiProfiles })
    .from(nagiActors)
    .leftJoin(nagiProfiles, eq(nagiProfiles.did, nagiActors.did))
    .where(inArray(nagiActors.did, dids));
  const byDid = new Map(rows.map((r) => [r.actor.did, r]));
  return dids.map((did) => {
    const row = byDid.get(did);
    return {
      did,
      handle: row?.actor.handle ?? did,
      ...(row?.profile?.displayName
        ? { displayName: row.profile.displayName }
        : {}),
      ...(row?.profile?.avatarCid
        ? {
            avatar: `/api/blob/${encodeURIComponent(did)}/${row.profile.avatarCid}`,
          }
        : {}),
    };
  });
}

/** ミュートの設定・解除。updateSeen と同じく冪等（二重実行しても同じ結果になる）。 */
export async function setMute(
  viewerDid: string,
  subjectType: MuteSubjectType,
  subject: string,
  muted: boolean,
): Promise<{ muted: boolean }> {
  if (subjectType === "actor") {
    if (!/^did:(plc|web):/.test(subject))
      throw new ApiError(400, "invalid_request", "subject must be a DID");
    if (subject === viewerDid)
      throw new ApiError(400, "invalid_request", "Cannot mute yourself");
  } else if (subjectType === "tag") {
    subject = normalizeTag(subject);
    // チャンネル名から移したタグは空白を含みうるので、空白は弾かない（解除できなくなる）。
    if (!subject || subject.length > MAX_TAG_LENGTH)
      throw new ApiError(400, "invalid_request", "subject must be a hashtag");
  } else {
    throw new ApiError(400, "invalid_request", "Unknown subjectType");
  }
  if (muted) {
    await db
      .insert(nagiMutes)
      .values({ muterDid: viewerDid, subjectType, subject })
      .onConflictDoNothing();
  } else {
    await db
      .delete(nagiMutes)
      .where(
        and(
          eq(nagiMutes.muterDid, viewerDid),
          eq(nagiMutes.subjectType, subjectType),
          eq(nagiMutes.subject, subject),
        ),
      );
  }
  return { muted };
}
