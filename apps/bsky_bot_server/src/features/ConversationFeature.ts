import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api"; type ProfileView = AppBskyActorDefs.ProfileView;
import { BotFeature, FeatureContext } from "./types.js";
import { MemoryService, botLabelerManager, withPreferredName } from "@bsky-affirmative-bot/clients";
import { followerMap } from "../bsky/followerManagement.js";
import { isReplyOrMentionToMe, uniteDidNsidRkey, getImageUrl, getLangStr } from "../bsky/util.js";
import { getBotContext } from "../util/botContext.js";
import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { Content } from "@google/genai";
import { Embed, GeminiResponseResult, UserInfoGemini, BADGE_DEF } from "@bsky-affirmative-bot/shared-configs";
import { parseEmbedPost } from '../bsky/parseEmbedPost.js';
import { parseThread, ParsedThreadResult } from "../bsky/parseThread.js";
import { handleMode } from "./utils.js";
import retry from 'async-retry';
import { conversation } from "@bsky-affirmative-bot/bot-brain";
import { agent } from "../bsky/agent.js";
import { generateQuestionsAnswer } from "@bsky-affirmative-bot/bot-brain";
import { postContinuous } from "../bsky/postContinuous.js";
import { generateWhimsicalReply } from "@bsky-affirmative-bot/bot-brain";
import { like } from "../bsky/like.js";
import { tryUpsertBotMemoryDocument } from "@bsky-affirmative-bot/database";
import { classifyPostThread } from "@bsky-affirmative-bot/bot-runtime";

export function canContinueBskyConversation(
    isSubscriber: boolean,
    record: Record,
    authorDid: string,
    botDid: string | undefined,
) {
    if (!isSubscriber || !botDid) return false;
    const threadKind = classifyPostThread(record, authorDid, botDid);
    return threadKind === "self-thread" || threadKind === "bot-thread";
}

export class ConversationFeature implements BotFeature {
    name = "Conversation";

    async shouldHandle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<boolean> {
        const record = event.commit.record as any;
        return record.reply && isReplyOrMentionToMe(record);
    }

    async handle(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView, context: FeatureContext): Promise<void> {
        const record = event.commit.record as Record;
        const uri = uniteDidNsidRkey(follower.did, event.commit.collection, event.commit.rkey);

        // リプライを記憶 (これはGeminiを使わない)
        await MemoryService.upsertReply(follower.did, {
            reply: record.text,
            uri: uri,
            isRead: 0
        });
        await tryUpsertBotMemoryDocument({
            sourceType: "bsky_received_reply",
            sourceId: uri,
            sourceUri: uri,
            authorId: follower.did,
            content: record.text,
            occurredAt: new Date(record.createdAt),
            metadata: { receivedByBot: true },
        });
        await MemoryService.logUsage('reply', follower.did);
        console.log(`[INFO][${follower.did}] new reply to me, so memorized`);

        // Geminiを使う機能の前にリクエスト上限チェック
        if (!(await MemoryService.checkRPD())) {
            console.log(`[INFO][${follower.did}] Ignored Gemini features, REASON: rpd over`);
            return;
        }

        // 質問コーナー回答: 会話機能より優先
        if (await this.postReplyOfAnswer(event, follower)) {
            await MemoryService.logUsage('answer', follower.did);
            return;
        }

        // 定期ポストへのリプライ: 会話機能より優先
        if (await this.doWhimsicalPostReply(follower, event)) {
            return;
        }

        // サブスクライバーは本人ルートに加え、botの定期投稿ルートでも通常会話へ移行する。
        if (canContinueBskyConversation(
            context.isSubscriber,
            record,
            follower.did,
            process.env.BSKY_DID,
        )) {
            if (await this.handleConversation(event, follower)) {
                await MemoryService.logUsage('conversation', follower.did);
                return;
            }
        }
    }

