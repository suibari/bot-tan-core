import {
  claimDailyDrawing,
  drawingServiceDailyLimit,
  hasDailyDrawingGift,
  releaseDailyDrawing,
  type DrawingClaimResult,
} from "@bsky-affirmative-bot/database";
import {
  generateImage,
  isImageGenerationAvailable,
  judgeDrawingGift,
  judgeDrawingRequest,
  type DrawingGiftJudgement,
  type DrawingGiftMood,
  type DrawingRequestJudgement,
  type GeneratedImage,
} from "@bsky-affirmative-bot/bot-brain";
import { hasDrawingHint } from "@bsky-affirmative-bot/shared-configs";
import type { ImageRef } from "@bsky-affirmative-bot/shared-configs";
import { NAGI, type StrongRef } from "@bsky-affirmative-bot/nagi-lexicon";
import { publishNagiPost } from "./nagiPost.js";
import { uploadScheduledImage } from "./ScheduledPostFeature.js";

/**
 * Nagi のお絵描き。全ユーザーが対象で、2つの入口がある。
 *
 *  - 依頼: Bluesky と同じく「botたん、猫の絵描いて」と頼まれて描く（prepareNagiDrawingRequest）
 *  - 贈り物: botたんの判断で描く。投稿者がとても喜んでいる / ひどく落ち込んでいるときだけ
 *    （enqueueNagiDrawingGift）
 *
 * 本人からの依頼に日次上限はない。自動プレゼントは1人1日1枚のままで、
 * 依頼と贈り物はどちらも面ごとの運用上限に数える。
 * 絵はどちらも、きっかけになったユーザー投稿への直接リプライとして置く。
 * 受付・通常返信へぶら下げると直接の返信先が botたん自身になり、完成時の通知が
 * ユーザーへ届かないため。
 *
 * ## 依頼には AI の返信を返さない
 * 返信ワーカーは依頼に気付くと、AI の返信の代わりに「描いてみるね」を返す（NagiReplyWorker）。
 * AI に任せると「絵は描けないよ」のように、この後に届く絵と食い違う返事を書くことがある。
 *
 * ## なぜ Postgres のリースキューではなくプロセス内のキューか
 * 描画は数十秒〜数分かかり、同時実行1のサイドカーを待つ。返信ワーカーの中で描くと、その間
 * 全員の返信が止まる。贈り物は飾りで、再起動で積み残しが消えても実害は無い一方、永続化すると
 * 「昨日の喜びに今日の絵が届く」遅配を作りうる。贈り物は上限付きで、溢れたら捨てる。
 * 依頼は枠を取ってから積むので、捨てない（上限はサービス枠が決める）。
 */

/** Nagi の blob 上限 1,000,000 バイトに対する余裕。おやすみポストの絵と同じ値。 */
const IMAGE_MAX_BYTES = 950_000;

/** 贈り物の待ち行列の上限。依頼はこの上限に数えない。 */
export const NAGI_DRAWING_GIFT_QUEUE_LIMIT = 20;

export type DrawingLang = "ja" | "en";

