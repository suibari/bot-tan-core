/**
 * 絵文字の生成。docs/emoji-generation.md。
 *
 * 1回の依頼で1枚描く。30〜45秒（ComfyUI の起動が乗ると倍）かかるので、受け付けたらジョブとして DB に置き、
 * ワーカーが1枚ずつ描く。依頼した人は画面を離れてよく、結果は絵文字の生成画面で確認する。
 *
 * GPU（5070 Ti）は bot の Ollama と共有している。MOSS の速度は落とせないので VRAM の上限は
 * 設けず、OOM で Ollama が一部 CPU へ逃げたら GPU 機の ollama-recovery が載せ直す前提にする。
 * ワーカーの役目は、復旧を邪魔しないこと（混在中は描かず、ComfyUI を降ろしておく）と、
 * 描き終えたらすぐ降ろして VRAM と RAM を返すこと。
 */
import {
  db,
  nagiEmojiGenerations,
  readHeartbeats,
} from "@bsky-affirmative-bot/database";
import { ollamaNativeUrl } from "@bsky-affirmative-bot/shared-configs";
import { and, asc, count, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { config } from "../config.js";
import { ApiError } from "../middleware/errors.js";
import {
  EMOJI_CANDIDATES,
  EMOJI_CONFLICT_THRESHOLD,
  EMOJI_STYLE_COUNT,
  EMOJI_PLAN_SCHEMA,
  buildEmojiImageRequest,
  characterDescriptions,
  initialChromaKey,
  normalizeEmojiPlan,
  otherChromaKey,
  parseEmojiGenerationInput,
  planPrompt,
  type ChromaKey,
  type EmojiAspect,
  type EmojiOutfit,
  type EmojiPlan,
} from "./emojiGenerationPrompt.js";
import {
  TransientModerationError,
  evaluateModerationInput,
  moderationEnabled,
} from "./moderation/index.js";

/** 候補を残す期間。登録されなかった下書きはここで消える（登録した絵文字は PDS にある）。 */
const RETENTION_MS = 24 * 60 * 60_000;
/** 受付時に見せる目安。1枚 30〜45秒（ComfyUI の起動が乗ると +30秒）。 */
const SECONDS_PER_CANDIDATE = 45;
const SIDECAR_TIMEOUT_MS = 300_000;

export type EmojiCandidate = {
  /** 透過 PNG の base64。 */
  image: string;
  width: number;
  height: number;
  key: ChromaKey;
  conflict: number;
};

type GenerationRow = typeof nagiEmojiGenerations.$inferSelect;

export type EmojiGenerationView = {
  id: string;
  prompt: string;
  /** 絵文字に書く文字（gemma の解釈）。 */
  lettering?: string;
  /** 登録名と説明の案（gemma）。クライアントはこのまま登録する。 */
  name: string;
  description: string;
  aspect: EmojiAspect;
  state: GenerationRow["state"];
  /** queued のときだけ。自分より前にあるジョブの数（0 なら次）。 */
  queuePosition?: number;
  candidates: Array<{ image: string; width: number; height: number }>;
  total: number;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  expiresAt: string;
};

const candidatesOf = (row: GenerationRow) => (row.candidates ?? []) as EmojiCandidate[];

function generationView(row: GenerationRow, queuePosition?: number): EmojiGenerationView {
  return {
    id: row.id,
    prompt: row.prompt,
    ...(row.lettering ? { lettering: row.lettering } : {}),
    name: row.name,
    description: row.description,
    aspect: row.aspect as EmojiAspect,
    state: row.state,
    ...(row.state === "queued" && queuePosition !== undefined ? { queuePosition } : {}),
    candidates: candidatesOf(row).map(({ image, width, height }) => ({
      image: `data:image/png;base64,${image}`,
      width,
      height,
    })),
    total: EMOJI_CANDIDATES,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
    expiresAt: row.expiresAt.toISOString(),
  };
}

const activeStates = ["queued", "running"] as const;

async function activeCount(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(nagiEmojiGenerations)
    .where(inArray(nagiEmojiGenerations.state, [...activeStates]));
  return Number(row?.value ?? 0);
}

/** 自分より前にある未完了ジョブの数。running は常に前にいる。 */
async function queuePositionOf(row: GenerationRow): Promise<number> {
  const [ahead] = await db
    .select({ value: count() })
    .from(nagiEmojiGenerations)
    .where(
      and(
        inArray(nagiEmojiGenerations.state, [...activeStates]),
        lt(nagiEmojiGenerations.createdAt, row.createdAt),
      ),
    );
  return Number(ahead?.value ?? 0);
}

/** GPU 機の ollama-recovery が「連続失敗で自動回復停止」にしていたら、新しい生成は受けない。 */
export function recoveryBlocked(detail: Record<string, unknown> | undefined): boolean {
  return detail?.recovery === "blocked";
}

async function planEmoji(prompt: string): Promise<EmojiPlan> {
  let response: Response;
  try {
    response = await fetch(`${ollamaNativeUrl(config.ollamaUrl)}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.translationModel,
        messages: [{ role: "user", content: planPrompt(prompt) }],
        stream: false,
        think: false,
        format: EMOJI_PLAN_SCHEMA,
        // num_ctx は送らない（サーバの OLLAMA_CONTEXT_LENGTH が唯一の源）。
        options: { num_predict: 300, temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new ApiError(503, "upstream_unavailable", "Prompt planning is unavailable");
  }
  if (!response.ok) throw new ApiError(503, "upstream_unavailable", "Prompt planning is unavailable");
  const data = (await response.json().catch(() => undefined)) as
    | { message?: { content?: unknown } }
    | undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data?.message?.content ?? ""));
  } catch {
    parsed = undefined;
  }
  const plan = normalizeEmojiPlan(parsed, prompt);
  if (!plan) throw new ApiError(503, "upstream_unavailable", "Prompt planning returned nothing");
  return plan;
}

export async function createEmojiGeneration(
  did: string,
  body: unknown,
): Promise<{ generation: EmojiGenerationView; estimatedWaitSeconds: number }> {
  if (!config.imagegenUrl)
    throw new ApiError(501, "not_configured", "Emoji generation is not configured");
  const input = parseEmojiGenerationInput(body);

  const placement = (await readHeartbeats()).get("ollama-placement");
  if (recoveryBlocked(placement?.detail))
    throw new ApiError(503, "busy", "Emoji generation is paused");
  if ((await activeCount()) >= config.emojiGenerationQueueLimit)
    throw new ApiError(503, "busy", "Emoji generation queue is full");

  // 生成前に入力を判定する。登録された絵文字は取り込み時のモデレーションでも画像ごと判定される。
  if (moderationEnabled()) {
    try {
      const evaluation = await evaluateModerationInput({ texts: [input.prompt], imageUrls: [] });
      if (evaluation.decision !== "allow")
        throw new ApiError(400, "inappropriate", "This text cannot be used for emoji generation");
    } catch (error) {
      if (error instanceof TransientModerationError)
        throw new ApiError(503, "upstream_unavailable", "Moderation is unavailable");
      throw error;
    }
  }

  // プロンプトの解釈（英訳と、書く文字の取り出し）は受付時に済ませる。ワーカーの時点では
  // ComfyUI が VRAM を使っていることがあり、そこへ Ollama のリクエストを足すと OOM の引き金になる（2026-10-28）。
  const plan = await planEmoji(input.prompt);

  const [row] = await db
    .insert(nagiEmojiGenerations)
    .values({
      did,
      prompt: input.prompt,
      name: plan.name,
      description: plan.description,
      subject: plan.subject,
      lettering: plan.lettering ?? null,
      aspect: plan.aspect,
      outfit: plan.outfit,
      expiresAt: new Date(Date.now() + RETENTION_MS),
    })
    // 未完了は1人1件（部分一意索引）。重なったら何も入らない
    .onConflictDoNothing()
    .returning();
  if (!row)
    throw new ApiError(409, "already_active", "An emoji generation is already in progress");

  const position = await queuePositionOf(row);
  return {
    generation: generationView(row, position),
    estimatedWaitSeconds: (position + 1) * EMOJI_CANDIDATES * SECONDS_PER_CANDIDATE,
  };
}

export async function getEmojiGenerations(
  did: string,
): Promise<{ generations: EmojiGenerationView[] }> {
  const rows = await db
    .select()
    .from(nagiEmojiGenerations)
    .where(
      and(
        eq(nagiEmojiGenerations.did, did),
        gt(nagiEmojiGenerations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(nagiEmojiGenerations.createdAt))
    .limit(30);
  const generations = await Promise.all(
    rows.map(async (row) =>
      generationView(row, row.state === "queued" ? await queuePositionOf(row) : undefined),
    ),
  );
  return { generations };
}

// ---------------------------------------------------------------------------
// ワーカー
// ---------------------------------------------------------------------------

export type SidecarResult = {
  image: string;
  width: number;
  height: number;
  key: ChromaKey;
  conflict: number;
  empty: boolean;
};

export interface EmojiWorkerDeps {
  /** bot の Ollama が全層 GPU に載っているか。 */
  ollamaReady(): Promise<boolean>;
  generate(request: ReturnType<typeof buildEmojiImageRequest>, key: ChromaKey): Promise<SidecarResult>;
  unload(): Promise<void>;
  now(): number;
}

/**
 * /api/ps から「全モデルが GPU に載っているか」を判定する。
 * 1つも載っていないときも false。OOM で降ろされた直後で、次のリクエストで読み直される。
 * そこへ ComfyUI を立ち上げると、また一部しか載らない（2026-10-28 の 10:42）。
 */
export function ollamaFullyOnGpu(ps: unknown): boolean {
  const models = (ps as { models?: Array<{ size?: unknown; size_vram?: unknown }> })?.models;
  if (!Array.isArray(models) || models.length === 0) return false;
  return models.every(
    (m) => typeof m.size === "number" && typeof m.size_vram === "number" && m.size_vram >= m.size,
  );
}

/**
 * 1枚描く。cutout の conflict がしきい値を超えたら、もう一方のキー色で1回だけ撮り直す。
 * 撮り直しても下がらなければ、低い方を残す（どちらも駄目でも、選ぶのは本人）。
 */
export async function drawCandidate(
  deps: Pick<EmojiWorkerDeps, "generate">,
  params: { plan: EmojiPlan; style: number; prompt: string },
): Promise<EmojiCandidate> {
  const characters = characterDescriptions(`${params.prompt} ${params.plan.subject}`, params.plan.outfit);
  const draw = (key: ChromaKey) =>
    deps.generate(buildEmojiImageRequest({ plan: params.plan, style: params.style, key, characters }), key);
  const firstKey = initialChromaKey(params.prompt);
  let best = await draw(firstKey);
  if (best.empty || best.conflict > EMOJI_CONFLICT_THRESHOLD) {
    const retry = await draw(otherChromaKey(firstKey));
    if (best.empty || (!retry.empty && retry.conflict < best.conflict)) best = retry;
  }
  if (best.empty) throw new Error("cutout removed the whole image");
  return { image: best.image, width: best.width, height: best.height, key: best.key, conflict: best.conflict };
}

async function sidecarGenerate(
  request: ReturnType<typeof buildEmojiImageRequest>,
  key: ChromaKey,
): Promise<SidecarResult> {
  const response = await fetch(`${config.imagegenUrl}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      engine: "moss",
      prompt: request.prompt,
      negative_prompt: request.negativePrompt,
      width: request.width,
      height: request.height,
      checkpoint: request.checkpoint,
      lora: request.lora,
      fmt: "png",
      cutout: { type: "chroma", max_side: 128 },
    }),
    signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`imagegen HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = (await response.json()) as {
    image_b64?: string;
    width?: number;
    height?: number;
    meta?: { cutout?: { conflict?: number; empty?: boolean }; ollamaEvicted?: unknown };
  };
  const evicted = data.meta?.ollamaEvicted;
  if (Array.isArray(evicted) && evicted.length > 0)
    console.warn("[WARN][EMOJI_GEN] 絵文字の生成で Ollama が追い出された:", evicted);
  if (!data.image_b64 || typeof data.meta?.cutout?.conflict !== "number")
    throw new Error("imagegen returned no cutout");
  return {
    image: data.image_b64,
    width: data.width ?? 128,
    height: data.height ?? 128,
    key,
    conflict: data.meta.cutout.conflict,
    empty: data.meta.cutout.empty === true,
  };
}

/** 本番の依存。scripts からサイドカーを直接試すときにも使う。 */
export const emojiWorkerDeps: EmojiWorkerDeps = {
  async ollamaReady() {
    try {
      const response = await fetch(`${ollamaNativeUrl(config.ollamaUrl)}/api/ps`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok && ollamaFullyOnGpu(await response.json());
    } catch {
      return false;
    }
  },
  generate: sidecarGenerate,
  async unload() {
    const response = await fetch(`${config.imagegenUrl}/unload`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`imagegen /unload HTTP ${response.status}`);
  },
  now: Date.now,
};

/** 直近1時間に描いた枚数を数える窓。全体の安全弁で、1人あたりの制限ではない。 */
export class HourlyWindow {
  #stamps: number[] = [];
  constructor(readonly limit: number) {}
  full(now: number): boolean {
    this.#stamps = this.#stamps.filter((t) => now - t < 60 * 60_000);
    return this.#stamps.length >= this.limit;
  }
  add(now: number) {
    this.#stamps.push(now);
  }
}

const hourly = new HourlyWindow(config.emojiGenerationHourlyLimit);
/** このワーカーが ComfyUI を立ち上げたまま降ろしていないか。 */
let sidecarLoaded = false;
let pausedLogged = false;

async function releaseSidecar(deps: EmojiWorkerDeps) {
  if (!sidecarLoaded) return;
  try {
    await deps.unload();
    sidecarLoaded = false;
  } catch (error) {
    console.error("[ERROR][EMOJI_GEN] サイドカーを降ろせなかった:", error);
  }
}

/**
 * 描き終えたら（描けなかったときも）、その人の前の結果を消す。画面は最新の1件だけを見せ、
 * 描き直している間は前の絵の上にスピナーを出すので、新しい結果が出た時点で前のものは要らない。
 */
async function finish(row: GenerationRow, error?: string) {
  const failed = candidatesOf(row).length === 0;
  await db.transaction(async (tx) => {
    await tx
      .update(nagiEmojiGenerations)
      .set({ state: failed ? "failed" : "done", finishedAt: new Date(), ...(error ? { error } : {}) })
      .where(eq(nagiEmojiGenerations.id, row.id));
    await tx
      .delete(nagiEmojiGenerations)
      .where(
        and(
          eq(nagiEmojiGenerations.did, row.did),
          ne(nagiEmojiGenerations.id, row.id),
          inArray(nagiEmojiGenerations.state, ["done", "failed"]),
        ),
      );
  });
}

/**
 * 1回の tick で1枚だけ描く。途中経過は DB に積むので、再起動しても続きから描ける。
 * 生成中に Ollama が混在になったら、次の tick で止まる。
 */
export async function emojiGenerationTick(deps: EmojiWorkerDeps = emojiWorkerDeps): Promise<void> {
  if (!config.imagegenUrl) return;
  await db
    .delete(nagiEmojiGenerations)
    .where(lt(nagiEmojiGenerations.expiresAt, new Date(deps.now())));

  const [row] = await db
    .select()
    .from(nagiEmojiGenerations)
    .where(inArray(nagiEmojiGenerations.state, [...activeStates]))
    // running を先に（続きを描く）。あとは古い順
    .orderBy(sql`${nagiEmojiGenerations.state} = 'running' desc`, asc(nagiEmojiGenerations.createdAt))
    .limit(1);
  if (!row) {
    // 待ちが無くなったらすぐ返す。15分のアイドル解放を待つと、その間 VRAM と RAM を掴み続ける
    await releaseSidecar(deps);
    return;
  }

  const now = deps.now();
  const ready = !hourly.full(now) && (await deps.ollamaReady());
  if (!ready) {
    // 混在中に ComfyUI が VRAM を持っていると、ollama-recovery が載せ直せない
    await releaseSidecar(deps);
    if (!pausedLogged)
      console.warn("[WARN][EMOJI_GEN] Ollama が全層 GPU に無い、または1時間の上限に達したので待つ");
    pausedLogged = true;
    return;
  }
  pausedLogged = false;

  if (row.state === "queued")
    await db
      .update(nagiEmojiGenerations)
      .set({ state: "running", startedAt: new Date(now) })
      .where(and(eq(nagiEmojiGenerations.id, row.id), eq(nagiEmojiGenerations.state, "queued")));

  const done = candidatesOf(row);
  try {
    sidecarLoaded = true;
    hourly.add(now);
    const candidate = await drawCandidate(deps, {
      plan: {
        name: row.name,
        description: row.description,
        subject: row.subject,
        ...(row.lettering ? { lettering: row.lettering } : {}),
        aspect: row.aspect as EmojiAspect,
        outfit: row.outfit as EmojiOutfit,
      },
      // 頼み直したときに同じ絵にならないよう、スタイルは毎回くじで選ぶ
      style: Math.floor(Math.random() * EMOJI_STYLE_COUNT),
      prompt: row.prompt,
    });
    const next = [...done, candidate];
    await db
      .update(nagiEmojiGenerations)
      .set({ candidates: next })
      .where(eq(nagiEmojiGenerations.id, row.id));
    if (next.length >= EMOJI_CANDIDATES) await finish({ ...row, candidates: next });
  } catch (error) {
    // サイドカーは同時実行1でリトライも悪化させるだけ（imageGenClient と同じ方針）。
    // 描けた分があればそれで終わり、無ければ失敗にする。
    console.error("[ERROR][EMOJI_GEN] 生成に失敗した:", error);
    await finish(row, "generation_failed");
  }
}
