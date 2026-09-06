/**
 * モデルへ送る前の画像整形。
 *
 * 実測（gemma-4-26B-A4B / IQ3_S、`/api/chat` の prompt_eval_count 差分）:
 *
 * | 入力          | 画像トークン | 小さい文字 |
 * | 512x794       | 244          | 「全肖定」「A+Pまたは一枚」    |
 * | 896x1389      | 317          | 「レヤー」「A+Proto京校」      |
 * | 2000x3100(原寸)| 317         | 「botだん」「A+Photo商店」     |
 *
 * つまり **896px 相当で頭打ち**。原寸 2.5MB の blob をそのまま送っても、モデルが見る
 * 情報量は 896px と変わらない（転送とデコードだけが重くなる）。よって縮小は純粋な
 * 軽量化であって、詳細の回復にはならない。
 *
 * 詳細を戻す唯一のレバーはタイル分割で、これは実測で効いた:
 *
 * | 送り方          | プロンプト計 | 読み取り |
 * | 全体1枚         | 303 tok      | あたま / レヤー / ちむふぉ / TPOでつっかえよ |
 * | 全体+2x3タイル  | 1,947 tok    | あほ毛 / レイヤーカット / ちょうちょ と くも / TPOでつかいわける♪ |
 *
 * タイルは既定 OFF。`AI_IMAGE_TILES` にタイル最大枚数を入れて有効化する。
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { LanguageName } from "@bsky-affirmative-bot/shared-configs";

/** 全体像の長辺。実効解像度の頭打ち（896相当）より少しだけ上に置く。 */
const WHOLE_MAX_LONG_SIDE = 1024;
/** タイル1枚の長辺。頭打ちと同じにして、1枚あたりのトークンを無駄にしない。 */
const TILE_MAX_LONG_SIDE = 896;
/** これ以下の画像は分割しても新しい画素が出てこない（全体像だけで既に等倍以上）。 */
const TILE_MIN_LONG_SIDE = 1200;
/** タイルの重なり。被写体や文字が切れ目で分断されるのを防ぐ。 */
const TILE_OVERLAP = 0.08;
/** 縮小後の JPEG 品質。文字の可読性を落とさない範囲で小さくする。 */
const JPEG_QUALITY = 0.85;
/**
 * デコードの打ち切り。
 *
 * `@napi-rs/canvas` の `loadImage` は**壊れた入力で reject せず永久に固まる**
 * （実測: `Buffer.from([1,2,3])` を渡すと settle しない）。ここを素通しすると
 * 画像1枚で返信生成が止まったままになる。下の署名判定が第一のガードで、
 * これは未知の破損パターン向けの保険。
 */
const DECODE_TIMEOUT_MS = 10_000;

/**
 * 署名で扱える形式かを見る。拡張子や Content-Type ではなく実バイトで判定する
 * （PDS の mimeType は投稿側の申告なので当てにならない）。
 */
function isDecodableImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  // PNG
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return true;
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  // GIF
  if (buffer.subarray(0, 6).toString("latin1").match(/^GIF8[79]a$/)) return true;
  // RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return true;
  // ISO-BMFF (AVIF / HEIC)
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp") return true;
  return false;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

export type PreparedImage = {
  mimeType: string;
  /** base64（data URI 前置きなし）。 */
  data: string;
  /** 全体像か、その拡大タイルか。 */
  kind: "whole" | "tile";
  /** タイルの位置（「左上」「右下」など）。全体像では未設定。 */
  position?: string;
  positionEn?: string;
};

/** タイル最大枚数の既定。実測で追加コストが 0.3 秒未満だったので既定で有効にする。 */
const DEFAULT_MAX_TILES = 4;

/**
 * タイル最大枚数。`AI_IMAGE_TILES=0` で無効化できる。
 *
 * 既定を ON にしてよい根拠（2026-09-06 実測、2000x3100 の設定資料で3回ずつ）:
 * 画像整形 104ms → 119ms、生成 1,456〜1,553ms → 1,555〜1,853ms、
 * プロンプト 6,857 → 7,948 トークン（予算 31,616）。増分は 0.3 秒未満。
 *
 * **module scope で読んではいけない**。各アプリの dotenv.config() は全 import の
 * 評価より後に走るので、トップレベルで読むと .env が黙って無視される。
 */
export function maxImageTiles(): number {
  const raw = process.env.AI_IMAGE_TILES?.trim();
  if (!raw) return DEFAULT_MAX_TILES;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_TILES;
  return Math.min(Math.floor(value), 6);
}

/**
 * タイル1枚がいちばん原寸に近くなる割り方を、上限枚数の中から選ぶ。
 *
 * 縦横比だけで割ると拡大率が足りない。2000x3100 を 1x2 で割っても、タイルは
 * 2000x1550 → 896x694（原寸の0.45倍）にしかならず、全体像の0.33倍と大差ない。
 * 実測で画像内の文字が読めたのは 2x3（タイル 1000x1034 → 867x896、ほぼ原寸）だった。
 * よって候補を全部並べ、タイルが保つ解像度（scale）が最大のものを採る。
 * 同点なら枚数の少ない方（トークンと生成時間が安い方）。
 *
 * 縦横とも3分割までに制限しているのは、位置の呼び名（左上・上中央…）が
 * 一意につけられる範囲に収めるため。
 */
