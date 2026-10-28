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
