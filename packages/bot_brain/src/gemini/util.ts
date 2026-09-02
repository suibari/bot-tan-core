import { PartListUnion, Type } from '@google/genai';
import { SYSTEM_INSTRUCTION, POST_TEXT_LIMIT, safeFetch, resolveAiRoute, formatJstActivityTime, energyLabel, OLLAMA_LONG_OUTPUT_TOKENS } from '@bsky-affirmative-bot/shared-configs';
import type { AiFeatureKey } from '@bsky-affirmative-bot/shared-configs';
import { UserInfoGemini, GeminiScore, BotContext, LanguageName } from '@bsky-affirmative-bot/shared-configs';
import { MemoryService, reportHealthFailure, reportHeartbeat } from '@bsky-affirmative-bot/database';
import { buildAffirmativeImageParts } from './affirmativeImages.js';
import { toServiceTier } from './aiRoute.js';
import { generateContentForProvider } from './generationClient.js';
import { groundingPolicyForFeature, prepareOllamaGrounding } from './grounding.js';
import {
  UNKNOWN_TERMS_INSTRUCTION,
  replyWithUnknownTermsSchema,
  reportSharedLinks,
  reportUnknownTerms,
  sanitizeUnknownTerms,
  withUnknownTermsProperty,
} from './unknownTerms.js';

export type GeminiRequestOptions = {
  /** 実際の Gemini HTTP リクエストを送る直前に呼ぶ。 */
  beforeRequest?: () => Promise<void>;
  /** 呼び出し元が明示した場合だけ既定モデルを上書きする。 */
  model?: string;
  /** Nagi の耐障害フォールバック用。未指定時は従来の購読状態に従う。 */
  serviceTier?: 'flex' | 'standard';
  /** Gemini 3.x の thinking level。未指定ならモデル既定値を使う。 */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  /** 本文を含めず usage とレイテンシだけを観測する。 */
  onUsage?: (usage: GeminiUsage) => void;
};

export type GeminiUsage = {
  model: string;
  serviceTier?: 'flex' | 'standard';
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  latencyMs: number;
  /** 以下は Ollama 経路だけ。Gemini では undefined。 */
  contextLimit?: number;
  outputLimit?: number;
  /** 出力が num_predict に達して途中で切れた。 */
  truncated?: boolean;
  /** 予算超過で落とした履歴メッセージ数。常時0でないなら上流が膨らみすぎている。 */
  trimmedTurns?: number;
};

/** Ollama 経路の応答から usage の追加フィールドを取り出す。Gemini では空。 */
export function ollamaUsageFields(response: any): Partial<GeminiUsage> {
  const meta = response?.ollamaMetadata;
  if (!meta) return {};
  return {
    contextLimit: meta.contextLimit,
    outputLimit: meta.outputLimit,
    truncated: meta.truncated,
    trimmedTurns: meta.trimmed?.droppedTurns,
  };
}

/**
 * プロンプトに載せる行動履歴の上限。
 *
 * step の最小間隔は5分なので、忙しい日は24時間で20件を超える。12件だと午前の記憶が丸ごと
 * 落ちて「今日やってたこと」を聞かれても答えられなくなるため 20 まで引き上げている。
 * 1件は status_text の200字上限に従うので、最悪でも4000字程度。
 */
const MAX_RECENT_ACTIVITIES = 20;

function recentActivityLines(
  botContext: BotContext,
  ja: boolean,
  now: Date,
): string {
  // 連続する同一行動を潰す。userDiaryContext.ts の compactDiaryActivities が同型の処理をするが、
  // あちらは {mood, mood_en} 型で until による打ち切りも持つので統合していない。
  const compact = (botContext.recentActivities ?? [])
    .filter((item, index, items) => {
      if (index === 0) return true;
      const previous = items[index - 1];
      return (
        previous.activity !== item.activity ||
        previous.activityEn !== item.activityEn
      );
    })
    .slice(-MAX_RECENT_ACTIVITIES);
  if (compact.length === 0) return '';
  const lines = compact.map((item) =>
    `- ${formatJstActivityTime(item.at, now, ja)}: ${ja ? item.activity : item.activityEn}`,
  );
  return ja
    ? `\n### 直近24時間の行動履歴（記録された事実・古い順）\n${lines.join('\n')}\n`
    : `\n### Activity history from the last 24 hours (recorded facts; oldest first)\n${lines.join('\n')}\n`;
}

