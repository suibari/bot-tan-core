import { readFile } from "node:fs/promises";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import type { GeneratedImage } from "./imageGenClient.js";

const SIGNATURE_URL = new URL("../../../../img/bot-tan-signature.png", import.meta.url);
const DECODE_TIMEOUT_MS = 10_000;
const SIGNATURE_OPACITY = 0.82;
// @napi-rs/canvas のネイティブ Canvas API は 0..1 ではなく 0..100 を受け取る。
const LOSSY_QUALITY_STEPS = [95, 90, 82, 74, 66, 58, 50, 42, 34, 26, 20];

let signatureImagePromise: ReturnType<typeof loadImage> | undefined;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${DECODE_TIMEOUT_MS}ms`)),
        DECODE_TIMEOUT_MS,
      ).unref(),
    ),
  ]);
}

function signatureImage() {
  signatureImagePromise ??= readFile(SIGNATURE_URL).then((data) =>
    withTimeout(loadImage(data), "signature loadImage"),
  );
  return signatureImagePromise;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (!delta) return [0, 0, lightness];

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === red ? ((green - blue) / delta) % 6
      : max === green ? (blue - red) / delta + 2
      : (red - green) / delta + 4;
  return [((hue * 60) + 360) % 360, saturation, lightness];
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [r1, g1, b1] =
    section < 1 ? [chroma, secondary, 0]
      : section < 2 ? [secondary, chroma, 0]
      : section < 3 ? [0, chroma, secondary]
      : section < 4 ? [0, secondary, chroma]
      : section < 5 ? [secondary, 0, chroma]
      : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  return {
    r: Math.round((r1 + match) * 255),
    g: Math.round((g1 + match) * 255),
    b: Math.round((b1 + match) * 255),
  };
}

/**
 * 絵の代表的な色相を残しつつ、サインを置く場所との明暗差を確保する。
 * 単純な平均色は補色同士が灰色になるため、彩度で重み付けした色相ヒストグラムを使う。
 */
export function chooseSignatureColor(
  pixels: Uint8ClampedArray,
  localLuminance: number,
): { r: number; g: number; b: number } {
  const bins = Array.from({ length: 24 }, () => ({ score: 0, r: 0, g: 0, b: 0 }));
  let fallbackR = 0;
  let fallbackG = 0;
  let fallbackB = 0;
  let fallbackWeight = 0;
  const pixelCount = pixels.length / 4;
  const step = Math.max(1, Math.floor(Math.sqrt(pixelCount / 20_000)));

  for (let pixel = 0; pixel < pixelCount; pixel += step) {
    const index = pixel * 4;
    const alpha = pixels[index + 3] / 255;
    if (alpha < 0.1) continue;
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    fallbackR += r * alpha;
    fallbackG += g * alpha;
    fallbackB += b * alpha;
    fallbackWeight += alpha;

    const [hue, saturation] = rgbToHsl(r, g, b);
    if (saturation < 0.12) continue;
    const weight = alpha * saturation;
    const bin = bins[Math.min(bins.length - 1, Math.floor(hue / 15))];
    bin.score += weight;
    bin.r += r * weight;
    bin.g += g * weight;
    bin.b += b * weight;
  }

  const dominant = bins.reduce((best, bin) => (bin.score > best.score ? bin : best));
  const weight = dominant.score || fallbackWeight || 1;
  const source = dominant.score
    ? { r: dominant.r / weight, g: dominant.g / weight, b: dominant.b / weight }
    : { r: fallbackR / weight, g: fallbackG / weight, b: fallbackB / weight };
  const [hue, saturation] = rgbToHsl(source.r, source.g, source.b);
  const signatureSaturation = dominant.score
    ? Math.min(0.78, Math.max(0.38, saturation))
    : Math.min(0.18, saturation);

  // 背景が明るければ濃く、暗ければ明るくする。色相は絵から採ったものを保つ。
  return hslToRgb(
    hue,
    signatureSaturation,
    localLuminance >= 0.5 ? 0.25 : 0.78,
  );
}

function averageLuminance(pixels: Uint8ClampedArray): number {
  let sum = 0;
  let weight = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    sum +=
      (pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722) *
      alpha;
    weight += alpha;
  }
  return weight ? sum / weight / 255 : 0.5;
}

function encode(canvas: Canvas, preferredMimeType: string, maxBytes?: number) {
  const normalizedMimeType = preferredMimeType.toLowerCase();
  if (normalizedMimeType.includes("jpeg") || normalizedMimeType.includes("jpg")) {
    for (const quality of LOSSY_QUALITY_STEPS) {
      const data = canvas.toBuffer("image/jpeg", quality);
      if (!maxBytes || data.byteLength <= maxBytes || quality === LOSSY_QUALITY_STEPS.at(-1)) {
        return { data, mimeType: "image/jpeg" };
      }
    }
  }
  if (normalizedMimeType.includes("webp")) {
    for (const quality of LOSSY_QUALITY_STEPS) {
      const data = canvas.toBuffer("image/webp", quality);
      if (!maxBytes || data.byteLength <= maxBytes || quality === LOSSY_QUALITY_STEPS.at(-1)) {
        return { data, mimeType: "image/webp" };
      }
    }
  }

  const png = canvas.toBuffer("image/png");
  if (!maxBytes || png.byteLength <= maxBytes) return { data: png, mimeType: "image/png" };

  // PNG に色を足すとサイドカーで満たした上限を少し超えることがある。寸法は変えず WebP に退避する。
  for (const quality of LOSSY_QUALITY_STEPS) {
    const data = canvas.toBuffer("image/webp", quality);
    if (data.byteLength <= maxBytes || quality === LOSSY_QUALITY_STEPS.at(-1)) {
      return { data, mimeType: "image/webp" };
    }
  }
  return { data: png, mimeType: "image/png" };
}

/** 生成画像の右下へ、絵の色相になじませた botたんのサインを重ねる。 */
export async function applyBotSignature(
  image: GeneratedImage,
  maxBytes?: number,
): Promise<GeneratedImage> {
  try {
    const [source, signature] = await Promise.all([
      withTimeout(loadImage(image.data), "generated image loadImage"),
      signatureImage(),
    ]);
    if (!source.width || !source.height || !signature.width || !signature.height) return image;

    const canvas = createCanvas(source.width, source.height);
    const context = canvas.getContext("2d");
    context.drawImage(source, 0, 0);

    const scale = Math.min(
      (source.width * 0.21) / signature.width,
      (source.height * 0.12) / signature.height,
    );
    const width = Math.max(1, Math.round(signature.width * scale));
    const height = Math.max(1, Math.round(signature.height * scale));
    const margin = Math.max(8, Math.round(Math.min(source.width, source.height) * 0.022));
    const x = Math.max(0, source.width - width - margin);
    const y = Math.max(0, source.height - height - margin);

    const localPixels = context.getImageData(x, y, width, height).data;
    const allPixels = context.getImageData(0, 0, source.width, source.height).data;
    const localLuminance = averageLuminance(localPixels);
    const color = chooseSignatureColor(allPixels, localLuminance);

    const tinted = createCanvas(width, height);
    const tintContext = tinted.getContext("2d");
    tintContext.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    tintContext.fillRect(0, 0, width, height);
    tintContext.globalCompositeOperation = "destination-in";
    tintContext.drawImage(signature, 0, 0, width, height);

    context.save();
    context.globalAlpha = SIGNATURE_OPACITY;
    context.shadowColor = localLuminance >= 0.5
      ? "rgba(255, 255, 255, 0.45)"
      : "rgba(0, 0, 0, 0.45)";
    context.shadowBlur = Math.max(1, Math.round(Math.min(source.width, source.height) * 0.003));
    context.drawImage(tinted, x, y);
    context.restore();

    const encoded = encode(canvas, image.mimeType, maxBytes);
    return {
      ...image,
      ...encoded,
      width: source.width,
      height: source.height,
    };
  } catch (error) {
    // サインの都合で絵そのものを捨てない。画像生成経路の「失敗時も投稿を続ける」契約を守る。
    console.warn("[WARN][IMGGEN] サインの合成に失敗したので生成画像をそのまま使う:", error);
    return image;
  }
}
