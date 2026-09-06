import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import {
  maxImageTiles,
  prepareModelImages,
  tileLabel,
} from "../src/ai/imagePreprocess.js";
import { buildAffirmativeImageParts } from "../src/ai/affirmativeImages.js";

/** 指定サイズの PNG を作る。分割の判定は実寸を見るので、小さすぎる画像は使えない。 */
function png(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#4488cc";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(width * 0.1, height * 0.1, width * 0.3, height * 0.3);
  return canvas.toBuffer("image/png");
}

function decodedSize(base64: string): Promise<{ width: number; height: number }> {
  return import("@napi-rs/canvas").then(async ({ loadImage }) => {
    const image = await loadImage(Buffer.from(base64, "base64"));
    return { width: image.width, height: image.height };
  });
}

const withTiles = async (value: string | undefined, run: () => Promise<void>) => {
  const previous = process.env.AI_IMAGE_TILES;
  if (value === undefined) delete process.env.AI_IMAGE_TILES;
  else process.env.AI_IMAGE_TILES = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.AI_IMAGE_TILES;
    else process.env.AI_IMAGE_TILES = previous;
  }
};

test("長辺は1024へ縮小され、JPEGになる", async () => {
  await withTiles("0", async () => {
    const source = png(2000, 3100);
    const prepared = await prepareModelImages(source, "image/png");

    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].kind, "whole");
    assert.equal(prepared[0].mimeType, "image/jpeg");

    const size = await decodedSize(prepared[0].data);
    assert.equal(Math.max(size.width, size.height), 1024);
    // 実効解像度は896相当で頭打ちなので、原寸を送る意味はない。軽くなることを担保する。
    assert.ok(
      Buffer.from(prepared[0].data, "base64").length < source.length / 2,
      "縮小後のバイト数が原本の半分未満であること",
    );
  });
});

test("小さい画像は拡大しない", async () => {
  await withTiles("0", async () => {
    const [prepared] = await prepareModelImages(png(320, 240), "image/png");
    const size = await decodedSize(prepared.data);
    assert.deepEqual(size, { width: 320, height: 240 });
  });
});

test("AI_IMAGE_TILES 未設定なら既定の4枚でタイルを作る", async () => {
  await withTiles(undefined, async () => {
    assert.equal(maxImageTiles(), 4);
    const prepared = await prepareModelImages(png(2000, 3100), "image/png");
    assert.equal(prepared.length, 5);
  });
});

test("AI_IMAGE_TILES=0 でタイルを止められる", async () => {
  await withTiles("0", async () => {
    assert.equal(maxImageTiles(), 0);
    const prepared = await prepareModelImages(png(2000, 3100), "image/png");
    assert.equal(prepared.length, 1);
  });
});

test("縦長画像は2x3で分割され、全体像が先頭に来る", async () => {
  await withTiles("6", async () => {
    const prepared = await prepareModelImages(png(2000, 3100), "image/png");

    assert.equal(prepared.length, 7);
    assert.equal(prepared[0].kind, "whole");
    assert.ok(prepared.slice(1).every((item) => item.kind === "tile"));
    assert.deepEqual(
      prepared.slice(1).map((item) => item.position),
      ["左上", "右上", "左中", "右中", "左下", "右下"],
    );
    // fitOllamaMessages は画像を後ろから落とす。全体像が最後まで残る並びであること。
    assert.equal(prepared[0].kind, "whole");

    for (const tile of prepared.slice(1)) {
      const size = await decodedSize(tile.data);
      assert.ok(Math.max(size.width, size.height) <= 896);
    }
  });
});

/**
 * 分割数は縦横比ではなく「タイルが保つ解像度」で選ぶ。縦横比で割ると、縦長画像を
 * 横1列に割って拡大率がほとんど稼げない（実際にそう壊れていた）。
 */
test("縦長画像を上限4枚で割るとき、横1列ではなく2x2を選ぶ", async () => {
  await withTiles("4", async () => {
    const prepared = await prepareModelImages(png(2000, 3100), "image/png");
    assert.deepEqual(
      prepared.slice(1).map((item) => item.position),
      ["左上", "右上", "左下", "右下"],
    );
    // 全体像(長辺1024→原寸の0.33倍)より、タイルの方がはっきり細かく見えること。
    const tile = await decodedSize(prepared[1].data);
    assert.ok(
      Math.max(tile.width, tile.height) / Math.max(1000, 1550) > 0.5,
      "タイルが原寸の半分以上の解像度を保っていること",
    );
  });
});

test("横長画像は横に広い分割を選ぶ", async () => {
  await withTiles("4", async () => {
    const prepared = await prepareModelImages(png(3000, 1000), "image/png");
    assert.deepEqual(
      prepared.slice(1).map((item) => item.position),
      ["左", "中央", "右"],
    );
  });
});

test("小さい画像は分割しない（新しい画素が出ないため）", async () => {
  await withTiles("4", async () => {
    const prepared = await prepareModelImages(png(1000, 800), "image/png");
    assert.equal(prepared.length, 1);
  });
});

test("デコードできない入力は原本をそのまま1枚として返す", async () => {
  await withTiles("4", async () => {
    const broken = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const prepared = await prepareModelImages(broken, "image/png");
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].mimeType, "image/png");
    assert.equal(prepared[0].data, broken.toString("base64"));
  });
});

test("タイルには「同じ画像の一部」だと分かるラベルが付く", () => {
  const label = tileLabel("1-2", 1, {
    mimeType: "image/jpeg",
    data: "",
    kind: "tile",
    position: "右上",
    positionEn: "top-right",
  }, "日本語");
  assert.match(label, /画像1-2/);
  assert.match(label, /画像1の右上/);
  assert.match(label, /新しい被写体ではなく/);
});

test("肯定リプライではタイルが全体像の直後に、ラベル付きで積まれる", async () => {
  await withTiles("4", async () => {
    const source = png(2000, 1500);
    const { parts, stats } = await buildAffirmativeImageParts(
      [{ image_url: "https://example.com/a.png", mimeType: "image/png", origin: "direct" }],
      "日本語",
      async () => new Response(source, { status: 200 }),
    );

    // [全体ラベル, 全体画像, タイルラベル, タイル画像, ...]
    assert.equal(stats.succeeded, 1);
    assert.equal(stats.tiles, 4);
    assert.equal(parts.length, 10);
    assert.match((parts[0] as any).text, /画像1: 今回の投稿者が直接添付した画像/);
    assert.ok((parts[1] as any).inlineData);
    assert.match((parts[2] as any).text, /画像1-1: 画像1の/);
    assert.ok((parts[3] as any).inlineData);
  });
});