/** いまいる場所。Nagi がホームで Bluesky が出張先、という関係をプロンプト側でも保つ。 */
function surfaceLine(botContext: BotContext, ja: boolean): string {
  if (!botContext.surface) return '';
  if (botContext.surface === 'nagi') {
    return ja
      ? '\n- いまいる場所：ホームのNagi（おうち。落ち着いていられる場所）'
      : "\n- Where you are: Nagi, your home (the calm place that's yours)";
  }
  return ja
    ? '\n- いまいる場所：出張先のBluesky（ホームはNagi）'
    : '\n- Where you are: Bluesky, where you visit every day (home is Nagi)';
}

/**
 * botContext をプロンプトの節に整形する用途。
 * - reply: リプライ・会話（相手がいる）
 * - scheduledPost: おはよう / 気まぐれ / おやすみ（相手がいない、記憶を素材として使う）
 */
export type BotContextPurpose = 'reply' | 'scheduledPost';

/** 見出しと注意書きだけが用途ごとに変わる。本体（箇条書き＋履歴）は共通。 */
function botContextHeading(
  purpose: BotContextPurpose,
  conversationHistoryAware: boolean,
  ja: boolean,
): string {
  if (purpose === 'scheduledPost') {
    return ja
      ? '## botたんの記憶（きょうまでの事実。過去に触れるときはここにあることだけを使うこと）'
      : "## Bot-tan's memory (facts so far today; when mentioning the past, use only what is here)";
  }
  if (conversationHistoryAware) {
    return ja
      ? '## botたんの現在状況（必要な場合だけ参照する背景情報）\nこの情報を返答へ必ず盛り込む必要はありません。最新のユーザメッセージと会話の流れを優先してください。\n直近の会話ですでに触れた状況は繰り返さず、過去について話す場合は行動履歴と会話履歴を照合してください。記録にない出来事を作らず、時系列を推測で進めないでください。現在の状況で過去の事実を上書きしてはいけません。'
      : "## Bot's current situation (background; use only when needed)\nYou do not need to mention this information in every response. Prioritize the user's latest message and the conversation flow.\nDo not repeat a situation already mentioned recently. When discussing the past, cross-check the activity history and conversation history. Do not invent how this snapshot progressed over time, add unrecorded events, or overwrite past facts with the current snapshot.";
  }
  return ja
    ? '## botたんの状況（参考にして返答をパーソナライズしてください）\n過去に触れる場合は行動履歴を事実として使い、記録外の出来事を足したり現在の状況で上書きしたりしないでください。'
    : "## Bot's situation (use this to personalize your response)\nWhen mentioning the past, treat the activity history as fact. Do not add unrecorded events or overwrite past facts with the current snapshot.";
}

/** 定期ポストだけ、記憶の使い方を末尾で締める（相手がいないぶん全部読み上げがちなため）。 */
function botContextFooter(purpose: BotContextPurpose, ja: boolean): string {
  if (purpose !== 'scheduledPost') return '';
  return ja
    ? 'ルール:\n- 履歴をぜんぶ書き並べる必要はありません。いまの気分に自然につながるものを1つか2つだけ拾ってください。\n- 記録にない出来事を作らないこと。履歴の出来事を「これからやる」ことのように書かないこと。\n'
    : 'Rules:\n- Do not list the whole history. Pick only one or two entries that connect naturally to your current mood.\n- Do not invent events that are not recorded, and do not describe a past entry as something you are about to do.\n';
}

