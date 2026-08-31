import {
  OLLAMA_DEFAULT_OUTPUT_TOKENS,
  OLLAMA_MIN_OUTPUT_TOKENS,
  estimateMessagesTokens,
  ollamaPromptBudget,
  ollamaTextContextLength,
  type AiProvider,
} from "@bsky-affirmative-bot/shared-configs";
import { gemini } from "./googleClient.js";
import { reportAiCallAsync } from "./aiCallStats.js";

type Message = {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
};

type OllamaChatResponse = {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
};

/** プロンプトが num_ctx を食い潰した。投稿させてはいけない。 */
export class OllamaContextOverflowError extends Error {
  readonly promptTokens: number;
  readonly contextLimit: number;
  constructor(promptTokens: number, contextLimit: number) {
    super(
      `Ollama prompt filled the context window (${promptTokens}/${contextLimit}); no room left to generate`,
    );
    this.name = "OllamaContextOverflowError";
    this.promptTokens = promptTokens;
    this.contextLimit = contextLimit;
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;

function textFromParts(parts: unknown): { text: string; images: string[] } {
  const result = { text: "", images: [] as string[] };
  const list = Array.isArray(parts) ? parts : [parts];
  for (const part of list) {
    if (typeof part === "string") {
      result.text += part;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const value = part as {
      text?: unknown;
      inlineData?: { data?: unknown };
      functionResponse?: { name?: unknown; response?: unknown };
    };
    if (typeof value.text === "string") result.text += value.text;
    if (typeof value.inlineData?.data === "string") {
      result.images.push(value.inlineData.data);
    }
    if (value.functionResponse) {
      result.text += `\n<tool_result name="${String(value.functionResponse.name ?? "tool")}">\n${JSON.stringify(value.functionResponse.response ?? {})}\n</tool_result>`;
    }
  }
  return result;
}

function contentToMessage(content: unknown): Message | undefined {
  if (typeof content === "string") return { role: "user", content };
  if (!content || typeof content !== "object") return undefined;
  const value = content as { role?: unknown; parts?: unknown };
  const parsed = textFromParts(value.parts ?? content);
  const role = value.role === "model" || value.role === "assistant" ? "assistant" : "user";
  if (!parsed.text && !parsed.images.length) return undefined;
  return {
    role,
    content: parsed.text,
    ...(parsed.images.length ? { images: parsed.images } : {}),
  };
}

export function toOllamaMessages(params: any): Message[] {
  const messages: Message[] = [];
  const system = params.config?.systemInstruction;
  if (system) {
    const parsed =
      typeof system === "string"
        ? { text: system, images: [] as string[] }
        : textFromParts((system as any).parts ?? system);
    if (parsed.text) messages.push({ role: "system", content: parsed.text });
  }

  const contents = params.contents;
  if (typeof contents === "string") {
    messages.push({ role: "user", content: contents });
  } else if (Array.isArray(contents)) {
    const isHistory = contents.some(
      (item) => item && typeof item === "object" && "role" in item,
    );
    if (isHistory) {
      for (const item of contents) {
        const message = contentToMessage(item);
        if (message) messages.push(message);
      }
    } else {
      const parsed = textFromParts(contents);
      messages.push({
        role: "user",
        content: parsed.text,
        ...(parsed.images.length ? { images: parsed.images } : {}),
      });
    }
  } else {
    const message = contentToMessage(contents);
    if (message) messages.push(message);
  }
  return messages;
}

export type OllamaTrimReport = {
  /** 落とした履歴メッセージ数。 */
  droppedTurns: number;
  /** grounding の調査ブロックを縮めた/消したか。 */
  groundingShrunk: boolean;
  /** 落とした画像枚数。 */
  droppedImages: number;
  /** 最後のユーザ入力そのものを切ったか（ここまで来たら設計が破綻している）。 */
  truncatedInput: boolean;
  /** 見積もりトークン数（トリム前 → 後）。 */
  estimatedBefore: number;
  estimatedAfter: number;
};

const GROUNDING_BLOCK = /<grounding_research>[\s\S]*?<\/grounding_research>/;

/** 履歴の先頭が assistant で始まらないよう整える（Geminiの整合則と同じ）。 */
function dropLeadingAssistant(middle: Message[]): void {
  while (middle.length && middle[0].role === "assistant") middle.shift();
}

/**
 * プロンプトを予算内に収める。**Ollama へ出る全テキスト生成がここを通る**ので、
 * 呼び出し側の設計不備によらず「出力枠が必ず残る」ことをここで保証する。
 *
 * Ollama 側の自動トリムに任せてはいけない理由は ollamaBudget.ts のコメントの通り。
 * 削る順序は「捨てても会話が成立する度合いが低い順」:
 * 履歴 → grounding の調査結果 → 画像 → 最後の入力そのもの。
 * system（ペルソナ）と最後のユーザ入力は原則として守る。
 */
export function fitOllamaMessages(
  messages: Message[],
  options: { budget: number },
): { messages: Message[]; trim: OllamaTrimReport } {
  const budget = options.budget;
  const estimatedBefore = estimateMessagesTokens(messages);

  // 呼び出し側の配列とオブジェクトは壊さない（履歴は会話記録として再利用される）。
  const cloned = messages.map((message) => ({
    ...message,
    ...(message.images ? { images: [...message.images] } : {}),
  }));

  const system = cloned.filter((message) => message.role === "system");
  const rest = cloned.filter((message) => message.role !== "system");
  // 最後のユーザ入力＝今回のメッセージ。ここから後ろは守る。user が無ければ末尾を守る。
  const lastUser = rest.map((message) => message.role).lastIndexOf("user");
  const anchorIndex = lastUser >= 0 ? lastUser : rest.length - 1;
  const middle = anchorIndex > 0 ? rest.slice(0, anchorIndex) : [];
  const tail = anchorIndex >= 0 ? rest.slice(anchorIndex) : [];
  const middleCount = middle.length;

  const assemble = () => [...system, ...middle, ...tail];
  const fits = () => estimateMessagesTokens(assemble()) <= budget;

  if (fits()) {
    return {
      messages,
      trim: {
        droppedTurns: 0,
        groundingShrunk: false,
        droppedImages: 0,
        truncatedInput: false,
        estimatedBefore,
        estimatedAfter: estimatedBefore,
      },
    };
  }

  // 1. 履歴を古い順に2件（user/assistantのペア）ずつ落とす。
  while (middle.length && !fits()) {
    middle.splice(0, Math.min(2, middle.length));
    dropLeadingAssistant(middle);
  }

  // 2. grounding の調査ブロックを縮める → 消す。最大8,000字あり効果が大きい。
  const anchor = tail[0];
  let groundingShrunk = false;
  if (anchor && !fits() && GROUNDING_BLOCK.test(anchor.content)) {
    anchor.content = anchor.content.replace(
      GROUNDING_BLOCK,
      (block) => `${block.slice(0, Math.floor(block.length / 2))}\n</grounding_research>`,
    );
    groundingShrunk = true;
    if (!fits()) anchor.content = anchor.content.replace(GROUNDING_BLOCK, "");
  }

  // 3. 画像を後ろから落とす。1枚が履歴2〜3ターンぶんに相当する。
  let droppedImages = 0;
  const withImages = assemble();
  for (let index = withImages.length - 1; index >= 0 && !fits(); index--) {
    const message = withImages[index];
    while (message.images?.length && !fits()) {
      message.images.pop();
      droppedImages++;
    }
    if (message.images && !message.images.length) delete message.images;
  }

  // 4. 最終手段。最後の入力を末尾優先で切る（先頭の指示文より実入力を残す）。
  // ここまで来たら上流の設計が破綻しているので、下の WARN で必ず気付けるようにする。
  let truncatedInput = false;
  if (anchor && !fits() && anchor.content) {
    truncatedInput = true;
    let low = 0;
    let high = anchor.content.length;
    const original = anchor.content;
    while (low < high) {
      const keep = Math.ceil((low + high) / 2);
      anchor.content = original.slice(-keep);
      if (fits()) low = keep;
      else high = keep - 1;
    }
    anchor.content = original.slice(-low);
  }

  const fitted = assemble();
  const trim: OllamaTrimReport = {
    droppedTurns: middleCount - middle.length,
    groundingShrunk,
    droppedImages,
    truncatedInput,
    estimatedBefore,
    estimatedAfter: estimateMessagesTokens(fitted),
  };
  console.warn(
    `[WARN][OLLAMA_BUDGET] prompt trimmed to fit: budget=${budget} estimated=${trim.estimatedBefore}->${trim.estimatedAfter} droppedTurns=${trim.droppedTurns} groundingShrunk=${trim.groundingShrunk} droppedImages=${trim.droppedImages} truncatedInput=${trim.truncatedInput}`,
  );
  return { messages: fitted, trim };
}

/** Google Type enum (`OBJECT`) を Ollama が受けるJSON Schema (`object`) に直す。 */
export function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "propertyOrdering") continue;
    if (key === "type" && typeof item === "string") {
      output[key] = item.toLowerCase();
    } else {
      output[key] = normalizeJsonSchema(item);
    }
  }
  return output;
}