    // --- Conversation Logic ---
    private async handleConversation(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView) {
        const did = event.did;
        const record = event.commit.record as Record;

        // 添付画像取得
        const image = await getImageUrl(follower.did, record.embed);

        // 引用ポスト・リンク解析
        let embed: Embed | undefined = undefined;
        const embed_tmp = await parseEmbedPost(record);
        if (embed_tmp) {
            if (embed_tmp.profile_embed) {
                // 引用ポストの場合、フォロワーに含まれるかbot自身の投稿ならセット
                if (
                    followerMap.has(embed_tmp.profile_embed?.did) ||
                    process.env.BSKY_DID === embed_tmp.profile_embed?.did // botの投稿を引用でも反応する
                ) {
                    embed = embed_tmp;
                    if (embed.image_embed) {
                        image.push(...embed.image_embed);
                    }
                }
            } else if (embed_tmp.uri_embed) {
                // 外部リンクカードの場合、そのままセット
                embed = embed_tmp;
            }
        }

        // ポストテキストからURLを抽出（リンクカードがない場合）
        if (!embed?.uri_embed) {
            let textLinkUri: string | undefined;

            // facetsからリンクを抽出
            if (record.facets) {
                for (const facet of record.facets) {
                    if (facet.features) {
                        for (const feature of facet.features) {
                            if (feature.$type === 'app.bsky.richtext.facet#link' && typeof (feature as any).uri === 'string') {
                                textLinkUri = (feature as any).uri;
                                break;
                            }
                        }
                    }
                    if (textLinkUri) break;
                }
            }

            if (textLinkUri) {
                if (!embed) embed = {};
                embed.uri_embed = textLinkUri;
            }
        }

        // 前回までの会話取得
        const row = await MemoryService.getFollower(follower.did);
        let history: Content[] = [];
        if (row?.conv_history) {
            history = typeof row.conv_history === 'string'
                ? JSON.parse(row.conv_history)
                : row.conv_history;
        }
        const conv_root_cid = row?.conv_root_cid;

        // ユーザからbotへのリプライ時、botの定期ポストでなければ、
        // 1ユーザの元ポスト、2botのリプライ、3ユーザのさらなるリプライ となっているはず
        // conv_root_cidがスレッドのrootと等しくないなら、historyに会話履歴を追加する必要あり
        try {
            if (conv_root_cid !== record.reply?.root.cid) {
                const thread: ParsedThreadResult = await parseThread(record);
                // 親の親ポスト
                // 会話履歴は user/model のペアで追加する。botトップ投稿へ最初に直接
                // 返信したケースでは userPostText が無いため、model 始まりの不正な
                // 履歴を作らず、今回のユーザー入力だけで会話を開始する。
                if (thread.userPostText) {
                    const gpContent: Content = {
                        role: "user",
                        parts: [
                            {
                                text: thread.userPostText
                            },
                        ],
                    }
                    history.push(gpContent)
                    if (thread.botPostText) {
                        const parentContent: Content = {
                            role: "model",
                            parts: [
                                {
                                    text: thread.botPostText
                                }
                            ]
                        }
                        history.push(parentContent);
                    }
                }
            }
        } catch (error) {
            console.error(`[ERROR][${did}] Failed to parse thread:`, error);
            return false; // スレッド解析に失敗した場合は処理を中止
        }

        const userinfo = await withPreferredName({
            follower,
            posts: [record.text],
            langStr: getLangStr(record.langs),
            image,
            history,
            embed,
            isSubscriber: true,
        });

        return await handleMode(event, {
            dbColumn: "last_conv_at",
            dbValue: new Date(),
            generateText: this.waitAndGenReply.bind(this),
        },
            userinfo);
    }