export function formatBotContext(
  botContext?: BotContext,
  langStr?: LanguageName,
  options: {
    conversationHistoryAware?: boolean;
    purpose?: BotContextPurpose;
    /** テスト用。相対時間の基準時刻。 */
    now?: Date;
  } = {},
): string {
  if (!botContext) return '';
  const ja = langStr === '日本語';
  const purpose = options.purpose ?? 'reply';
  const now = options.now ?? new Date();
  const heading = botContextHeading(
    purpose,
    Boolean(options.conversationHistoryAware),
    ja,
  );
  const body = ja
    ? `- 日時：${botContext.datetime}\n- 天気：${botContext.weather}${surfaceLine(botContext, ja)}\n- いまやってること：${botContext.botActivity}\n- 元気度：${energyLabel(botContext.botEnergy, true)}`
    : `- Date/Time: ${botContext.datetime}\n- Weather: ${botContext.weather}${surfaceLine(botContext, ja)}\n- Currently: ${botContext.botActivityEn}\n- Energy: ${energyLabel(botContext.botEnergy, false)}`;
  return `\n---\n${heading}\n${body}\n${recentActivityLines(botContext, ja, now)}${botContextFooter(purpose, ja)}`;
}

/**
 * 応答が長さのガードに引っかかるか。
 *
 * このガードは「投稿本文が暴走していないか」を見るためのもので、投稿にならない応答
 * （日次予定表のような長い構造化JSON）に効かせてはいけない。そこで引っかけても
 * 縮まらないまま retryCount ぶん焼いて最後のものを返すだけになる。
 * limit が null のときは制限なし。
 */
export function exceedsTextLimit(text: string, limit: number | null): boolean {
  return limit !== null && text.length > limit;
}

/** maxTextLength 未指定なら投稿用の既定値。null は「上限なし」の明示。 */
export function resolveTextLimit(maxTextLength: number | null | undefined): number | null {
  return maxTextLength === undefined ? POST_TEXT_LIMIT : maxTextLength;
}

/**
 * POST_TEXT_LIMITを超える場合はリトライするgenerateContentのラッパー
 * userinfo が渡された場合、プロンプトの末尾に共通コンテキスト（日時・天気・bot状態）を自動付与する
 *
 * 長さのガードは「投稿本文が暴走していないか」を見るためのもの。投稿にならない応答
 * （長い構造化JSONなど）では `maxTextLength: null` を渡して外すこと。外さないと、
 * 正当に長い応答を縮まらないまま3回焼いて最後のものを返すだけになる。
 */
