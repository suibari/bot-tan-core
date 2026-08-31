import {
  conversation,
  generateAffirmativeWord,
  getYokohamaWeather,
  judgeNameIntent,
  createPredefinedReply,
  assertUsableReply,
  type GeminiUsage,
} from "@bsky-affirmative-bot/bot-brain";
import { aiModel } from "@bsky-affirmative-bot/shared-configs";
import {
  botBiothythmManager,
  loadPreferredName,
  MemoryService,
} from "@bsky-affirmative-bot/clients";
import {
  configureBotContext,
  getBotContext,
} from "@bsky-affirmative-bot/bot-runtime";
import {
  NAGI,
  NAGI_LANGUAGES,
  isAppviewOwnedUri,
} from "@bsky-affirmative-bot/nagi-lexicon";
import {
  buildNagiConversationHistory,
  type ConversationTurn,
} from "./nagiConversationHistory.js";
import { createKossoriReply } from "./appviewInternal.js";
import { isKossoriReplyToBot, isReplyToBot } from "./NagiReplyFeature.js";
import {
  buildNagiReplyContext,
  loadNagiReplyAuthor,
} from "./nagiReplyContext.js";
import { publishNagiPost } from "./nagiPost.js";
import { resolveNagiBluemojiFacets } from "./nagiBluemojiFacets.js";
import type { NagiReplyMode } from "./nagiAiQuota.js";
import { nagiAiRouteForAttempt } from "./nagiReplyRetry.js";
import type { NagiAiRouteDetails } from "./nagiReplyRetry.js";

configureBotContext({
  surface: "nagi",
  getWeather: getYokohamaWeather,
  getStatus: () => botBiothythmManager.getContext(),
  getRecentActivities: async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await MemoryService.getBiorhythmHistorySince(since);
    return rows.map((row) => ({
      at: new Date(row.created_at).toISOString(),
      activity: row.mood,
      activityEn: row.mood_en || row.mood,
    }));
  },
});

/**
 * 生成1回ぶんの usage をログへ出す。
 *
 * onUsage は前からあったのに返信経路では誰も出していなかったため、
 * 「返信が壊れた」ときに Ollama の journal を漁るしか調べる手が無かった。
 * promptTokens と contextLimit の比が 1 に近づいていたら、それが事故の前触れ。
 */
function logReplyUsage(
  did: string,
  mode: "conversation" | "affirmative",
  usage: GeminiUsage,
  extra: { historyTurns?: number } = {},
) {
  console.log(
    `[INFO][NAGI][${did}] ${mode} usage: model=${usage.model} tier=${usage.serviceTier ?? "-"}` +
      ` in=${usage.promptTokens}/${usage.contextLimit ?? "-"}` +
      ` out=${usage.outputTokens}/${usage.outputLimit ?? "-"}` +
      ` truncated=${usage.truncated ?? false} trimmedTurns=${usage.trimmedTurns ?? 0}` +
      (extra.historyTurns === undefined ? "" : ` historyTurns=${extra.historyTurns}`) +
      ` ms=${usage.latencyMs}`,
  );
}

function replyLanguage(langs: unknown) {
  const value = Array.isArray(langs) ? String(langs[0] ?? "") : "";
  const code = value.split("-")[0]?.toLowerCase();
  return (
    NAGI_LANGUAGES.find((language) => language.code === code) ?? {
      code: "en",
      name: "English",
    }
  );
}

/**
 * 本人が「こう呼んで」と言ってきたら覚える。
 *
 * **検知は Nagi 側だけに置く**（Bluesky から呼び方を変える経路は作らない方針）。
 * 読み取りは DID キーなので Bluesky 側のリプライにも同じ呼称が効く。
 *
 * 判定は自然文なので必ず外すことがある。誤って変な呼び名を覚えると、以後ずっと
 * その名前で呼び続けることになる（呼称ドリフトの事故と同じ実害）ので、
 * judgeNameIntent 側で self 以外・低確信度・名前でない語をすべて捨てている。
 * 失敗はここでも握り潰す。呼び名が更新されないだけで返信は成立する。
 */
async function detectPreferredName(did: string, userText: string) {
  try {
    const intent = await judgeNameIntent(userText);
    if (intent.intent === "none" || !intent.name) return;
    await MemoryService.setPreferredName({
      did,
      name: intent.name,
      source: "declared",
      model: aiModel("NAGI_NAME_INTENT"),
    });
    console.log(
      `[INFO][NAGI][${did}] preferred name updated (${intent.intent}, confidence ${intent.confidence})`,
    );
  } catch (error) {
    console.warn(`[WARN][NAGI][${did}] preferred name detection failed:`, error);
  }
}

