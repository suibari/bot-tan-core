import assert from "node:assert/strict";
import test from "node:test";
import { parseKnowledgeCardText } from "../src/botMemoryCard.js";

const base = { context: null, learnedAt: "2026-11-01T00:00:00.000Z" };

test("knowledge_card_v1 は概要・見出し・出典に分かれる", () => {
  const card = parseKnowledgeCardText({
    ...base,
    term: "薬屋のひとりごと",
    format: "knowledge_card_v1",
    content: [
      "薬屋のひとりごと",
      "概要",
      "日向夏による小説。後宮を舞台にした謎解きもの。",
      "",
      "主な作品展開",
      "漫画化・アニメ化されている。",
      "出典: https://example.com/a / https://example.com/b",
      "",
      "Sources:",
      "- https://example.com/a",
      "- https://example.com/b",
      "- javascript:alert(1)",
    ].join("\n"),
  });
  assert.equal(card.overview, "日向夏による小説。後宮を舞台にした謎解きもの。");
  assert.deepEqual(card.sections, [
    {
      heading: "主な作品展開",
      detail: "漫画化・アニメ化されている。",
      sources: ["https://example.com/a", "https://example.com/b"],
    },
  ]);
  assert.deepEqual(card.sources, ["https://example.com/a", "https://example.com/b"], "http(s) 以外は落とす");
});

test("検索抜粋はページ名を見出しにする", () => {
  const card = parseKnowledgeCardText({
    ...base,
    term: "トリシューラ",
    context: "遊戯王",
    format: "web_snippet_v1",
    content: [
      "トリシューラ（遊戯王）",
      "（「トリシューラ」の検索結果）",
      "「氷結界の龍 トリシューラ」より: シンクロモンスター。",
      "「カード一覧」より: 除外効果を持つ。",
    ].join("\n"),
  });
  assert.equal(card.overview, null);
  assert.deepEqual(
    card.sections.map((section) => [section.heading, section.detail]),
    [
      ["氷結界の龍 トリシューラ", "シンクロモンスター。"],
      ["カード一覧", "除外効果を持つ。"],
    ],
  );
});

test("古い箇条書きは見出し無しの段落として残す", () => {
  const card = parseKnowledgeCardText({
    ...base,
    term: "散歩",
    format: null,
    content: "散歩\n- 歩くこと。\n- 健康に良い。\n\nSources:\n- https://example.com/",
  });
  assert.deepEqual(card.sections, [{ heading: "", detail: "歩くこと。\n健康に良い。", sources: [] }]);
  assert.deepEqual(card.sources, ["https://example.com/"]);
});
