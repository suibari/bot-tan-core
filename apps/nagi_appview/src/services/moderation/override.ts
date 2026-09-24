import {
  db,
  nagiChannels,
  nagiEmojis,
  nagiModerationDecisions,
  nagiNews,
  nagiPosts,
  nagiProfiles,
} from "@bsky-affirmative-bot/database";
import { BLUEMOJI_ITEM, NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import { and, eq } from "drizzle-orm";
import { wakeModerationWorker } from "../../ingest/moderationWorker.js";
import { ensurePdsRecord } from "../../ingest/reconcileRepo.js";
import { parseRecordUri } from "../../ingest/recordUri.js";
import { allowOverrideApplies, type ModerationOverride } from "./rules.js";

/**
 * 運用者による判定の上書き（Discord の解除ボタン）。
 *
 * 上書きは moderation_decisions に「押した時点の cid」と一緒に書き、実際の表示の復元は
 * モデレーションワーカーに任せる。対象行を判定待ち（moderation_version = NULL）へ戻すと、
 * ワーカーが上書きを見て OpenAI を呼ばずに allow を確定させる。復元の書き込みを
 * ワーカーの applyDecision 1か所に寄せておけば、ここで表ごとの列を二重に持たずに済む。
 *
 * reject で落とした投影は AppView に本文が残っていない（PDS が真実源）ので、
 * ensurePdsRecord で PDS から取り直してから判定待ちへ戻す。rejectPost が消した翻訳・
 * 通知・コミュニティ肯定・botたんの返信ジョブは戻らない。
 */

export type OverrideStatus =
  /** reject で落とした投影を PDS から戻した。 */
  | "restored"
  /** label のラベルを外した。 */
  | "unlabeled"
  /** PDS 側で既に消えていた。上書きは残る。 */
  | "absent"
  /** 同じ内容に対して既に解除済み。 */
  | "already"
  | "not-found";

export type OverrideResult = {
  status: OverrideStatus;
  decision?: string;
  /** 判定後に編集されていた。上書きは効かず、新しい内容が通常どおり判定される。 */
  cidChanged?: boolean;
};

type DecisionRow = {
  uri: string;
  cid: string;
  did: string;
  collection: string;
  decision: string;
  override: string | null;
  overrideCid: string | null;
};

export type OverrideDeps = {
  loadDecision(uri: string): Promise<DecisionRow | undefined>;
  writeOverride(
    row: DecisionRow,
    override: ModerationOverride,
    actor: string,
  ): Promise<void>;
  ensureRecord: typeof ensurePdsRecord;
  /** 対象行を判定待ちへ戻す。cid が変わっていれば触らない。 */
  requeue(row: DecisionRow): Promise<void>;
  wake(): void;
};

/** 判定待ちへ戻す。プロフィールの cid は内容のハッシュなので、ワーカー側の照合に任せる。 */
async function requeue(row: DecisionRow): Promise<void> {
  const pending = { moderationVersion: null };
  switch (row.collection) {
    case NAGI.post:
      await db
        .update(nagiPosts)
        .set(pending)
        .where(and(eq(nagiPosts.uri, row.uri), eq(nagiPosts.cid, row.cid)));
      return;
    case NAGI.profile:
      await db
        .update(nagiProfiles)
        .set(pending)
        .where(eq(nagiProfiles.did, row.did));
      return;
    case NAGI.channel:
      await db
        .update(nagiChannels)
        .set(pending)
        .where(
          and(eq(nagiChannels.uri, row.uri), eq(nagiChannels.cid, row.cid)),
        );
      return;
    case BLUEMOJI_ITEM:
      await db
        .update(nagiEmojis)
        .set(pending)
        .where(and(eq(nagiEmojis.uri, row.uri), eq(nagiEmojis.cid, row.cid)));
      return;
    case NAGI.news:
      await db
        .update(nagiNews)
        .set(pending)
        .where(and(eq(nagiNews.uri, row.uri), eq(nagiNews.cid, row.cid)));
      return;
  }
}

const defaultDeps: OverrideDeps = {
  async loadDecision(uri) {
    const [row] = await db
      .select({
        uri: nagiModerationDecisions.uri,
        cid: nagiModerationDecisions.cid,
        did: nagiModerationDecisions.did,
        collection: nagiModerationDecisions.collection,
        decision: nagiModerationDecisions.decision,
        override: nagiModerationDecisions.override,
        overrideCid: nagiModerationDecisions.overrideCid,
      })
      .from(nagiModerationDecisions)
      .where(eq(nagiModerationDecisions.uri, uri))
      .limit(1);
    return row;
  },
  async writeOverride(row, override, actor) {
    await db
      .update(nagiModerationDecisions)
      .set({
        override,
        overrideCid: row.cid,
        overrideBy: actor,
        overrideAt: new Date(),
      })
      .where(eq(nagiModerationDecisions.uri, row.uri));
  },
  ensureRecord: ensurePdsRecord,
  requeue,
  wake: wakeModerationWorker,
};

export async function overrideModerationDecision(
  input: { uri: string; action: ModerationOverride; actor: string },
  deps: OverrideDeps = defaultDeps,
): Promise<OverrideResult> {
  const row = await deps.loadDecision(input.uri);
  if (!row) return { status: "not-found" };
  if (allowOverrideApplies(row, row.cid))
    return { status: "already", decision: row.decision };

  // 先に上書きを書く。逆順だと、復元した行をワーカーが上書き前に拾って再び落としうる。
  await deps.writeOverride(row, input.action, input.actor);

  const rejected =
    row.decision === "reject-policy" || row.decision === "reject-invalid";
  let cidChanged = false;
  if (rejected) {
    const parsed = parseRecordUri(row.uri);
    if (!parsed) throw new Error(`Unparseable moderation subject: ${row.uri}`);
    const ensured = await deps.ensureRecord(
      parsed.did,
      parsed.collection,
      parsed.rkey,
    );
    if (ensured.status === "absent")
      return { status: "absent", decision: row.decision };
    // プロフィールの decision.cid は内容ハッシュで、レコードの cid とは比べられない。
    cidChanged =
      row.collection !== NAGI.profile && ensured.record.cid !== row.cid;
  }
  await deps.requeue(row);
  deps.wake();
  return {
    status: rejected ? "restored" : "unlabeled",
    decision: row.decision,
    ...(cidChanged ? { cidChanged } : {}),
  };
}
