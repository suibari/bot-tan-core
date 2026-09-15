import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs, AppBskyFeedPost, BlobRef } from "@atproto/api";
type ProfileView = AppBskyActorDefs.ProfileView;
type PostRecord = AppBskyFeedPost.Record;
import { BotFeature, FeatureContext } from "./types.js";
import { loadPreferredName } from "@bsky-affirmative-bot/clients";
import {
    claimDailyDrawing,
    drawingServiceDailyLimit,
    releaseDailyDrawing,
    type DrawingClaimResult,
} from "@bsky-affirmative-bot/database";
import {
    generateImage,
    isImageGenerationAvailable,
    judgeDrawingRequest,
    type DrawingRequestJudgement,
} from "@bsky-affirmative-bot/bot-brain";
import { getLangStr, uniteDidNsidRkey } from "../bsky/util.js";
import { postContinuous } from "../bsky/postContinuous.js";
import { agent } from "../bsky/agent.js";
import { drawingReplyText, type DrawingReplyKind } from "./drawingReply.js";

type DrawingRequest = Extract<DrawingRequestJudgement, { intent: "request" }>;

/** app.bsky.embed.images の blob 上限は 1,000,000 バイト。符号化の誤差ぶん下げる。 */
const IMAGE_MAX_BYTES = 950_000;

const postUri = (event: CommitCreateEvent<"app.bsky.feed.post">) =>
    uniteDidNsidRkey(event.did, event.commit.collection, event.commit.rkey);

/**
 * お絵描き機能。botたんに「絵を描いて」と頼むと、描いた絵を添えてリプライする。
 *
 * - Discord メンバーとサブスクメンバーだけ（isCommunityMember は両方を含む）
 * - 1人1日1枚（JST の暦日）。面ごとの枠は drawingClaims.ts
 * - どの機能を呼んでいるかは featureIntent.ts の振り分けが決め、お絵描きに振られた投稿だけを
 *   judgeDrawingRequest で確かめる（題材・描いてよい依頼か）。「絵を描いた」「日記かいて」を
 *   語で見分けるのは無理なので、固定のトリガー語は持たない
 *
 * **描き始めたら例外を投げない。** callbacks.ts は handle を3回までリトライするが、
 * 画像生成はリトライしてはいけない（imageGenClient.ts の requestImage のコメント）。
 * 描いた後に失敗しても、枠を返してログに残すだけにする。
 */
export class DrawingFeature implements BotFeature {
    name = "Drawing";

    /** shouldHandle で判定した結果を handle へ渡す。同じ投稿に LLM を2回回さないため。 */
    private readonly requests = new Map<string, DrawingRequest>();

    async shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean> {
        if (!context.isCommunityMember) return false;

        // 振り分け（featureIntent.ts）がお絵描きを選んだ投稿だけ。ほかの機能と排他にするため。
        // 呼びかけの有無とメンバー限定もそちらのルールが見ている。
        if (!(await context.featureIntents()).intents.has("drawing")) return false;

        // 描けない状態で依頼を拾うと、通常の返信の代わりに「描けなかった」が返ってしまう。
        // 投稿は後ろの機能（会話・通常の返信）へ流す。
        if (!isImageGenerationAvailable() || drawingServiceDailyLimit() === 0) return false;

        // 振り分けは「どの機能か」しか見ない。題材と、描いてよい依頼かはここで確かめる。
        // regex モードでは「絵」の一語で振り分けに当たるので、依頼でなければここで落ちる。
        const record = event.commit.record as PostRecord;
        const judgement = await judgeDrawingRequest(record.text || "");
        if (judgement.intent !== "request") return false;

        this.requests.set(postUri(event), judgement);
        return true;
    }

    async handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void> {
        const uri = postUri(event);
        const record = event.commit.record as PostRecord;
        try {
            // リトライで入ってきたときは shouldHandle の結果が消えているので判定し直す。
            const request = this.requests.get(uri) ?? (await judgeDrawingRequest(record.text || ""));
            if (request.intent !== "request") return;

            const name = (await loadPreferredName(follower.did)) || follower.displayName || follower.handle;
            const reply = (kind: DrawingReplyKind, image?: { blob: BlobRef; alt: string }) =>
                postContinuous(
                    drawingReplyText(kind, { langStr: getLangStr(record.langs), name, subject: request.subject }),
                    { uri, cid: String(event.commit.cid), record },
                    image,
                );

            if (!request.allowed) {
                console.log(
                    `[INFO][${follower.did}] Drawing declined concern=${request.concern ?? "unknown"}: ${request.subject}`,
                );
                await reply("declined");
                return;
            }

            const claim = await claimDailyDrawing({ surface: "bsky", did: follower.did, sourceUri: uri });
            if (claim.status === "disabled") return;
            if (claim.status !== "claimed") {
                console.log(`[INFO][${follower.did}] Drawing skipped, REASON: ${claim.status}`);
                await reply(claim.status);
                return;
            }

            await this.drawAndReply(follower, request, claim, reply);
        } finally {
            this.requests.delete(uri);
        }
    }

    private async drawAndReply(
        follower: ProfileView,
        request: DrawingRequest,
        claim: DrawingClaimResult,
        reply: (kind: DrawingReplyKind, image?: { blob: BlobRef; alt: string }) => Promise<unknown>,
    ) {
        const release = () =>
            releaseDailyDrawing({ surface: "bsky", did: follower.did, day: claim.day }).catch((error) => {
                console.error(`[ERROR][${follower.did}] Failed to release drawing claim:`, error);
            });

        console.log(`[INFO][${follower.did}] Drawing: ${request.subject}`);
        // 見出しを付けて渡す。シーン変換は材料に書かれたものを描くので、何の記述かを明示しておく。
        const image = await generateImage(
            `### 描いてほしいと頼まれた絵\n${request.subject}`,
            IMAGE_MAX_BYTES,
            { purpose: "picture" },
        );

        try {
            if (!image) {
                // 描けなかったのは本人のせいではないので、今日の枠は返す。
                await release();
                await reply("failed");
                return;
            }
            const { blob } = (await agent.uploadBlob(image.data, { encoding: image.mimeType })).data;
            await reply("drawn", { blob, alt: `全肯定botたんが描いた絵: ${request.subject}` });
        } catch (error) {
            console.error(`[ERROR][${follower.did}] Failed to post drawing:`, error);
            if (image) await release();
        }
    }
}
