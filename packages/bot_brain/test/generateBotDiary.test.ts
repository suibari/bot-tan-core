import assert from "node:assert/strict";
import test from "node:test";
import {
  botDiaryResponseSchema,
  parseBotDiaryResponse,
} from "../src/ai/generateBotDiary.js";
import { normalizeJsonSchema } from "../src/ai/generationClient.js";

const paragraphs = (text: string, repeats = 6) =>
  Array.from({ length: 4 }, () => text.repeat(repeats)).join("\n\n");

test("bot diary schema requires title, emoji, and content", () => {
  assert.deepEqual(normalizeJsonSchema(botDiaryResponseSchema()), {
    type: "object",
    properties: {
      title: { type: "string", description: "今日の内容に固有の日記タイトル" },
      emoji: { type: "string", description: "今日のテーマを表す絵文字1個" },
      content: { type: "string", description: "4段落以上の日記本文" },
    },
    required: ["title", "emoji", "content"],
  });
});

test("accepts a structured Japanese diary of the required size", () => {
  const content = paragraphs("今日は青空を見ながら、みんなの作品を応援できてうれしかったよ！✨");
  const result = parseBotDiaryResponse(JSON.stringify({
    title: "青空と創作のバトン",
    emoji: "🦋",
    content,
  }), true);
  assert.equal(result.title, "青空と創作のバトン");
  assert.equal(result.content, content);
});

test("accepts a structured English diary of the required size", () => {
  const content = paragraphs(
    "Today I cheered for everyone's creative work, and the bright ideas made me want to try something new too! ✨ ",
    2,
  );
  const result = parseBotDiaryResponse(JSON.stringify({
    title: "A Bright Chain of Ideas",
    emoji: "🦋",
    content,
  }), false);
  assert.equal(result.title, "A Bright Chain of Ideas");
  assert.equal(result.content, content.trim());
});

test("does not impose a maximum diary length", () => {
  const content = paragraphs("今日は一つひとつの出来事を丁寧に振り返ったよ。✨", 100);
  const result = parseBotDiaryResponse(JSON.stringify({
    title: "たくさんの出来事を抱きしめて",
    emoji: "🦋",
    content,
  }), true);
  assert.equal(result.content, content);
});

test("rejects plain prose, fallback-sized content, and Japanese in the English slot", () => {
  assert.throws(() => parseBotDiaryResponse("plain diary text", false), /invalid JSON/);
  assert.throws(
    () => parseBotDiaryResponse(JSON.stringify({ title: "Short", emoji: "📝", content: "Too short" }), false),
    /at least 4 paragraphs/,
  );
  const japanese = paragraphs("今日はみんなの投稿を読んで、とても楽しくてうれしい一日だったよ！✨");
  assert.throws(
    () => parseBotDiaryResponse(JSON.stringify({ title: "Cozy Conversations", emoji: "📝", content: japanese }), false),
    /too much Japanese/,
  );
});