    private async waitAndGenReply(userinfo: UserInfoGemini, event: CommitCreateEvent<"app.bsky.feed.post">): Promise<GeminiResponseResult> {
        const record = event.commit.record as Record;

        let text_bot: string | undefined = undefined;
        let new_history: Content[] = [];

        try {
            await retry(async (bail, attempt) => {
                const result = await conversation(userinfo);
                text_bot = result.text_bot;
                new_history = result.new_history;

                if (!text_bot) {
                    console.warn(`[WARN][${userinfo.follower.did}] Attempt ${attempt}: Failed to generate response text. Retrying...`);
                    throw new Error("Response text is empty, retrying."); // Throw to trigger retry
                }
            }, {
                retries: 3, // Number of retries
                onRetry: (error: any, attempt) => {
                    console.warn(`[WARN][${userinfo.follower.did}] Retry attempt ${attempt} failed: ${error.message}`);
                }
            });
        } catch (error: any) {
            console.error(`[ERROR][${userinfo.follower.did}] Failed to generate response text after multiple retries: ${error.message}`);
            return "";
        }

        const final_text_bot = text_bot || "";

        // 最後のユーザーターンをプロンプト全文から純粋な入力テキストのみに置換
        const pureUserText = userinfo.posts?.[0] || "";
        for (let i = new_history.length - 1; i >= 0; i--) {
            if (new_history[i].role === "user") {
                new_history[i] = { role: "user", parts: [{ text: pureUserText }] };
                break;
            }
        }

        // イイネ応答
        const uri = uniteDidNsidRkey(event.did, event.commit.collection, event.commit.rkey);
        await like(uri, event.commit.cid);

        // 初回の呼びかけまたは呼びかけし直しならreplyがないのでそのポストのcidを取得
        const rootCid = record.reply?.root.cid || String(event.commit.cid);

        // 会話記録にinlineDataが含まれると巨大すぎるので削除しておく
        for (const content of new_history) {
            if (content.parts) {
                content.parts = content.parts.filter(
                    (part: any) => !("inlineData" in part)
                );
            }
        }

        // DB登録
        await MemoryService.updateFollower(userinfo.follower.did, "conv_history", new_history);
        await MemoryService.updateFollower(userinfo.follower.did, "conv_root_cid", rootCid);
        console.log(`[INFO][${userinfo.follower.did}] send coversation-result`);

        return final_text_bot;
    }

    // --- Question Logic ---
    private async postReplyOfAnswer(event: CommitCreateEvent<"app.bsky.feed.post">, follower: ProfileView) {
        const record = event.commit.record as Record;
        const langStr = getLangStr(record.langs);
        const uri = uniteDidNsidRkey(follower.did, event.commit.collection, event.commit.rkey);

        // 質問情報取得
        const uriQuestionRoot = await MemoryService.getBotState("question_post_uri");
        const themeQuestion = await MemoryService.getBotState("question_theme");
        if (!uriQuestionRoot || !themeQuestion) {
            // console.log(`[INFO][QUESTION][${follower.did}] No question found`);
            return false;
        }

        // ユーザ回答スレッドチェック: わからないけど安全のため
        const uriRecordRoot = record.reply?.root.uri;
        if (uriRecordRoot !== uriQuestionRoot) {
            // console.log(`[INFO][QUESTION][${follower.did}] not question root`);
            return false;
        }

        // 回答制限のチェック
        const rows = await MemoryService.getFollowersByColumn("question_root_uri", uriQuestionRoot);
        // * 回答済みなら早期リターン
        if (rows?.some(row => row.did === follower.did)) {
            return false;
        }

        // 画像読み取り
        const image = await getImageUrl(follower.did, record.embed);

        // 質問への回答
        const result = await generateQuestionsAnswer({
            follower,
            posts: [record.text],
            langStr,
            image,
            botContext: await getBotContext(),
        }, themeQuestion);
        
        await postContinuous(result.reply, {
            uri,
            cid: String(event.commit.cid),
            record,
        });

        // 朝トークバッジ 適用処理
        try {
            const userDid = follower.did;
            await MemoryService.ensureFollower(userDid);
            const sumJa = result.summary_ja || "朝トーク";
            const sumEn = result.summary_en || "Morning Talk";
            const def = BADGE_DEF.morningTalk(userDid, sumJa, sumEn);
            console.log(`[INFO][BADGE][MORNING] Upserting morning talk badge definition for ${userDid}: ${sumJa} / ${sumEn}`);

            // 1. レーベラーに定義を upsert
            await botLabelerManager.upsertLabelDefinition(def.id, def.locales);

            // 2. 24時間の有効期限を計算
            const expDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

            // 3. ユーザーに24時間限定バッジを適用
            await botLabelerManager.applyLabel(userDid, def.id, false, expDate);
            console.log(`[INFO][BADGE][MORNING] Successfully applied morning talk badge ${def.id} to ${userDid} with exp=${expDate}`);
        } catch (badgeErr: any) {
            console.error(`[ERROR][BADGE][MORNING] Failed to apply morning talk badge for ${follower.did}:`, badgeErr.message);
        }

        // DB更新
        await MemoryService.updateFollower(follower.did, "question_root_uri", uriQuestionRoot);
        await MemoryService.updateFollower(follower.did, "last_answered_at", new Date());

        // conv_historyに質問回答の会話ペアを保存
        const followerRow = await MemoryService.getFollower(follower.did);
        let history: Content[] = [];
        if (followerRow?.conv_history) {
            history = typeof followerRow.conv_history === 'string'
                ? JSON.parse(followerRow.conv_history)
                : followerRow.conv_history;
        }
        const botReplyText = typeof result.reply === 'string' ? result.reply : '';
        history.push({ role: "user", parts: [{ text: record.text }] });
        history.push({ role: "model", parts: [{ text: botReplyText }] });
        await MemoryService.updateFollower(follower.did, "conv_history", history);
        await MemoryService.updateFollower(follower.did, "conv_root_cid", record.reply?.root.cid);

        console.log(`[INFO][QUESTION] Replied to answer from ${follower.did}: ${uri}`);

        return true;
    }