/**
 * 会話モード。Bluesky の ConversationFeature と同じく conv_history を記憶として
 * 引き回し、生成後に更新する。スコアは付けない（肯定ポストとして扱わない）。
 */
async function generateConversationReply(
  job: any,
  context: Awaited<ReturnType<typeof buildNagiReplyContext>>,
  langStr: string,
  beforeRequest: (() => Promise<void>) | undefined,
  aiRoute: NagiAiRouteDetails,
) {
  const did = job.authorDid;
  const userText = context.posts[0] ?? "";
  const history = await buildNagiConversationHistory(job);

  // 呼び名の申告/訂正の判定は返信生成と**並列**に投げる。判定は grounding を使わないので
  // responseSchema で構造を保証でき、返信の生成物には一切触れない。
  // 結果が効くのは次回以降の返信で、その場の返信は会話プロンプトの
  // 「訂正には従う」が受け持つ。判定が失敗しても返信は止めない。
  const namePromise = detectPreferredName(did, userText);

  let truncated = false;
  const result = await conversation(
    {
      follower: context.follower,
      preferredName: context.preferredName,
      posts: [userText],
      image: context.image,
      embed: context.embed,
      history,
      isSubscriber: true,
      urlContextEnabled: context.urlContextEnabled,
      botContext: await getBotContext(),
      langStr,
    } as any,
    // 肯定返信と同じく、再試行ラダーが選んだモデル/tierを明示する。
    // 渡さないと BSKY_CONVERSATION のルートに落ち、ワーカーのログと実態がずれる。
    {
      beforeRequest,
      model: aiRoute.model,
      serviceTier: aiRoute.serviceTier,
      onUsage: (usage) => {
        truncated = usage.truncated === true;
        logReplyUsage(did, "conversation", usage, { historyTurns: history.length });
      },
    },
  );
  const comment = result.text_bot ?? "";
  const newHistory: ConversationTurn[] = result.new_history ?? [];
  assertUsableReply(comment, context.preferredName || context.follower.displayName, {
    truncated,
  });

  // 最後の user ターンをプロンプト全文から純粋な入力テキストのみに置換する。
  for (let i = newHistory.length - 1; i >= 0; i--) {
    if (newHistory[i].role !== "user") continue;
    newHistory[i] = { role: "user", parts: [{ text: userText }] };
    break;
  }

  // 会話記録に inlineData（画像）が含まれると巨大すぎるので削除しておく。
  for (const content of newHistory) {
    if (!content.parts) continue;
    content.parts = content.parts.filter(
      (part: any) => !("inlineData" in part),
    );
  }

  // Nagi 限定ユーザには followers 行が無いことがある。ensureFollower は
  // 新規行で follow 統計を加算してしまうため、素の upsert を使う。
  await MemoryService.upsertFollowerInteraction(did);
  await MemoryService.updateFollower(did, "conv_history", newHistory);
  await MemoryService.updateFollower(did, "last_conv_at", new Date());
  await MemoryService.logUsage("conversation", did);
  // ここで初めて待つ。生成と並列に走らせているので待ち時間はほぼ無いが、
  // ワーカーのパスが終わる前に必ず決着させる（投げっぱなしにしない）。
  await namePromise;
  console.log(`[INFO][NAGI][${did}] send conversation-result`);

  return { comment, score: undefined };
}