export async function generateContentWithRetry(
  params: any & { feature?: AiFeatureKey; maxTextLength?: number | null },
  retryCount = 3,
  userinfo?: UserInfoGemini,
  requestOptions: GeminiRequestOptions = {},
): Promise<any> {
  // 呼び出し側は model ではなく feature（機能キー）を名乗る。実モデルと serviceTier は
  // レジストリが決める。feature は Gemini API のペイロードに混ぜてはいけないので必ず剥がす。
  // maxTextLength も同様に API へ渡してはいけない内部向けの指定。
  const { feature, maxTextLength, ...rest } = params;
  const textLimit = resolveTextLimit(maxTextLength);
  const routed = feature ? resolveAiRoute(feature) : undefined;
  const provider = routed?.provider ?? 'gemini';
  // 優先順位: 明示 requestOptions（Nagi の再試行ラダー） > feature のルート > params の生 model
  const serviceTier = toServiceTier(requestOptions.serviceTier ?? routed?.serviceTier);
  params = {
    ...rest,
    model: requestOptions.model ?? routed?.model ?? rest.model,
    config: {
      ...rest.config,
      // `maxTextLength: null` は「これは投稿本文ではない長い応答」という既存の意思表示。
      // Ollama では num_predict の既定（投稿用の 1024）だと足りないので、そこへ連動させる。
      // Gemini は maxOutputTokens を積まない従来どおりの挙動のまま。
      ...(provider === 'ollama' &&
      maxTextLength === null &&
      typeof rest.config?.maxOutputTokens !== 'number'
        ? { maxOutputTokens: OLLAMA_LONG_OUTPUT_TOKENS }
        : {}),
      // ルートが "auto" のときは serviceTier を積まない（現状の未設定挙動を維持）
      ...(serviceTier ? { serviceTier } : {}),
      ...(requestOptions.thinkingLevel
        ? { thinkingConfig: { thinkingLevel: requestOptions.thinkingLevel } }
        : {}),
    },
  };

  if (provider === 'ollama') {
    // 事前に調べてある事実（bot memory の web_research）があれば同期パスでも根拠にできる。
    params = await prepareOllamaGrounding(feature, params, {}, userinfo?.researchMemory);
    // 貼られたリンクは本文まで読みに行く（Gemini の URL Context の置き換え）。
    // 同期では読まず、非同期ワーカーへ回して次回以降に効かせる。
    if (groundingPolicyForFeature(feature) === 'deferred') reportSharedLinks(userinfo);
  }

  if (userinfo?.botContext) {
    const botCtx = formatBotContext(userinfo.botContext, userinfo.langStr);
    if (Array.isArray(params.contents) && typeof params.contents[0] === 'string') {
      params = {
        ...params,
        contents: [params.contents[0] + botCtx, ...params.contents.slice(1)],
      };
    } else if (typeof params.contents === 'string') {
      params = { ...params, contents: params.contents + botCtx };
    }
  }

  let response;
  for (let i = 0; i <= retryCount; i++) {
    // APIの接続や高負荷エラー（503等）は内部リトライせず、上位関数（callbacks.ts）の一元リトライに即座に委ねる
    try {
      // Nagi の既存 quota reservation は Gemini 課金用。ローカル生成では消費しない。
      if (provider === 'gemini') await requestOptions.beforeRequest?.();
      const startedAt = Date.now();
      response = await generateContentForProvider(provider, params);
      const usage = response.usageMetadata ?? {};
      requestOptions.onUsage?.({
        model: params.model,
        ...(requestOptions.serviceTier
          ? { serviceTier: requestOptions.serviceTier }
          : routed?.serviceTier === 'flex' || routed?.serviceTier === 'standard'
            ? { serviceTier: routed.serviceTier }
            : {}),
        promptTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        thinkingTokens: usage.thoughtsTokenCount ?? 0,
        totalTokens: usage.totalTokenCount ?? 0,
        latencyMs: Date.now() - startedAt,
        ...ollamaUsageFields(response),
      });
    } catch (e) {
      // 呼び出し回数は generateContentForProvider が数えるので、ここでは数えない。
      // 死活監視は「最後に成功したのはいつか」だけでは足りない。エラーを返し続けて
      // いる状態を検知するため、失敗そのものを記録する。追加の API 呼び出しは
      // しない（プローブで RPD を消費したくない）。
      reportHealthFailure(provider === 'ollama' ? 'local-llm' : 'gemini', e).catch(() => {});
      throw e;
    }
    const text = response.text || '';

    reportHeartbeat(provider === 'ollama' ? 'local-llm' : 'gemini').catch(() => {});

    // 文字数制限チェック（文字数超過時のみ、モデル生成のやり直しとして内部リトライを許容）
    if (!exceedsTextLimit(text, textLimit)) {
      return response;
    }
    console.warn(
      `[WARN] Generated content exceeded ${textLimit} characters (${text.length}). Retrying... (${i + 1}/${retryCount})`,
    );
  }
  console.warn(
    `[WARN] Failed to generate content under ${textLimit} characters after ${retryCount} retries. Returning last response.`,
  );
  return response;
}

/**
 * 必要に応じて画像を付与してシングルレスポンスを得る
 *
 * この関数は多くの機能から共有されるため、モデル/tier は呼び出し側が名乗る feature キーで決まる。
 * feature に既定値を持たせないのは、新しい呼び出しがどれかの機能キーに必ず紐づくよう
 * コンパイラに強制させるため。
 */
