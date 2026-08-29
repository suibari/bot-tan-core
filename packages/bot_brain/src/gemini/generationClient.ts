import {
  OLLAMA_TEXT_CONTEXT_LENGTH,
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
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
};

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
  const messages = toOllamaMessages(params);
  const fn = functionSchema(params);
  if (fn) {
    messages.unshift({
      role: "system",
      content: `Return only the arguments for the ${fn.name} function as JSON matching the provided schema.`,
    });
  }

  const schema = fn?.schema ??
    (params.config?.responseMimeType === "application/json"
      ? normalizeJsonSchema(params.config?.responseSchema ?? { type: "object" })
      : undefined);
  const config = params.config ?? {};
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
        num_ctx: OLLAMA_TEXT_CONTEXT_LENGTH,
        ...(typeof config.temperature === "number" ? { temperature: config.temperature } : {}),
        ...(typeof config.topP === "number" ? { top_p: config.topP } : {}),
        ...(typeof config.topK === "number" ? { top_k: config.topK } : {}),
        ...(typeof config.maxOutputTokens === "number"
          ? { num_predict: config.maxOutputTokens }
          : {}),
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
      promptTokenCount: data.prompt_eval_count ?? 0,
      candidatesTokenCount: data.eval_count ?? 0,
      totalTokenCount: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    },
    ollamaMetadata: {
      model: data.model ?? params.model,
      totalDurationNs: data.total_duration ?? 0,
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
