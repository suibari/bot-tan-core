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
 * 上書きは通知を出した時点の cid に結び付ける。ボタンが押されるまでに編集され、
 * 新しい内容の判定が記録されていたら stale を返して何もしない（運用者が見ていない
 * 内容を承認しない）。
 *
 * 復元が終わるまで override_applied_at は NULL のまま残す。PDS の取り直しなどが途中で
 * 失敗しても、押し直せば同じ手順を最初からやり直す（どの手順も冪等）。
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
  /** 同じ内容に対して既に解除済み（復元まで完了）。 */
  | "already"
  /** 通知の後で内容が変わり、新しい判定が記録されている。何もしない。 */
  | "stale"
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
  overrideAppliedAt: Date | null;
};

type Subject = { uri: string; cid: string };

export type OverrideDeps = {
  loadDecision(uri: string): Promise<DecisionRow | undefined>;
  /**
   * uri と cid の両方が一致する行にだけ上書きを書き、復元完了を未完了へ戻す。
   * 一致しなかった（その間に新しい判定が記録された）ら false。
   */
  writeOverride(
    subject: Subject,
    override: ModerationOverride,
    actor: string,
  ): Promise<boolean>;
  /** 復元まで終わったことを記録する。uri と cid が一致する行だけ。 */
  markApplied(subject: Subject): Promise<void>;
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
        overrideAppliedAt: nagiModerationDecisions.overrideAppliedAt,
      })
      .from(nagiModerationDecisions)
      .where(eq(nagiModerationDecisions.uri, uri))
      .limit(1);
    return row;
  },
  async writeOverride(subject, override, actor) {
    const updated = await db
      .update(nagiModerationDecisions)
      .set({
        override,
        overrideCid: subject.cid,
        overrideBy: actor,
        overrideAt: new Date(),
        overrideAppliedAt: null,
      })
      .where(
        and(
          eq(nagiModerationDecisions.uri, subject.uri),
          eq(nagiModerationDecisions.cid, subject.cid),
        ),
      )
      .returning({ uri: nagiModerationDecisions.uri });
    return updated.length > 0;
  },
  async markApplied(subject) {
    await db
      .update(nagiModerationDecisions)
      .set({ overrideAppliedAt: new Date() })
      .where(
        and(
          eq(nagiModerationDecisions.uri, subject.uri),
          eq(nagiModerationDecisions.overrideCid, subject.cid),
        ),
      );
  },
  ensureRecord: ensurePdsRecord,
  requeue,
  wake: wakeModerationWorker,
};

export async function overrideModerationDecision(
  input: {
    uri: string;
    /** 通知を出した時点の cid。これと違う内容は承認しない。 */
    cid: string;
    action: ModerationOverride;
    actor: string;
  },
  deps: OverrideDeps = defaultDeps,
): Promise<OverrideResult> {
  const row = await deps.loadDecision(input.uri);
  if (!row) return { status: "not-found" };
  if (row.cid !== input.cid) return { status: "stale", decision: row.decision };
  if (allowOverrideApplies(row, input.cid) && row.overrideAppliedAt)
    return { status: "already", decision: row.decision };

  // 先に上書きを書く。逆順だと、復元した行をワーカーが上書き前に拾って再び落としうる。
  // 読んでから書くまでの間に新しい判定が入った場合も、条件付き更新がここで止める。
  const subject = { uri: input.uri, cid: input.cid };
  if (!(await deps.writeOverride(subject, input.action, input.actor)))
    return { status: "stale", decision: row.decision };

  // ここから先で投げたら override_applied_at は NULL のまま残り、押し直しで再実行される。
  // その間もワーカーは上書きに従うので、判定待ちへ戻った行を再び落とすことはない。
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
    if (ensured.status === "absent") {
      await deps.markApplied(subject);
      return { status: "absent", decision: row.decision };
    }
    // プロフィールの decision.cid は内容ハッシュで、レコードの cid とは比べられない。
    cidChanged =
      row.collection !== NAGI.profile && ensured.record.cid !== row.cid;
  }
  await deps.requeue(row);
  await deps.markApplied(subject);
  deps.wake();
  return {
    status: rejected ? "restored" : "unlabeled",
    decision: row.decision,
    ...(cidChanged ? { cidChanged } : {}),
  };
}