export async function generateSingleResponse(
  prompt: string,
  userinfo: UserInfoGemini | undefined,
  feature: AiFeatureKey,
): Promise<string> {
  const contents: PartListUnion = [prompt];

  if (userinfo?.image) {
    for (const img of userinfo.image) {
      try {
        const response = await safeFetch(img.image_url);
        if (!response.ok) {
          console.warn(`[WARN] Failed to fetch image: ${img.image_url} (Status: ${response.status})`);
          continue;
        }
        const imageArrayBuffer = await response.arrayBuffer();
        const base64ImageData = Buffer.from(imageArrayBuffer).toString('base64');
        contents.push({
          inlineData: {
            mimeType: img.mimeType,
            data: base64ImageData,
          },
        });
      } catch (e) {
        console.warn(`[WARN] Error fetching image: ${img.image_url}`, e);
        continue;
      }
    }
  }

  // リプライ系は同期パスで検索しない代わりに、生成と同じ1回のリクエストで
  // 「知らなかった語」を申告させ、非同期で調べる。判定用のLLM呼び出しは増えない。
  const collectsTerms = groundingPolicyForFeature(feature) === 'deferred';

  const response = await generateContentWithRetry(
    {
      feature,
      contents,
      config: {
        systemInstruction: collectsTerms
          ? `${SYSTEM_INSTRUCTION}\n${UNKNOWN_TERMS_INSTRUCTION}`
          : SYSTEM_INSTRUCTION,
        ...(collectsTerms
          ? {
              responseMimeType: 'application/json',
              responseSchema: replyWithUnknownTermsSchema(),
            }
          : {}),
        tools: [
          {
            googleSearch: {},
          },
        ],
      },
    },
    3,
    userinfo,
  );

  let responseText = response.text || '';
  if (collectsTerms) {
    // 構造化に失敗したら、生成そのものを落とさず素のテキストとして扱う。
    try {
      const parsed = extractJSON(responseText) as { reply?: unknown; unknownTerms?: unknown };
      if (typeof parsed?.reply === 'string') responseText = parsed.reply;
      reportUnknownTerms(sanitizeUnknownTerms(parsed?.unknownTerms));
    } catch {
      console.warn('[WARN][UNKNOWN_TERMS] 構造化出力の解析に失敗。素のテキストとして続行する。');
    }
  }

  // Gemini出力の"["から"]"まで囲われたすべての部分を除去
  return responseText.replace(/\[.*?\]/gs, '');
}

/**
 * 必要に応じて画像を付与して、botたんスコア付きのシングルレスポンスを得る
 */
export function extractJSON(text: string): any {
  try {
    // 1. Markdownのコードブロックを抽出
    const match = text.match(/```json\n([\s\S]*?)\n```/);
    if (match) {
      return JSON.parse(match[1]);
    }

    // 2. コードブロックがない場合、最初と最後の括弧を探して抽出
    const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    // 3. そのままパースを試みる
    return JSON.parse(text);
  } catch (e) {
    console.warn('JSON parse failed:', text);
    throw new Error('Failed to extract JSON from response');
  }
}

/**
 * 必要に応じて画像を付与して、botたんスコア付きのシングルレスポンスを得る
 *
 * `options.maxTextLength` は暴走検知のしきい値。未指定なら投稿用の既定（POST_TEXT_LIMIT）。
 * 呼び出し側がこれを渡すのは「プロンプトで長さを縛らない代わりに、明らかな暴走だけコードで
 * 弾きたい」ケース（generateAffirmativeWord）。ガードは JSON 全体の文字数に効くので、
 * comment の実効長は指定値よりいくらか短くなる。
 */