export async function createNagiReply(
  job: any,
  options: {
    mode: NagiReplyMode;
    beforeGeminiRequest?: () => Promise<void>;
    aiRoute?: NagiAiRouteDetails;
  },
) {
  const record: any = job.recordJson;
  const language = replyLanguage(record.langs);
  // こっそりは URI から書き手を辿れないので、親の did を DB で引く版を使う。
  const conversationMode = isAppviewOwnedUri(job.sourceUri)
    ? await isKossoriReplyToBot(record, process.env.NAGI_BOT_DID!)
    : isReplyToBot(record, process.env.NAGI_BOT_DID!);
  let generated: { comment: string; score?: number };
  let replyAuthorHandle: string | undefined;

  if (options.mode === "template") {
    const [author, preferredName] = await Promise.all([
      loadNagiReplyAuthor(job.authorDid),
      loadPreferredName(job.authorDid),
    ]);
    replyAuthorHandle = author.view.handle;
    generated = {
      comment: await createPredefinedReply(
        {
          text: typeof record.text === "string" ? record.text : "",
          languageName: language.name,
          // 定型文は ${name} を機械置換するだけなので、AI 生成側と同じ呼び名を渡せば揃う。
          displayName: preferredName || author.view.displayName,
        },
        { surface: "nagi" },
      ),
    };
  } else {
    const context = await buildNagiReplyContext(job);
    replyAuthorHandle = context.follower.handle;
    const aiRoute = options.aiRoute ?? nagiAiRouteForAttempt(1);
    let affirmativeTruncated = false;
    console.log("[INFO][NAGI] Gemini reply context:", {
      ...context.diagnostics,
      mode: conversationMode ? "conversation" : "affirmative",
    });
    generated = conversationMode
      ? await generateConversationReply(
          job,
          context,
          language.name,
          options.beforeGeminiRequest,
          aiRoute,
        )
      : await generateAffirmativeWord(
          {
            follower: context.follower,
            preferredName: context.preferredName,
            posts: context.posts,
            image: context.image,
            embed: context.embed,
            likedByFollower: context.likedByFollower,
            followersFriend: context.followersFriend,
            isSubscriber: context.isSubscriber,
            urlContextEnabled: context.urlContextEnabled,
            botContext: await getBotContext(),
            langStr: language.name,
          } as any,
          {
            beforeRequest: options.beforeGeminiRequest,
            model: aiRoute.model,
            serviceTier: aiRoute.serviceTier,
            onUsage: (usage) => {
              affirmativeTruncated = usage.truncated === true;
              logReplyUsage(job.authorDid, "affirmative", usage);
            },
          },
        );

    if (!conversationMode) {
      assertUsableReply(
        generated.comment,
        context.preferredName || context.follower.displayName,
        { truncated: affirmativeTruncated },
      );
    }
  }

  const sourceRkey = job.sourceUri.split("/").at(-1)!;
  const root = record.reply?.root ?? {
    uri: job.sourceUri,
    cid: job.sourceCid,
  };

  const replyRef = {
    root,
    parent: {
      uri: job.sourceUri,
      cid: job.sourceCid,
    },
  };

  // こっそりスレッドの返信だけは PDS へ書かない。書くと返信本文が botたんの公開
  // リポジトリから誰でも読めてしまい、親のこっそり投稿を隠した意味が無くなる。
  // rkey は PDS 側の putRecord と同じくソース由来で決め打ちし、ジョブのリトライで
  // 二重投稿にならないようにする（親と同じ authority なので接尾辞で衝突を避ける）。
  if (isAppviewOwnedUri(job.sourceUri)) {
    const facets = await resolveNagiBluemojiFacets(
      generated.comment,
      Array.isArray(record.facets) ? record.facets : undefined,
    );
    const created = await createKossoriReply({
      text: generated.comment,
      ...(facets.length ? { facets } : {}),
      langs: [language.code],
      reply: replyRef,
      rkey: `${sourceRkey}-bot`,
    });
    return {
      uri: created.uri,
      score:
        generated.score === undefined
          ? undefined
          : Math.max(0, Math.min(100, Math.round(generated.score))),
    };
  }

  const response = await publishNagiPost({
    text: generated.comment,
    sourceFacets: Array.isArray(record.facets) ? record.facets : undefined,
    // displayName が未設定の相手は handle で呼ぶが、ドメイン風の文字列として
    // RichText が外部URLへ自動変換しないよう、返信相手のhandleだけを保護する。
    autoLinkExclusions: replyAuthorHandle ? [replyAuthorHandle] : [],
    label: "NAGI_REPLY",
    rkey: sourceRkey,
    langs: [language.code],
    // 所属チャンネルもこっそりと同じくスレッドルートだけが所有する。返信レコードへは
    // 複製せず、AppView が reply.root から channel_uri を解決して CH TL に並べる
    // （複製すると、返信単位で所属や公開範囲を持てるように見えてしまう）。
    reply: replyRef,
  });

  return {
    uri: response.uri,
    // 会話ターンはスコアを持たない = 肯定ポストとして扱わない。
    score:
      generated.score === undefined
        ? undefined
        : Math.max(0, Math.min(100, Math.round(generated.score))),
  };
}
