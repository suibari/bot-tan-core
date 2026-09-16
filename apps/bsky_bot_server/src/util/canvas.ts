import { createCanvas, loadImage, GlobalFonts, SKRSContext2D as CanvasRenderingContext2D } from '@napi-rs/canvas';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

// ワークスペースルートを探すヘルパー
function findWorkspaceRoot(startPath: string): string {
  let curr = path.resolve(startPath);
  while (curr !== path.parse(curr).root) {
    if (fs.existsSync(path.join(curr, 'pnpm-workspace.yaml'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return process.cwd(); // 見つからなければcwd
}

const workspaceRoot = findWorkspaceRoot(process.cwd());

// フォント設定
const FONT_PATH = path.resolve(workspaceRoot, 'fonts/JK-Maru-Gothic-M.otf');
GlobalFonts.registerFromPath(FONT_PATH, 'JK-Maru-Gothic');

/**
 * テキストと背景画像を合成し、PNGバッファとして返す
 */
export async function textToImageBufferWithBackground(
  text: string,
  backgroundPath: string = './img/bot-tan.png'
): Promise<Buffer> {
  const resolvedPath = path.resolve(workspaceRoot, backgroundPath.replace(/^\.\//, ''));
  const bgImage = await loadImage(pathToFileURL(resolvedPath));
  const originalWidth = bgImage.width;
  const originalHeight = bgImage.height;

  const scaleFactor = 0.5;
  const width = Math.floor(originalWidth * scaleFactor);
  const height = Math.floor(originalHeight * scaleFactor);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 背景描画
  ctx.drawImage(bgImage, 0, 0, width, height);

  // テキスト描画設定
  const fontSize = 16;
  const margin = 40;
  const lineHeight = fontSize * 1.25;

  ctx.fillStyle = 'black';
  ctx.font = `${fontSize}px JK-Maru-Gothic`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const maxWidth = width - margin * 2;
  const lines = wrapLinesWithNewlines(ctx, text, maxWidth);

  let y = margin;
  for (const line of lines) {
    await drawTextWithLocalEmoji(ctx, line.trim(), margin, y, fontSize);
    y += lineHeight;
  }

  const buffer = canvas.toBuffer('image/png');

  if (process.env.NODE_ENV === 'development') {
    const outputPath = path.resolve(workspaceRoot, 'img/output.png');
    fs.writeFileSync(outputPath, buffer);
    console.log(`Image saved for debugging: ${outputPath}`);
  }

  return buffer;
}

const DECODE_TIMEOUT_MS = 10_000;
// @napi-rs/canvas の toBuffer は 0..100 を受け取る。
const JPEG_QUALITY_STEPS = [92, 85, 78, 70, 62, 54, 46];

/** 生成画像が取りうる形式（PNG / JPEG / WebP。botSignature.ts の encode を参照）か。 */
function isGeneratedImageFormat(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  return buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP';
}

/** 生成画像の右下にあるサイン（botSignature.ts: 高さの12%＋余白）の帯。パネルで隠さない。 */
const SIGNATURE_BAND_RATIO = 0.15;
const PANEL_MAX_HEIGHT_RATIO = 0.72;

/**
 * 生成した絵を背景に、半透明のパネルへ本文を描く。
 *
 * 絵の主題（人物の顔）は上側に来やすいので、パネルは下寄せにして上を見せる。
 * 本文が長い日はパネルが伸びるより先にフォントを縮める。
 *
 * **loadImage にはタイムアウトを付ける。** @napi-rs/canvas は壊れた入力で reject せず
 * 固まる（AGENTS.md「画像の実効解像度」）。背景が読めなければ呼び出し側が固定画像へ戻す。
 */
export async function textToImageBufferWithGeneratedBackground(
  text: string,
  background: Buffer,
  maxBytes: number,
): Promise<{ data: Buffer; mimeType: string }> {
  // タイムアウトだけでは足りない。固まった loadImage はイベントループを掴まないので、
  // タイマーを unref していると reject される前にプロセスが終わりうる。形式は実バイトで先に弾く。
  if (!isGeneratedImageFormat(background)) throw new Error("unrecognised background image signature");
  const bgImage = await Promise.race([
    loadImage(background),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`background loadImage timed out after ${DECODE_TIMEOUT_MS}ms`)), DECODE_TIMEOUT_MS).unref(),
    ),
  ]);
  const width = bgImage.width;
  const height = bgImage.height;
  if (!width || !height) throw new Error("background image has no size");

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bgImage, 0, 0, width, height);

  const shortSide = Math.min(width, height);
  const margin = Math.round(shortSide * 0.04);
  const padding = Math.round(shortSide * 0.035);
  const signatureBand = Math.round(height * SIGNATURE_BAND_RATIO);
  const panelWidth = width - margin * 2;
  const maxTextWidth = panelWidth - padding * 2;
  const maxPanelHeight = Math.min(height * PANEL_MAX_HEIGHT_RATIO, height - signatureBand - margin * 2);

  let fontSize = Math.max(12, Math.round(width / 34));
  let lines: string[] = [];
  let lineHeight = 0;
  for (; fontSize >= 12; fontSize--) {
    ctx.font = `${fontSize}px JK-Maru-Gothic`;
    // 折り返しは行全体の幅で測るが、描画は1文字ずつ送る（drawTextWithLocalEmoji）。
    // 送りの合計が測った幅より伸びて行末がパネルからはみ出るので、1文字ぶん詰めて測る。
    lines = wrapLinesWithNewlines(ctx, text, maxTextWidth - fontSize);
    lineHeight = Math.round(fontSize * 1.45);
    if (lines.length * lineHeight + padding * 2 <= maxPanelHeight) break;
  }
  fontSize = Math.max(12, fontSize);

  const panelHeight = Math.min(lines.length * lineHeight + padding * 2, height - margin * 2);
  const panelY = Math.max(margin, height - signatureBand - margin - panelHeight);

  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
  ctx.shadowBlur = Math.round(shortSide * 0.02);
  ctx.beginPath();
  ctx.roundRect(margin, panelY, panelWidth, panelHeight, Math.round(shortSide * 0.03));
  ctx.fill();
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let y = panelY + padding;
  for (const line of lines) {
    // 見出し（【ラッキーフード】/ [Lucky Food]）だけ色を変えて、項目の切れ目を拾いやすくする。
    ctx.fillStyle = /^\s*[【\[]/.test(line) ? '#3b6db3' : '#2e2a38';
    await drawTextWithLocalEmoji(ctx, line.trim(), margin + padding, y, fontSize);
    y += lineHeight;
  }

  const png = canvas.toBuffer('image/png');
  let encoded = { data: png, mimeType: 'image/png' };
  if (png.byteLength > maxBytes) {
    // 絵を背景にすると PNG は1MBの blob 上限を超えやすい。寸法は保って JPEG に落とす。
    for (const quality of JPEG_QUALITY_STEPS) {
      encoded = { data: canvas.toBuffer('image/jpeg', quality), mimeType: 'image/jpeg' };
      if (encoded.data.byteLength <= maxBytes) break;
    }
  }

  if (process.env.NODE_ENV === 'development') {
    const outputPath = path.resolve(workspaceRoot, `img/output.${encoded.mimeType === 'image/png' ? 'png' : 'jpg'}`);
    fs.writeFileSync(outputPath, encoded.data);
    console.log(`Image saved for debugging: ${outputPath}`);
  }

  return encoded;
}

/**
 * 日本語かどうかを判定するユーティリティ
 */
function isJapanese(text: string): boolean {
  return /[一-龯ぁ-んァ-ン]/.test(text);
}

/**
 * 折り返し処理：1行の最大幅に基づいて日本語・英語のテキストを適切に分割
 */
function wrapLinesWithNewlines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  paragraphs.forEach(paragraph => {
    let currentLine = paragraph[0] || '';

    if (isJapanese(paragraph)) {
      for (let i = 1; i < paragraph.length; i++) {
        const testLine = currentLine + paragraph[i];
        const { width } = ctx.measureText(testLine);
        if (width < maxWidth) {
          currentLine = testLine;
        } else {
          lines.push(currentLine);
          currentLine = paragraph[i];
        }
      }
    } else {
      const words = paragraph.split(' ');
      currentLine = words[0] || '';
      for (let i = 1; i < words.length; i++) {
        const testLine = currentLine + ' ' + words[i];
        const { width } = ctx.measureText(testLine);
        if (width < maxWidth) {
          currentLine = testLine;
        } else {
          lines.push(currentLine);
          currentLine = words[i];
        }
      }
    }

    lines.push(currentLine);
  });

  return lines;
}

// 絵文字判定
async function drawTextWithLocalEmoji(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number
) {
  let cursorX = x;
  const graphemes = Array.from(text);

  for (const char of graphemes) {
    if (isEmoji(char)) {
      const imgPath = getTwemojiImagePath(char);
      if (fs.existsSync(imgPath)) {
        const img = await loadImage(pathToFileURL(imgPath));
        ctx.drawImage(img, cursorX, y, fontSize, fontSize);
        cursorX += fontSize;
        continue;
      }
    }

    ctx.font = `${fontSize}px JK-Maru-Gothic`;
    ctx.fillText(char, cursorX, y);
    cursorX += ctx.measureText(char).width;
  }
}

function isEmoji(char: string): boolean {
  const code = char.codePointAt(0);
  return !!code && (
    (code >= 0x1F300 && code <= 0x1FAFF) || // 絵文字・記号
    (code >= 0x2600 && code <= 0x26FF) ||   // その他記号
    (code >= 0x2700 && code <= 0x27BF) ||   // Dingbats
    (code >= 0x1F1E6 && code <= 0x1F1FF)    // 国旗（地域インジケーター）
  );
}

function getTwemojiImagePath(char: string): string {
  const codePoints = Array.from(char).map(c => c.codePointAt(0)!.toString(16));
  const filename = codePoints.join('-') + '.png';
  const imagePath = path.join(process.cwd(), 'src', 'util', 'twemoji', '72x72', filename);
  return fs.existsSync(imagePath) ? imagePath : '';
}