    // --- Whimsical Logic ---
    private async doWhimsicalPostReply(follower: ProfileView, event: CommitCreateEvent<"app.bsky.feed.post">) {
        const record = event.commit.record as Record;
        const uri = uniteDidNsidRkey(follower.did, event.commit.collection, event.commit.rkey);
        const rootUri = record.reply?.root.uri;
        const langStr = getLangStr(record.langs);

        // Root URIのチェック
        let rootUriRefs = await MemoryService.getBotState("whimsical_post_roots");

        // 移行期フォールバック（新キーがない場合は旧キーから取得して配列化）
        if (rootUriRefs === null || rootUriRefs === undefined) {
            const oldRoot = await MemoryService.getBotState("whimsical_post_root");
            rootUriRefs = oldRoot ? [oldRoot] : [];
            console.log(`[INFO][MIGRATION] Read whimsical_post_roots from old whimsical_post_root: ${oldRoot}`);
        }

        const rootUriRefsArray = Array.isArray(rootUriRefs) ? rootUriRefs : [];

        // 最新のつぶやき対象（ツリー内のどのポストでも可）かチェック
        // 1ユーザー1回限りに制限するため last_whimsical_responded_uri を使用
        if (rootUriRefsArray.includes(rootUri)) {
            // すでに最新のつぶやき群（日本語または英語）のいずれかにリプライ済みならスキップ
            const row = await MemoryService.getFollower(follower.did);
            const lastRespondedUri = row?.last_whimsical_responded_uri;
            if (lastRespondedUri && rootUriRefsArray.includes(lastRespondedUri)) {
                // console.log(`[INFO][${follower.did}][WHIMSICAL] already replied to one of the latest whimsical posts, skipping`);
                return false;
            }

            // リプライ生成
            const result = await generateWhimsicalReply({
                follower,
                posts: [record.text],
                langStr,
                botContext: await getBotContext(),
            });

            // ポスト
            await postContinuous(result, { uri, cid: String(event.commit.cid), record });

            // DB更新: リプライ済みURIを記録（今回のリプライ先URIを記録）
            await MemoryService.updateFollower(follower.did, "last_whimsical_responded_uri", rootUri);

            // conv_historyに定期ポスト返信の会話ペアを保存（rowはline 354でフェッチ済み）
            let history: Content[] = [];
            if (row?.conv_history) {
                history = typeof row.conv_history === 'string'
                    ? JSON.parse(row.conv_history)
                    : row.conv_history;
            }
            const botReplyText = typeof result === 'string' ? result : '';
            history.push({ role: "user", parts: [{ text: record.text }] });
            history.push({ role: "model", parts: [{ text: botReplyText }] });
            await MemoryService.updateFollower(follower.did, "conv_history", history);
            await MemoryService.updateFollower(follower.did, "conv_root_cid", record.reply?.root.cid);

            console.log(`[INFO][${follower.did}][WHIMSICAL] replied to reply of Whimsical post`);

            return true;
        } else {
            // console.log(`uri: ${uri}, uriRefs: ${JSON.stringify(rootUriRefsArray)}`);
            return false;
        }
    }
}
