/**
 * GPU機の画像生成サイドカーを叩く。
 *
 * サイドカーは bot-tan-imagegen リポジトリの別サービス（モノレポには入れていない）。
 * Python + torch + 7GB のチェックポイントを pnpm/TS のモノレポに持ち込む理由が無く、
 * そもそも bot は Raspberry Pi、生成は GPU 機で別マシンだから。
 * Ollama がすでに「別マシンの HTTP サービス」として扱われているのと同じ形。
 */

export type ImageGenRequest = {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  regions?: Array<{ prompt: string; x0: number; x1: number }>;
  loras?: Array<[string, number]>;
  /** 配信先の blob 上限。呼び出し側が知っている値をそのまま渡す。 */
  maxBytes?: number;
};

export type GeneratedImage = {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
};

/** IMAGEGEN_BASE_URL が無ければ機能そのものを止める（isOllamaConfigured と同じ作法）。 */
export const isImageGenConfigured = (): boolean => Boolean(process.env.IMAGEGEN_BASE_URL);

/**
 * **リトライしない。**
 *
 * サイドカーは同時実行1で直列化されており、失敗の主因は
 *   (a) VRAM が足りない  (b) すでに生成が走っていて詰まっている
 * のどちらか。どちらもリトライで悪化する（(a) は次も足りず、(b) は待ち行列を伸ばして
 * 同じ GPU に載っている Ollama のテキスト生成まで巻き込む）。1回叩いて駄目なら諦める。
 * 絵は1日1枚の飾りで、無くても bot は動く。
 */
export async function requestImage(request: ImageGenRequest): Promise<GeneratedImage | null> {
  const baseUrl = process.env.IMAGEGEN_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) return null;

  // 領域プロンプトは UNet を1ステップに4回呼ぶので通常の1.6〜2倍かかる。
  // 実測は1枚 8〜26秒だが、コールドスタート（チェックポイント読み込み）が7秒ほど乗る。
  const timeoutMs = Number(process.env.IMAGEGEN_TIMEOUT_MS ?? 180_000);

  const body = {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt,
    width: request.width,
    height: request.height,
    ...(request.regions?.length ? { regions: request.regions, base_weight: 0.15 } : {}),
    ...(request.loras?.length ? { lora: request.loras } : {}),
    ...(request.maxBytes ? { max_bytes: request.maxBytes } : {}),
    fmt: "png" as const,
  };

  const response = await fetch(`${baseUrl}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`imagegen HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    image_b64?: string;
    mime_type?: string;
    width?: number;
    height?: number;
    meta?: Record<string, unknown>;
  };
  if (!data.image_b64) return null;

  const meta = data.meta ?? {};
  // 同じ GPU に Ollama が常駐している。追い出されていないかを毎回残す。
  // 2026-08 の障害では、スケジューラが沈黙して埋め込みが 2000 回連続で 503 を返したのに
  // Ollama は ERROR ログを1行も出さなかった。外から見ておくしかない。
  const evicted = meta.ollamaEvicted;
  if (Array.isArray(evicted) && evicted.length > 0) {
    console.warn("[WARN][IMGGEN_VRAM] 画像生成で Ollama が追い出された:", evicted);
  }
  console.log(
    `[INFO][IMGGEN] generated ${meta.encodedFormat ?? "?"} ${meta.encodedBytes ?? "?"}B ` +
      `gen=${Math.round(Number(meta.generateMs ?? 0))}ms peak=${meta.gpuUsedPeakMb ?? "?"}MiB ` +
      `regions=${meta.regions ?? 0}`,
  );

  return {
    data: Buffer.from(data.image_b64, "base64"),
    mimeType: data.mime_type ?? "image/png",
    width: data.width ?? request.width,
    height: data.height ?? request.height,
  };
}