function chooseGrid(
  width: number,
  height: number,
  maxTiles: number,
): { cols: number; rows: number } | undefined {
  let best: { cols: number; rows: number; scale: number } | undefined;
  for (let cols = 1; cols <= 3; cols++) {
    for (let rows = 1; rows <= 3; rows++) {
      const tiles = cols * rows;
      if (tiles < 2 || tiles > maxTiles) continue;
      // タイルを長辺896へ縮めたときに残る倍率。1.0 なら原寸のまま入る。
      const scale = Math.min(
        1,
        TILE_MAX_LONG_SIDE / Math.max(width / cols, height / rows),
      );
      if (
        !best ||
        scale > best.scale + 1e-9 ||
        (Math.abs(scale - best.scale) < 1e-9 && tiles < best.cols * best.rows)
      ) {
        best = { cols, rows, scale };
      }
    }
  }
  return best ? { cols: best.cols, rows: best.rows } : undefined;
}

function positionName(
  col: number,
  row: number,
  cols: number,
  rows: number,
): { ja: string; en: string } {
  const horizontal =
    cols === 1 ? { ja: "", en: "" }
      : cols === 2 ? (col === 0 ? { ja: "左", en: "left" } : { ja: "右", en: "right" })
      : col === 0 ? { ja: "左", en: "left" }
      : col === 1 ? { ja: "中央", en: "center" }
      : { ja: "右", en: "right" };
  const vertical =
    rows === 1 ? { ja: "", en: "" }
      : rows === 2 ? (row === 0 ? { ja: "上", en: "top" } : { ja: "下", en: "bottom" })
      : row === 0 ? { ja: "上", en: "top" }
      : row === 1 ? { ja: "中", en: "middle" }
      : { ja: "下", en: "bottom" };
  // 日本語は「左上」の語順。ただし横が「中央」のときだけ「上中央」が自然。
  const ja =
    (horizontal.ja === "中央"
      ? `${vertical.ja}${horizontal.ja}`
      : `${horizontal.ja}${vertical.ja}`) || "全体";
  const en = [vertical.en, horizontal.en].filter(Boolean).join("-") || "whole";
  return { ja, en };
}

function scaleToLongSide(
  width: number,
  height: number,
  longSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, longSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * 画像1枚を「全体像（＋必要ならタイル）」へ整形する。
 *
 * デコードや再エンコードに失敗したら、元のバイト列をそのまま1枚として返す。
 * 画像を欠いたまま返信しない現行の契約（direct は throw）を、ここで壊さないため。
 */
export async function prepareModelImages(
  buffer: Buffer,
  mimeType: string,
): Promise<PreparedImage[]> {
  try {
    if (!isDecodableImage(buffer)) {
      throw new Error("unrecognised image signature");
    }
    const source = await withTimeout(loadImage(buffer), DECODE_TIMEOUT_MS, "loadImage");
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    if (!sourceWidth || !sourceHeight) throw new Error("decoded image has no size");

    const encode = (
      sx: number, sy: number, sw: number, sh: number, longSide: number,
    ): string => {
      const { width, height } = scaleToLongSide(sw, sh, longSide);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
      return canvas.toBuffer("image/jpeg", JPEG_QUALITY).toString("base64");
    };

    const images: PreparedImage[] = [
      {
        mimeType: "image/jpeg",
        data: encode(0, 0, sourceWidth, sourceHeight, WHOLE_MAX_LONG_SIDE),
        kind: "whole",
      },
    ];

    const maxTiles = maxImageTiles();
    const longSide = Math.max(sourceWidth, sourceHeight);
    if (maxTiles >= 2 && longSide > TILE_MIN_LONG_SIDE) {
      const grid = chooseGrid(sourceWidth, sourceHeight, maxTiles);
      if (grid) {
        const tileWidth = sourceWidth / grid.cols;
        const tileHeight = sourceHeight / grid.rows;
        const padX = tileWidth * TILE_OVERLAP;
        const padY = tileHeight * TILE_OVERLAP;
        for (let row = 0; row < grid.rows; row++) {
          for (let col = 0; col < grid.cols; col++) {
            const sx = Math.max(0, col * tileWidth - padX);
            const sy = Math.max(0, row * tileHeight - padY);
            const sw = Math.min(sourceWidth - sx, tileWidth + padX * 2);
            const sh = Math.min(sourceHeight - sy, tileHeight + padY * 2);
            const position = positionName(col, row, grid.cols, grid.rows);
            images.push({
              mimeType: "image/jpeg",
              data: encode(sx, sy, sw, sh, TILE_MAX_LONG_SIDE),
              kind: "tile",
              position: position.ja,
              positionEn: position.en,
            });
          }
        }
      }
    }
    return images;
  } catch (error) {
    console.warn(
      "[WARN][AI_IMAGE] 画像を整形できなかったので原本をそのまま使う",
      error instanceof Error ? error.message : error,
    );
    return [{ mimeType, data: buffer.toString("base64"), kind: "whole" }];
  }
}

/** タイル画像に添えるラベル。全体像のラベルは呼び出し側（出所を知っている側）が作る。 */
export function tileLabel(
  index: string | number,
  parentIndex: string | number,
  image: PreparedImage,
  langStr?: LanguageName,
): string {
  const japanese = langStr === "日本語";
  return japanese
    ? `画像${index}: 画像${parentIndex}の${image.position ?? ""}を拡大したもの。新しい被写体ではなく、同じ画像の一部です。ここで読み取れた具体物を、画像${parentIndex}について書くときの根拠にしてください。`
    : `Image ${index}: a ${image.positionEn ?? "cropped"} close-up of image ${parentIndex}. It is not a separate subject; use what you can read here as evidence when you write about image ${parentIndex}.`;
}
