/**
 * botたんの「最初の1件」リアクション。
 *
 * 何ごとも最初の1件は付けにくい。botたんがポストへ返信した直後・ゼンカツへ総評を付けた直後に、
 * カスタム絵文字を1つ付けて呼び水にする。リアクションした人の一覧は
 * 受け取った本人にしか返らない（AppView の groupReactionViews）ので、
 * 第三者には「誰かが最初に反応した」ようにしか見えない。
 *
 * 対象はトップレベルのポスト（ブログ記事を含む）とゼンカツ。判定結果は nagi.bot_auto_reactions に
 * 残し、同じ subject を二度見ない（返信・総評ジョブの再実行でも2件目を付けない）。
 *
 * 呼び出し元のワーカー（返信・ゼンカツ）の中で await するので、Ollama へは
 * そのワーカーの直列に乗る。再試行はしない。付けられなかったら付けないだけ。
 */
import {
  db,
  nagiBotAutoReactions,
  nagiEmojis,
  nagiMutes,
  nagiPosts,
  nagiReactions,
  nagiZenkatsuCards,
  nagiZenkatsuSubmissions,
} from "@bsky-affirmative-bot/database";
import {
  chooseAutoReactionEmoji,
  isAutoReactionRouteLocal,
  isOllamaConfigured,
  type AutoReactionCandidate,
} from "@bsky-affirmative-bot/bot-brain";
import {
  BLUEMOJI_NAME_RE,
  NAGI,
  type NagiReaction,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  getThemeDef,
  resolveCardDef,
} from "@bsky-affirmative-bot/shared-configs";
import { trackedCreateRecord } from "@bsky-affirmative-bot/clients";
import {
  and,
  asc,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { agent } from "./agent.js";
import { ensureNagiBotRecordIndexed } from "./appviewInternal.js";
import { hasCommunityAffirmationContentWarning } from "./NagiCommunityAffirmationWorker.js";

const TOP_CUSTOM_EMOJIS = 20;
const RANDOM_CUSTOM_EMOJIS = 20;
const LOG_PREFIX = "[nagi-auto-reaction]";

const log = (event: string, details: Record<string, unknown> = {}) =>
  console.info(LOG_PREFIX, { event, ...details });

const botDid = () => process.env.NAGI_BOT_DID!;

type PostRow = Pick<
  typeof nagiPosts.$inferSelect,
  | "uri"
  | "cid"
  | "did"
  | "text"
  | "recordJson"
  | "embedImages"
  | "deletedAt"
  | "replyParentUri"
  | "kossori"
  | "moderationLabels"
  | "selfLabels"
>;

/** 対象外の理由。こっそり投稿は「静かに置いておきたい」意思表示なので触らない。 */
export function skipReasonForPost(post: PostRow): string | undefined {
  if (post.deletedAt) return "deleted";
  if (post.replyParentUri) return "reply";
  if (post.did === botDid()) return "bot_post";
  if (post.kossori) return "kossori";
  if (post.moderationLabels.length || post.selfLabels.length) return "labeled";
  if (hasCommunityAffirmationContentWarning(post)) return "content_warning";
  return undefined;
}

/** モデルへ渡す投稿の要約。画像は見せない（負荷を抑えるため）ので、有無だけ添える。 */
export function postSubjectText(
  post: Pick<PostRow, "text" | "recordJson" | "embedImages">,
) {
  const record = post.recordJson as any;
  const lines = [post.text.trim()];
  const linkCards = Array.isArray(record?.linkCards) ? record.linkCards : [];
  for (const card of linkCards) {
    const title = typeof card?.title === "string" ? card.title.trim() : "";
    if (title) lines.push(`（リンク: ${title}）`);
  }
  const images = Array.isArray(post.embedImages) ? post.embedImages.length : 0;
  if (images) lines.push(`（画像${images}枚付き。画像の中身は見えない）`);
  return lines.filter(Boolean).join("\n");
}

export function zenkatsuSubjectText(themeJa: string | undefined, cardNames: string[]) {
  return [
    "ゼンカツ（お題に合わせて手札のカードを出すゲーム）のプレイ記録。",
    themeJa ? `お題: ${themeJa}` : "",
    cardNames.length ? `出したカード: ${cardNames.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export type CustomEmojiOption = {
  uri: string;
  cid: string;
  name: string;
  alt: string | null;
};

/**
 * モデルへ見せる候補。botたんのリアクションはカスタム絵文字だけを使う（Unicode より面白いので）。
 * 同名はまとめる（別ユーザーの同名絵文字はモデルから区別できない）。
 * recent（同じ人へ直近に付けた絵文字）は外す。同じ絵文字が続くと botたん からだと透けやすく、
 * モデルも汎用の褒め言葉に偏りやすい。
 */
export function autoReactionCandidates(
  custom: readonly CustomEmojiOption[],
  recent: readonly string[] = [],
): AutoReactionCandidate[] {
  return custom
    .filter(
      (emoji, index) =>
        BLUEMOJI_NAME_RE.test(emoji.name) &&
        !recent.includes(emoji.name) &&
        custom.findIndex((other) => other.name === emoji.name) === index,
    )
    .map(({ name, alt }) => ({
      key: name,
      ...(alt?.trim() ? { description: alt.trim().slice(0, 60) } : {}),
    }));
}

/** 選んだ値から PDS へ書くリアクションの中身を作る。emoji は bluemoji.name と一致させる。 */
export function buildAutoReactionRecord(
  subject: { uri: string; cid: string },
  key: string,
  custom: readonly CustomEmojiOption[],
  now = new Date(),
): NagiReaction | undefined {
  const emoji = custom.find(({ name }) => name === key);
  if (!emoji) return undefined;
  return {
    $type: NAGI.reaction,
    subject: { uri: subject.uri, cid: subject.cid },
    emoji: emoji.name,
    bluemoji: {
      uri: emoji.uri,
      cid: emoji.cid,
      name: emoji.name,
      ...(emoji.alt ? { alt: emoji.alt } : {}),
    },
    createdAt: now.toISOString(),
  };
}

/**
 * 安全に見せられるカスタム絵文字。adultOnly・自動判定のラベル付き・判定待ち・
 * 表示不能な資産は除く（表示可否の式は AppView の services/emoji.ts displayableEmoji と同じ）。
 */
const safeEmoji = () =>
  and(
    eq(nagiEmojis.adultOnly, false),
    sql<boolean>`cardinality(${nagiEmojis.moderationLabels}) = 0`,
    isNotNull(nagiEmojis.moderationVersion),
    ne(nagiEmojis.moderationVersion, "skipped"),
    sql<boolean>`
      ${nagiEmojis.formats}->>'version' = '1'
      and ${nagiEmojis.formats}->'asset'->>'kind' in ('blob', 'bytes')
      and length(${nagiEmojis.formats}->'asset'->>'value') > 0
      and (
        ${nagiEmojis.formats}->'asset'->>'mediaType' like 'image/%'
        or ${nagiEmojis.formats}->'asset'->>'mediaType' = 'application/lottie+zip'
      )
    `,
  )!;

/** よく使われている上位と、埋もれている絵文字のランダム枠を混ぜて渡す。 */
async function loadCustomEmojiOptions(): Promise<CustomEmojiOption[]> {
  const columns = {
    uri: nagiEmojis.uri,
    cid: nagiEmojis.cid,
    name: nagiEmojis.name,
    alt: nagiEmojis.alt,
  };
  const top = await db
    .select({ ...columns, uses: count(nagiReactions.uri) })
    .from(nagiEmojis)
    .innerJoin(nagiReactions, eq(nagiReactions.emojiUri, nagiEmojis.uri))
    .where(safeEmoji())
    .groupBy(nagiEmojis.uri)
    .orderBy(desc(count(nagiReactions.uri)))
    .limit(TOP_CUSTOM_EMOJIS);
  const random = await db
    .select(columns)
    .from(nagiEmojis)
    .where(
      and(
        safeEmoji(),
        top.length ? notInArray(nagiEmojis.uri, top.map(({ uri }) => uri)) : undefined,
      ),
    )
    .orderBy(sql`random()`)
    .limit(RANDOM_CUSTOM_EMOJIS);
  // 同名は上位側を残す。そのうえで並び順の偏り（先頭ほど選ばれやすい）を避けるため混ぜる。
  const seen = new Set<string>();
  const unique = [...top.map(({ uses: _uses, ...emoji }) => emoji), ...random]
    .filter(({ name }) => !seen.has(name) && Boolean(seen.add(name)));
  return shuffle(unique);
}

function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export type AutoReactionKind = "post" | "zenkatsu";

type Subject = { did: string; cid: string; text: string };

/** 題材を読む。消えていた・対象外なら skip の理由を返す。 */
async function loadSubject(
  kind: AutoReactionKind,
  uri: string,
): Promise<Subject | { skip: string }> {
  if (kind === "zenkatsu") {
    const [row] = await db
      .select({
        did: nagiZenkatsuSubmissions.did,
        cid: nagiZenkatsuSubmissions.cid,
        themeVolume: nagiZenkatsuSubmissions.themeVolume,
        themeNumber: nagiZenkatsuSubmissions.themeNumber,
      })
      .from(nagiZenkatsuSubmissions)
      .where(
        and(
          eq(nagiZenkatsuSubmissions.uri, uri),
          isNull(nagiZenkatsuSubmissions.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return { skip: "deleted" };
    if (row.did === botDid()) return { skip: "bot_post" };
    const cards = await db
      .select({
        cardVolume: nagiZenkatsuCards.cardVolume,
        cardNumber: nagiZenkatsuCards.cardNumber,
      })
      .from(nagiZenkatsuCards)
      .where(eq(nagiZenkatsuCards.submissionUri, uri))
      .orderBy(asc(nagiZenkatsuCards.position));
    const theme = getThemeDef(row.themeVolume, row.themeNumber);
    return {
      did: row.did,
      cid: row.cid,
      text: zenkatsuSubjectText(
        theme?.textJa,
        cards.flatMap((card) => {
          const def = resolveCardDef(card.cardVolume, card.cardNumber);
          return def ? [def.nameJa] : [];
        }),
      ),
    };
  }
  const [post] = await db
    .select({
      uri: nagiPosts.uri,
      cid: nagiPosts.cid,
      did: nagiPosts.did,
      text: nagiPosts.text,
      recordJson: nagiPosts.recordJson,
      embedImages: nagiPosts.embedImages,
      deletedAt: nagiPosts.deletedAt,
      replyParentUri: nagiPosts.replyParentUri,
      kossori: nagiPosts.kossori,
      moderationLabels: nagiPosts.moderationLabels,
      selfLabels: nagiPosts.selfLabels,
    })
    .from(nagiPosts)
    .where(eq(nagiPosts.uri, uri))
    .limit(1);
  // 返信ジョブは Jetstream からも積まれるので、AppView の索引より先に来ることがある。
  if (!post) return { skip: "not_indexed" };
  const reason = skipReasonForPost(post);
  if (reason) return { skip: reason };
  return { did: post.did, cid: post.cid, text: postSubjectText(post) };
}

/** 人間のリアクションがすでにあれば、そちらが最初の1件なので付けない。 */
async function hasAnyReaction(subjectUri: string) {
  const [row] = await db
    .select({ uri: nagiReactions.uri })
    .from(nagiReactions)
    .where(eq(nagiReactions.subjectUri, subjectUri))
    .limit(1);
  return Boolean(row);
}

async function isMutedByAuthor(authorDid: string) {
  const [row] = await db
    .select({ muterDid: nagiMutes.muterDid })
    .from(nagiMutes)
    .where(
      and(
        eq(nagiMutes.muterDid, authorDid),
        eq(nagiMutes.subjectType, "actor"),
        eq(nagiMutes.subject, botDid()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** 同じ人へ直近に付けた絵文字（表示上の値）。 */
export const RECENT_EMOJI_WINDOW = 5;

async function recentEmojisFor(subjectDid: string): Promise<string[]> {
  const rows = await db
    .select({ emoji: nagiBotAutoReactions.emojiKey })
    .from(nagiBotAutoReactions)
    .where(
      and(
        eq(nagiBotAutoReactions.subjectDid, subjectDid),
        eq(nagiBotAutoReactions.state, "reacted"),
        isNotNull(nagiBotAutoReactions.emojiKey),
      ),
    )
    .orderBy(desc(nagiBotAutoReactions.updatedAt))
    .limit(RECENT_EMOJI_WINDOW);
  return rows.flatMap(({ emoji }) => (emoji ? [emoji] : []));
}

export function isAutoReactionEnabled(
  raw = process.env.NAGI_AUTO_REACTION_ENABLED,
) {
  return raw === undefined || raw === "" || !/^(0|false|off|no)$/i.test(raw);
}

let availability: boolean | undefined;

/** 有効か。止まっている理由は最初の1回だけログに出す。 */
function isAutoReactionAvailable() {
  if (availability !== undefined) return availability;
  if (!isAutoReactionEnabled()) {
    console.info(`${LOG_PREFIX} disabled by NAGI_AUTO_REACTION_ENABLED`);
    availability = false;
  } else if (!isOllamaConfigured()) {
    console.warn(`${LOG_PREFIX} Ollama is not configured; auto reactions are off`);
    availability = false;
  } else if (!isAutoReactionRouteLocal()) {
    console.warn(
      `${LOG_PREFIX} AI_ROUTE_NAGI_AUTO_REACTION is not a local Ollama route; auto reactions are off`,
    );
    availability = false;
  } else {
    availability = true;
  }
  return availability;
}

const setResult = (
  subjectUri: string,
  values: Partial<typeof nagiBotAutoReactions.$inferInsert>,
) =>
  db
    .update(nagiBotAutoReactions)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(nagiBotAutoReactions.subjectUri, subjectUri));

/**
 * botたんが返信・総評を書いた直後に呼ぶ。投げない（失敗はログと台帳に残すだけ）ので、
 * 呼び出し元のジョブはこの結果で巻き戻らない。
 */
export async function reactAfterBotPost(kind: AutoReactionKind, subjectUri: string) {
  if (!isAutoReactionAvailable()) return;
  try {
    const subject = await loadSubject(kind, subjectUri);
    const skipReason =
      "skip" in subject
        ? subject.skip
        : (await isMutedByAuthor(subject.did))
          ? "muted"
          : undefined;
    // 対象外は台帳に積まない。判定は呼ばれたこの1回きりで、あとから見直すことも無い。
    if ("skip" in subject || skipReason) {
      log("skipped", { subjectUri, reason: skipReason });
      return;
    }
    // 台帳へ先に行を作り、取れた1回だけが判定する（ジョブの再実行で2件目を付けない）。
    const claimed = await db
      .insert(nagiBotAutoReactions)
      .values({
        subjectUri,
        subjectCid: subject.cid,
        subjectDid: subject.did,
        kind,
        state: "processing",
        scheduledAt: new Date(),
      })
      .onConflictDoNothing({ target: nagiBotAutoReactions.subjectUri })
      .returning({ subjectUri: nagiBotAutoReactions.subjectUri });
    if (!claimed.length) return;

    const skip = async (reason: string) => {
      await setResult(subjectUri, { state: "skipped", lastError: reason });
      log("skipped", { subjectUri, reason });
    };

    try {
      const custom = await loadCustomEmojiOptions();
      const candidates = autoReactionCandidates(
        custom,
        await recentEmojisFor(subject.did),
      );
      // Unicode には倒さない。使える絵文字が無ければ付けずに終える。
      if (!candidates.length) return await skip("no_custom_emoji");
      const key = await chooseAutoReactionEmoji(subject.text, candidates);
      const record = key
        ? buildAutoReactionRecord({ uri: subjectUri, cid: subject.cid }, key, custom)
        : undefined;
      if (!record) return await skip("no_choice");
      // モデルが考えている数秒の間に誰かが先に反応していたら、そちらを最初の1件にする。
      if (await hasAnyReaction(subjectUri)) return await skip("already_reacted");

      const response = await trackedCreateRecord(
        agent,
        {
          repo: botDid(),
          collection: NAGI.reaction,
          validate: false,
          record,
        } as any,
        "nagi.reaction.AUTO_REACTION",
      );
      const created = { uri: response.data.uri, cid: response.data.cid };
      await setResult(subjectUri, {
        state: "reacted",
        reactionUri: created.uri,
        // ":name:"。同名の別絵文字も「同じ絵文字」として避けるため URI にしない。
        emojiKey: record.emoji,
        lastError: null,
      });
      // Jetstream を待たずに AppView へ載せる。通知と push は ingest が作る。
      await ensureNagiBotRecordIndexed(created);
      log("reacted", { subjectUri, kind, emoji: record.emoji });
    } catch (error) {
      await setResult(subjectUri, {
        state: "failed",
        lastError:
          error instanceof Error
            ? error.message.slice(0, 500)
            : String(error).slice(0, 500),
      });
      throw error;
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to react to ${subjectUri}:`, error);
  }
}