function functionSchema(params: any): { name: string; schema: unknown } | undefined {
  const declarations = (params.config?.tools ?? []).flatMap(
    (tool: any) => tool?.functionDeclarations ?? [],
  );
  const declaration = declarations[0];
  if (!declaration?.name || !declaration?.parameters) return undefined;
  return {
    name: declaration.name,
    schema: normalizeJsonSchema(declaration.parameters),
  };
}

function ollamaBaseUrl(): string {
  const configured = process.env.OLLAMA_BASE_URL?.trim();
  if (!configured) throw new Error("OLLAMA_BASE_URL is not configured");
  return configured.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function generateOllamaContent(params: any): Promise<any> {
  const raw = toOllamaMessages(params);
  const fn = functionSchema(params);
  if (fn) {
    raw.unshift({
      role: "system",
      content: `Return only the arguments for the ${fn.name} function as JSON matching the provided schema.`,
    });
  }

  const schema = fn?.schema ??
    (params.config?.responseMimeType === "application/json"
      ? normalizeJsonSchema(params.config?.responseSchema ?? { type: "object" })
      : undefined);
  const config = params.config ?? {};

  // 出力枠は必ず確保する。num_predict を省くと Ollama 既定の -1（＝残りコンテキストまで）
  // になり、プロンプトが num_ctx を埋めた瞬間に生成余地が数トークンになる。
  const numCtx = ollamaTextContextLength();
  const numPredict = Math.max(
    typeof config.maxOutputTokens === "number"
      ? config.maxOutputTokens
      : OLLAMA_DEFAULT_OUTPUT_TOKENS,
    OLLAMA_MIN_OUTPUT_TOKENS,
  );
  const { messages, trim } = fitOllamaMessages(raw, {
    budget: ollamaPromptBudget({ numCtx, outputTokens: numPredict }),
  });

  const response = await fetch(`${ollamaBaseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model,
      messages,
      stream: false,
      think: false,
      ...(schema ? { format: schema } : {}),
      options: {
        num_ctx: numCtx,
        num_predict: numPredict,
        ...(typeof config.temperature === "number" ? { temperature: config.temperature } : {}),
        ...(typeof config.topP === "number" ? { top_p: config.topP } : {}),
        ...(typeof config.topK === "number" ? { top_k: config.topK } : {}),
        ...(Array.isArray(config.stopSequences) ? { stop: config.stopSequences } : {}),
      },
    }),
    signal: AbortSignal.timeout(
      Number(process.env.OLLAMA_TEXT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    ),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`Ollama HTTP ${response.status}: ${detail}`, {
      cause: { status: response.status },
    });
  }
  const data = (await response.json()) as OllamaChatResponse;
  const promptTokens = data.prompt_eval_count ?? 0;

  // 予算計算が破綻した＝プロンプトが num_ctx を埋めた。この応答は生成余地が無いので
  // 投稿させてはいけない。見積もりが甘かった証拠なので ERROR で残す。
  if (promptTokens >= numCtx - 64) {
    console.error(
      `[ERROR][OLLAMA_BUDGET] prompt filled the context window: promptTokens=${promptTokens} numCtx=${numCtx} estimated=${trim.estimatedAfter} model=${params.model}`,
    );
    throw new OllamaContextOverflowError(promptTokens, numCtx);
  }

  // 見積もりの較正用。比が 1.0 を超え続けるようなら ollamaBudget.ts の係数を上げる。
  // ここから自動でフィードバックはしない（モデル差し替え時に暴れるため）。
  if (promptTokens > 0) {
    console.log(
      `[INFO][OLLAMA_BUDGET] estimated=${trim.estimatedAfter} actual=${promptTokens} ratio=${(promptTokens / Math.max(1, trim.estimatedAfter)).toFixed(2)} numCtx=${numCtx} numPredict=${numPredict}`,
    );
  }

  const truncated = data.done_reason === "length";
  if (truncated) {
    console.warn(
      `[WARN][OLLAMA_BUDGET] generation hit num_predict: outputTokens=${data.eval_count ?? 0} numPredict=${numPredict} model=${params.model}`,
    );
  }

  const text = (data.message?.content ?? "").trim();
  let functionCalls: Array<{ name: string; args: unknown }> | undefined;
  if (fn) {
    try {
      functionCalls = [{ name: fn.name, args: JSON.parse(text || "{}") }];
    } catch (error) {
      throw new Error(`Ollama function JSON parse failed for ${fn.name}`, { cause: error });
    }
  }
  return {
    text,
    ...(functionCalls ? { functionCalls } : {}),
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: data.eval_count ?? 0,
      totalTokenCount: promptTokens + (data.eval_count ?? 0),
    },
    ollamaMetadata: {
      model: data.model ?? params.model,
      totalDurationNs: data.total_duration ?? 0,
      truncated,
      promptTokens,
      contextLimit: numCtx,
      outputLimit: numPredict,
      trimmed: trim,
    },
  };
}

/**
 * 生成の唯一の出口。クラウド／ローカルの呼び出し回数をここで数える。
 *
 * 呼び出し側（util.ts の再試行ラッパ、conversation、routedGeneration、grounding の
 * planner と Gemini 調査）で個別に数えると、経路が増えるたびに数え漏れと二重計上が
 * 起きる。実際、移行直後は grounding の Gemini 呼び出しが誰にも数えられていなかった。
 */
export async function generateContentForProvider(
  provider: AiProvider,
  params: any,
): Promise<any> {
  try {
    const response =
      provider === "ollama"
        ? await generateOllamaContent(params)
        : await gemini.models.generateContent(params);
    reportAiCallAsync(provider, "ok");
    return response;
  } catch (error) {
    reportAiCallAsync(provider, "error");
    throw error;
  }
}