/** 投稿の言語が日本語なら日本語、それ以外は英語（createNagiReply の言語解決と同じ既定）。 */
export function nagiDrawingLang(langs: unknown): DrawingLang {
  const primary = Array.isArray(langs) ? String(langs[0] ?? "") : "";
  return primary.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export type NagiDrawingRequestTextKind =
  | "accepted"
  | "declined"
  | "user_limit"
  | "service_limit"
  | "drawn"
  | "failed";

/**
 * 依頼への返事と、描いた絵に添える本文。定型文にしている（絵が主役で、本文の生成に Ollama を
 * 待たせる理由が無い）。名前は呼ばない。呼び名の解決を増やすと、呼称ドリフトの入口ができる。
 */
export function nagiDrawingRequestText(
  kind: NagiDrawingRequestTextKind,
  lang: DrawingLang,
  subject: string,
): string {
  if (lang === "ja") {
    switch (kind) {
      case "accepted":
        return `リクエストありがとう！「${subject}」、いまから描いてみるね。できあがったらここに貼るから、ちょっと待っててね！`;
      case "declined":
        return "リクエストありがとう！ でもごめんね、その絵はわたしには描けないんだ…。ほかのものなら描いてみるから、また頼んでね！";
      case "user_limit":
        return "リクエストありがとう！ でもごめんね、今はお絵描きできないみたい…。少ししたらまた頼んでね！";
      case "service_limit":
        return "リクエストありがとう！ でもごめんね、今日はたくさん描いて手がくたくたになっちゃった…。また明日頼んでくれるとうれしいな！";
      case "drawn":
        return `できたよ！「${subject}」を描いてみたよ。受け取ってくれたらうれしいな。`;
      case "failed":
        return "ごめんね、うまく描けなかったみたい…。今日の1回は使っていないから、少ししたらまた頼んでね！";
    }
  }
  switch (kind) {
    case "accepted":
      return `Thanks for asking! I'll start drawing "${subject}" now. I'll post it here when it's ready, so please wait a little!`;
    case "declined":
      return "Thanks for asking! I'm sorry, but that's not something I can draw... Ask me for something else and I'll give it a try!";
    case "user_limit":
      return "Thanks for asking! I'm sorry, I can't draw that right now... Try asking me again in a little while!";
    case "service_limit":
      return "Thanks for asking! I'm sorry, I drew so much today that my hands are worn out... Please ask me again tomorrow!";
    case "drawn":
      return `Here it is! I drew "${subject}" for you. I hope you like it.`;
    case "failed":
      return "I'm sorry, the drawing didn't turn out... This didn't use up today's drawing, so try asking me again in a little while!";
  }
}

/**
 * 贈り物の本文。
 *
 * **喜びの側で「おめでとう」と言わない。** 判定の very_happy は達成とは限らず、
 * 未完了のことを祝う事故（AGENTS.md「プロンプトの並び順」の実例）をここで再現しない。
 */
export function nagiDrawingGiftText(mood: DrawingGiftMood, lang: DrawingLang): string {
  if (lang === "ja") {
    return mood === "very_happy"
      ? "うれしい気持ちが伝わってきて、わたしまでうれしくなっちゃったから、絵にしてみたよ！ 受け取ってくれたらうれしいな。"
      : "今日のあなたに、絵を描いてみたよ。無理しないで、ゆっくりしてね。";
  }
  return mood === "very_happy"
    ? "Your happiness made me happy too, so I drew you a picture! I hope you like it."
    : "I drew a picture for you today. Please don't push yourself, and take it easy.";
}

export type NagiDrawingThread = {
  sourceUri: string;
  authorDid: string;
  lang: DrawingLang;
  root: StrongRef;
  /** お絵描きの起点になったユーザー投稿。完成した絵はここへ直接返信する。 */
  parent: StrongRef;
};

/**
 * 2段階目のお絵描き投稿のスレッド参照。
 *
 * root は元の会話を維持しつつ、parent は受付・通常返信ではなく起点のユーザー投稿にする。
 * これにより、AppView の通常の直接返信通知だけで完成を依頼者へ知らせられる。
 */
export function nagiDrawingReplyThread(source: StrongRef, root: StrongRef) {
  return { root, parent: source };
}

export type NagiDrawingJob =
  | (NagiDrawingThread & { kind: "gift"; text: string; images?: ImageRef[] })
  | (NagiDrawingThread & { kind: "request"; subject: string; day: string });

export type NagiDrawingOutcome =
  | "empty"
  | "already_drawn"
  | "not_moved"
  | "limited"
  | "failed"
  | "drawn";

export type NagiDrawingContent = { text: string; image?: GeneratedImage; alt?: string };

export type NagiDrawingDeps = {
  hasDrawnToday(did: string): Promise<boolean>;
  judgeGift(text: string, images?: readonly ImageRef[]): Promise<DrawingGiftJudgement>;
  claim(did: string, sourceUri: string): Promise<DrawingClaimResult>;
  release(sourceUri: string, day: string): Promise<void>;
  /** sourceText はシーン変換（planImageScene）の材料。見出し付きで渡す。 */
  draw(sourceText: string): Promise<GeneratedImage | null>;
  publish(thread: NagiDrawingThread, content: NagiDrawingContent): Promise<void>;
};

/**
 * 描いて投稿する。描けなかった・投稿できなかったときは枠を返す。
 * failedText があれば（依頼のとき）描けなかったことを伝える。贈り物は頼まれていないので黙る。
 */
async function drawAndPublish(
  job: NagiDrawingJob,
  day: string,
  deps: NagiDrawingDeps,
  content: { sourceText: string; text: string; alt: string; failedText?: string },
): Promise<NagiDrawingOutcome> {
  try {
    const image = await deps.draw(content.sourceText);
    if (image) {
      await deps.publish(job, { text: content.text, image, alt: content.alt });
      return "drawn";
    }
  } catch (error) {
    console.error(`[ERROR][NAGI][DRAWING] ${job.sourceUri} failed:`, error);
  }

  await deps.release(job.sourceUri, day).catch((error) => {
    console.error("[ERROR][NAGI][DRAWING] Failed to release claim:", error);
  });
  if (content.failedText) {
    await deps.publish(job, { text: content.failedText }).catch((error) => {
      console.error(`[ERROR][NAGI][DRAWING] ${job.sourceUri} failed to report the failure:`, error);
    });
  }
  return "failed";
}

/**
 * 1件を処理する。贈り物は安い順に、今日すでに贈ったか（DB）、
 * 気持ちが動いているか（LLM）、サービス枠（DB）を見てから描く（GPU）。
 * 依頼は返信ワーカーの中で判定と枠取りを済ませているので、描くだけ。
 */
export async function processNagiDrawingJob(
  job: NagiDrawingJob,
  deps: NagiDrawingDeps,
): Promise<NagiDrawingOutcome> {
  if (job.kind === "request") {
    return drawAndPublish(job, job.day, deps, {
      // 見出しを付けて渡す。シーン変換は材料に書かれたものを描くので、何の記述かを明示しておく。
      sourceText: `### 描いてほしいと頼まれた絵\n${job.subject}`,
      text: nagiDrawingRequestText("drawn", job.lang, job.subject),
      alt: job.lang === "ja" ? `全肯定botたんが描いた絵: ${job.subject}` : `A picture drawn by Bot-tan: ${job.subject}`,
      failedText: nagiDrawingRequestText("failed", job.lang, job.subject),
    });
  }

  if (!job.text.trim()) return "empty";
  if (await deps.hasDrawnToday(job.authorDid)) return "already_drawn";

  const judgement = await deps.judgeGift(job.text, job.images);
  if (!judgement.gift) return "not_moved";

  const claim = await deps.claim(job.authorDid, job.sourceUri);
  if (claim.status !== "claimed") return "limited";

  return drawAndPublish(job, claim.day, deps, {
    // 材料は判定が書いた「贈る絵の場面」で、投稿本文ではない（judgeDrawing.ts の DRAWING_GIFT_SYSTEM）。
    sourceText: `### botたんが贈る絵の場面\n${judgement.scene}`,
    text: nagiDrawingGiftText(judgement.mood, job.lang),
    // 場面の記述は落ち込んだ投稿から作ったものなので、代替テキストへは出さない。
    alt: job.lang === "ja" ? "全肯定botたんが描いた絵" : "A picture drawn by Bot-tan",
  });
}

/**
 * 直列キュー。GPU のサイドカーは同時実行1なので、並べても速くならない。
 *
 * 贈り物は、同じ人の贈り物がすでに待っていたら、遅れて古い投稿へ届けないよう
 * 新しい投稿で置き換える。上限を超えた贈り物は捨てる。
 */
export function createNagiDrawingQueue(
  deps: NagiDrawingDeps,
  giftLimit = NAGI_DRAWING_GIFT_QUEUE_LIMIT,
) {
  const pending: NagiDrawingJob[] = [];
  let running: Promise<void> | undefined;

  const drain = async () => {
    while (pending.length > 0) {
      const job = pending.shift()!;
      try {
        const outcome = await processNagiDrawingJob(job, deps);
        console.log(`[INFO][NAGI][DRAWING] ${job.kind} ${job.sourceUri} ${outcome}`);
      } catch (error) {
        // 判定・枠取りの DB/LLM 障害。1件の失敗でキュー全体を止めない。
        console.error(`[ERROR][NAGI][DRAWING] ${job.kind} ${job.sourceUri} failed:`, error);
      }
    }
  };

  return {
    enqueue(job: NagiDrawingJob): boolean {
      if (job.kind === "gift") {
        const index = pending.findIndex(
          (item) => item.kind === "gift" && item.authorDid === job.authorDid,
        );
        if (index >= 0) {
          pending[index] = job;
        } else if (pending.filter((item) => item.kind === "gift").length >= giftLimit) {
          console.warn(`[WARN][NAGI][DRAWING] gift queue is full, dropped ${job.sourceUri}`);
          return false;
        } else {
          pending.push(job);
        }
      } else {
        pending.push(job);
      }
      running ??= drain().finally(() => {
        running = undefined;
      });
      return true;
    },
    /** キューが空になるまで待つ（テスト用）。 */
    idle(): Promise<void> {
      return running ?? Promise.resolve();
    },
    size(): number {
      return pending.length;
    },
  };
}

export type PreparedNagiDrawingRequest = {
  /** 返信ワーカーが AI の返信の代わりに投稿する本文。 */
  comment: string;
  /** 返事を投稿できたら呼ぶ。描く依頼のときだけある（断り・枠切れのときは描かない）。 */
  onReplyPosted?: (thread: { root: StrongRef; parent: StrongRef }) => void;
};

export type NagiDrawingRequestDeps = {
  available(): boolean;
  judgeRequest(text: string): Promise<DrawingRequestJudgement>;
  claim(did: string, sourceUri: string): Promise<DrawingClaimResult>;
  enqueue(job: NagiDrawingJob): boolean;
};

/**
 * 返信ワーカーから、返信を作る前に呼ぶ。お絵描きの依頼でなければ undefined。
 *
 * 枠はここで取る（返事の本文が枠の有無で変わるため）。返信ジョブがリトライしても、
 * 同じ投稿での枠取りは claimed として返る（claimDailyDrawing）。
 */
export async function prepareNagiDrawingRequest(
  input: { sourceUri: string; authorDid: string; text: string; langs?: unknown },
  deps: NagiDrawingRequestDeps = defaultRequestDeps,
): Promise<PreparedNagiDrawingRequest | undefined> {
  if (!hasDrawingHint(input.text) || !deps.available()) return undefined;

  const judgement = await deps.judgeRequest(input.text);
  if (judgement.intent !== "request") return undefined;

  const lang = nagiDrawingLang(input.langs);
  const reply = (kind: NagiDrawingRequestTextKind) =>
    nagiDrawingRequestText(kind, lang, judgement.subject);

  if (!judgement.allowed) {
    console.log(
      `[INFO][NAGI][DRAWING] request declined concern=${judgement.concern ?? "unknown"} ${input.sourceUri}`,
    );
    return { comment: reply("declined") };
  }

  const claim = await deps.claim(input.authorDid, input.sourceUri);
  if (claim.status === "disabled") return undefined;
  if (claim.status !== "claimed") return { comment: reply(claim.status) };

  return {
    comment: reply("accepted"),
    onReplyPosted: (thread) => {
      deps.enqueue({
        kind: "request",
        sourceUri: input.sourceUri,
        authorDid: input.authorDid,
        lang,
        subject: judgement.subject,
        day: claim.day,
        ...thread,
      });
    },
  };
}

const defaultDeps: NagiDrawingDeps = {
  hasDrawnToday: (did) => hasDailyDrawingGift({ did }),
  judgeGift: (text, images) => judgeDrawingGift(text, images),
  claim: (did, sourceUri) => claimDailyDrawing({ surface: "nagi", did, sourceUri, kind: "gift" }),
  release: (sourceUri, day) => releaseDailyDrawing({ surface: "nagi", sourceUri, day }),
  draw: (sourceText) => generateImage(sourceText, IMAGE_MAX_BYTES, { purpose: "picture" }),
  async publish(thread, content) {
    const uploaded = content.image
      ? await uploadScheduledImage({
          dataBase64: content.image.data.toString("base64"),
          mimeType: content.image.mimeType,
          width: content.image.width,
          height: content.image.height,
          alt: content.alt ?? "",
        })
      : null;
    if (content.image && !uploaded) throw new Error("failed to upload the drawing to Nagi");

    const sourceRkey = thread.sourceUri.split("/").at(-1)!;
    await publishNagiPost({
      text: content.text,
      label: "NAGI_DRAWING",
      // 返信（rkey = 投稿の rkey）と衝突させず、再実行でも二重に置かない決め打ちの rkey。
      // 描けなかった知らせも同じ rkey なので、絵の投稿が途中で落ちても1件にまとまる。
      rkey: `${sourceRkey}-drawing`,
      langs: [thread.lang],
      reply: { root: thread.root, parent: thread.parent },
      ...(uploaded ? { embed: { $type: `${NAGI.post}#images` as const, images: [uploaded] } } : {}),
    });
  },
};

let defaultQueue: ReturnType<typeof createNagiDrawingQueue> | undefined;
const queue = () => (defaultQueue ??= createNagiDrawingQueue(defaultDeps));

/** 描ける状態か。描けないときは依頼も贈り物も拾わない（判定の LLM も回さない）。 */
const drawingAvailable = () => isImageGenerationAvailable() && drawingServiceDailyLimit() > 0;

const defaultRequestDeps: NagiDrawingRequestDeps = {
  available: drawingAvailable,
  judgeRequest: (text) => judgeDrawingRequest(text),
  claim: (did, sourceUri) => claimDailyDrawing({ surface: "nagi", did, sourceUri }),
  enqueue: (job) => queue().enqueue(job),
};

/** 返信ワーカーから呼ぶ贈り物の入口。判定はキューの中で行う。 */
export function enqueueNagiDrawingGift(input: {
  sourceUri: string;
  authorDid: string;
  text: string;
  images?: ImageRef[];
  langs?: unknown;
  root: StrongRef;
  parent: StrongRef;
}): boolean {
  if (!drawingAvailable()) return false;
  return queue().enqueue({
    kind: "gift",
    sourceUri: input.sourceUri,
    authorDid: input.authorDid,
    text: input.text,
    images: input.images,
    lang: nagiDrawingLang(input.langs),
    root: input.root,
    parent: input.parent,
  });
}