export async function generateSingleResponseWithScore(
  prompt: string,
  userinfo?: UserInfoGemini,
  requestOptions: GeminiRequestOptions = {},
  options: { maxTextLength?: number | null } = {},
) {
  const contents: PartListUnion = [prompt];
  // responseSchema は Google Search との併用ができず外していたが、Gemini を撤去して
  // Ollama の format を使えるようになった。comment / score の形は従来どおり
  // プロンプトが決めるので縛らず、unknownTerms だけを追加で申告させる。

  if (userinfo?.image?.length) {
    const { parts, stats } = await buildAffirmativeImageParts(userinfo.image, userinfo.langStr);
    contents.push(...parts);
    console.log('[INFO][GEMINI] Affirmative image input:', stats);
    if (!parts.length) {
      console.warn('[WARN][GEMINI] No auxiliary images could be loaded');
    }
  }

  const tools: any[] = [
    {
      googleSearch: {},
    },
  ];

  const links = userinfo?.embed?.links_embed?.map((link) => link.uri) ?? [];
  if (userinfo?.embed?.uri_embed && !links.includes(userinfo.embed.uri_embed)) {
    links.push(userinfo.embed.uri_embed);
  }
  const useUrlContext = Boolean(
    links.length && (userinfo?.urlContextEnabled ?? Boolean(userinfo?.embed?.uri_embed && userinfo?.isSubscriber)),
  );
  if (useUrlContext) {
    tools.push({
      urlContext: {},
    });
    console.log(`[INFO][GEMINI] URL Context tool enabled for ${links.length} URL(s): ${links.join(', ')}`);
  }

  const request = (requestTools: any[]) =>
    generateContentWithRetry(
      {
        // model / serviceTier は generateContentWithRetry がレジストリと requestOptions から決める
        feature: 'BSKY_AFFIRMATIVE_REPLY' satisfies AiFeatureKey,
        ...(options.maxTextLength !== undefined ? { maxTextLength: options.maxTextLength } : {}),
        contents,
        config: {
          systemInstruction: `${SYSTEM_INSTRUCTION}\n${UNKNOWN_TERMS_INSTRUCTION}`,
          tools: requestTools,
        },
      },
      3,
      userinfo,
      requestOptions,
    );
  let response;
  try {
    response = await request(tools);
  } catch (error) {
    if (!useUrlContext) throw error;
    console.warn('[WARN][GEMINI] URL Context request failed; retrying with card metadata only', error);
    response = await request([{ googleSearch: {} }]);
  }

  const result = extractJSON(response.text || '') as GeminiScore[];

  // 返信を書いたモデル自身が申告した「知らなかった語」を非同期の調査へ回す。
  const scored = Array.isArray(result) ? result[0] : (result as unknown as GeminiScore);
  reportUnknownTerms(sanitizeUnknownTerms((scored as any)?.unknownTerms));

  // Gemini出力の"["から"]"まで囲われたすべての部分を除去
  // (検索引用などが残っていた場合のクリーニング)
  if (Array.isArray(result)) {
    result.forEach((item) => {
      if (item.comment) {
        item.comment = item.comment.replace(/\[.*?\]/gs, '');
      }
    });
    return result[0];
  } else {
    // 配列でない場合（単一オブジェクトで返ってきた場合など）のフォールバック
    const singleResult = result as unknown as GeminiScore;
    if (singleResult.comment) {
      singleResult.comment = singleResult.comment.replace(/\[.*?\]/gs, '');
    }
    return singleResult;
  }
}

// Extracted to shared-configs

/**
 * テキスト内のURLの前後に半角スペースを保証する（Bluesky誤パース防止）
 * URLの末尾に混入した句読点・括弧類も除去する
 */
export const normalizeUrlSpacing = (text: string): string =>
  text
    .replace(/https?:\/\/[^\s]+/g, (url) => url.replace(/[.。、，,！？!?「」『』【】（）\[\]{}]+$/, ''))
    .replace(/([^\s])(https?:\/\/)/g, '$1 $2')
    .replace(/(https?:\/\/[\x21-\x7E]+)([^\s\x00-\x7F])/g, '$1 $2');

/**
 * JSONレスポンスの生成とパースを行う共通ヘルパー
 * パースに失敗した場合は例外を投げ、callbacks.tsの共通リトライ機構に処理を委ねます。
 */
export async function generateSingleResponseJSON<T>(
  prompt: string,
  userinfo: UserInfoGemini | undefined,
  parser: (text: string) => T,
  feature: AiFeatureKey,
): Promise<T> {
  const responseText = await generateSingleResponse(prompt, userinfo, feature);
  return parser(responseText);
}
