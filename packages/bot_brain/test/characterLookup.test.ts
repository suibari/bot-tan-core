import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pickAppearance,
  resolveCharacters,
  toDanbooruTag,
} from "../src/ai/characterLookup.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

test("共起タグから外見だけを拾い、露出系は落とす", () => {
  // 2026-09-16 の shimakaze_(kancolle) の実データ（抜粋）。
  const { countTag, appearance } = pickAppearance([
    { name: "long_hair", frequency: 0.8652 },
    { name: "gloves", frequency: 0.7372 },
    { name: "elbow_gloves", frequency: 0.6748 },
    { name: "1girl", frequency: 0.6538 },
    { name: "blonde_hair", frequency: 0.634 },
    { name: "striped_thighhighs", frequency: 0.6096 },
    { name: "hairband", frequency: 0.5904 },
    { name: "underwear", frequency: 0.563 },
    { name: "panties", frequency: 0.5576 },
    { name: "highleg_panties", frequency: 0.3754 },
    { name: "navel", frequency: 0.3556 },
    { name: "crop_top", frequency: 0.3024 },
    { name: "microskirt", frequency: 0.285 },
    { name: "sailor_collar", frequency: 0.4344 },
    { name: "shimakaze_(kancolle)_(cosplay)", frequency: 0.221 },
    { name: "black_hairband", frequency: 0.2102 },
  ]);
  assert.equal(countTag, "1girl");
  assert.deepEqual(appearance, [
    "long hair",
    "elbow gloves",
    "blonde hair",
    "striped thighhighs",
    "hairband",
    "sailor collar",
  ]);
});

test("male focus を足して 1boy / 1girl を決める", () => {
  // 竈門炭治郎は 1boy 0.41 / 1girl 0.39 と拮抗する。
  const { countTag } = pickAppearance([
    { name: "male_focus", frequency: 0.447 },
    { name: "1boy", frequency: 0.411 },
    { name: "1girl", frequency: 0.391 },
  ]);
  assert.equal(countTag, "1boy");
});

test("英語の名前はタグの形にして直接試す。日本語はそのままでは試さない", () => {
  assert.equal(toDanbooruTag("Hatsune Miku"), "hatsune_miku");
  assert.equal(toDanbooruTag("島風"), null);
});

/** 叩かれた URL を path ごとに返す簡易 Danbooru。 */
function fakeDanbooru(routes: Record<string, (url: URL) => unknown>) {
  const calls: URL[] = [];
  globalThis.fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url);
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    return json(route(url));
  }) as typeof fetch;
  return calls;
}

test("同名キャラは作品名込みの別名で見分ける（艦これの島風とアズレンの島風）", async () => {
  process.env.DANBOORU_BASE_URL = "https://danbooru.test";
  delete process.env.SEARXNG_BASE_URL;
  const calls = fakeDanbooru({
    "/wiki_pages.json": (url) =>
      url.searchParams.get("search[other_names_match]") === "島風"
        ? [
            { title: "shimakaze_(azur_lane)", other_names: ["島風", "島風(アズールレーン)"] },
            { title: "shimakaze_(kancolle)", other_names: ["島風", "島風(艦これ)"] },
          ]
        : [{ title: "kantai_collection", other_names: ["艦これ"] }],
    "/tags.json": (url) =>
      [
        { name: "shimakaze_(azur_lane)", post_count: 90000, category: 4 },
        { name: "shimakaze_(kancolle)", post_count: 20724, category: 4 },
        { name: "kantai_collection", post_count: 544355, category: 3 },
      ].filter((tag) => url.searchParams.get("search[name_comma]")!.split(",").includes(tag.name)),
    "/related_tag.json": (url) => {
      const query = url.searchParams.get("query");
      if (url.searchParams.get("category") === "copyright") {
        return {
          related_tags: [
            { tag: { name: query === "shimakaze_(kancolle)" ? "kantai_collection" : "azur_lane" }, frequency: 1 },
          ],
        };
      }
      return {
        related_tags: [
          { tag: { name: "1girl" }, frequency: 0.65 },
          { tag: { name: "blonde_hair" }, frequency: 0.63 },
          { tag: { name: "panties" }, frequency: 0.55 },
        ],
      };
    },
  });

  const [resolved] = await resolveCharacters([{ name: "島風", series: "艦これ" }]);
  assert.equal(resolved.tag, "shimakaze (kancolle)");
  assert.equal(resolved.series, "kantai collection");
  assert.deepEqual(resolved.appearance, ["blonde hair"]);
  // 外部サービスへ身元の分かる User-Agent を送る。
  assert.ok(calls.every((url) => url.origin === "https://danbooru.test"));
});

test("見つからない・投稿の少ないタグ・API エラーは解決しない（throw しない）", async () => {
  process.env.DANBOORU_BASE_URL = "https://danbooru.test";
  delete process.env.SEARXNG_BASE_URL;
  fakeDanbooru({
    "/wiki_pages.json": () => [{ title: "obscure_(game)", other_names: ["マイナー"] }],
    "/tags.json": () => [{ name: "obscure_(game)", post_count: 3, category: 4 }],
  });
  assert.deepEqual(await resolveCharacters([{ name: "マイナー", series: "" }]), []);

  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  assert.deepEqual(await resolveCharacters([{ name: "島風", series: "" }]), []);
});

test("DANBOORU_BASE_URL=off なら外へ出ない", async () => {
  process.env.DANBOORU_BASE_URL = "off";
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return json([]);
  }) as typeof fetch;
  assert.deepEqual(await resolveCharacters([{ name: "島風", series: "艦これ" }]), []);
  assert.equal(called, false);
});

test("髪の長さ・髪色・目の色は頻度の高い1つだけ残す（集合絵の他キャラが混ざる）", () => {
  // 2026-09-16 の kamado_tanjirou の実データ（抜粋）。
  const { appearance } = pickAppearance([
    { name: "japanese_clothes", frequency: 0.655 },
    { name: "earrings", frequency: 0.598 },
    { name: "long_hair", frequency: 0.486 },
    { name: "short_hair", frequency: 0.47 },
    { name: "black_hair", frequency: 0.464 },
    { name: "brown_hair", frequency: 0.394 },
    { name: "multicolored_hair", frequency: 0.341 },
  ]);
  assert.deepEqual(appearance, [
    "japanese clothes",
    "earrings",
    "long hair",
    "black hair",
    "multicolored hair",
  ]);
});

test("共起タグの API が落ちても、キャラタグだけで解決する（hatsune_miku は 500 を返す）", async () => {
  process.env.DANBOORU_BASE_URL = "https://danbooru.test";
  delete process.env.SEARXNG_BASE_URL;
  fakeDanbooru({
    "/wiki_pages.json": () => [{ title: "hatsune_miku", other_names: ["初音ミク"] }],
    "/tags.json": () => [{ name: "hatsune_miku", post_count: 145909, category: 4 }],
  });
  const [resolved] = await resolveCharacters([{ name: "初音ミク", series: "" }]);
  assert.equal(resolved.tag, "hatsune miku");
  assert.equal(resolved.series, undefined);
  assert.equal(resolved.countTag, "1girl");
  assert.deepEqual(resolved.appearance, []);
});

