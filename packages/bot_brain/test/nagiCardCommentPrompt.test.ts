import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNIVERSARY_SLOTS,
  buildAnniversaryCardDef,
  getCardDef,
  SLOT_NAGI_REGISTERED_DAY,
  SLOT_USER_ANNIVERSARY,
} from "@bsky-affirmative-bot/shared-configs";
import { buildNagiCardCommentPrompt } from "../src/ai/generateNagiCardComment.js";

function card(id: number) {
  const definition = getCardDef(1, id);
  assert.ok(definition);
  return definition;
}

test("Nカードは短いコメント形式を維持する", () => {
  const prompt = buildNagiCardCommentPrompt({
    card: card(1),
    displayName: "テストさん",
    isDuplicate: false,
  });

  assert.match(prompt, /日本語・1〜2文・最大80文字/);
  assert.doesNotMatch(prompt, /このレアカードで必ず行う掘り下げ/);
});

test("ラテちゃんのSRカードは関係やエピソードを掘り下げる", () => {
  const prompt = buildNagiCardCommentPrompt({
    card: card(24),
    displayName: "テストさん",
    isDuplicate: false,
  });

  assert.match(prompt, /日本語・2〜3文・最大140文字/);
  assert.match(prompt, /親友であることや猫に変身しすぎた話/);
  assert.match(prompt, /汎用コメントは禁止/);
});

test("全否定botは別人ではなくbotたん自身の過去として扱う", () => {
  const prompt = buildNagiCardCommentPrompt({
    card: card(28),
    displayName: "テストさん",
    isDuplicate: true,
  });

  assert.match(prompt, /別人として紹介せず/);
  assert.match(prompt, /あなた自身の\s+過去/);
  assert.match(prompt, /「また来たね」という文脈/);
});

// --- 記念日カード。ガチャの当たりではなく botたんからの贈り物なので、枠組みごと別 ---

function anniversaryCard(slot: number, year = 2026, label?: string) {
  const definition = buildAnniversaryCardDef(slot, year, label);
  assert.ok(definition);
  return definition;
}

test("記念日カードは「引き当てた」枠組みを使わず、レアリティの話もしない", () => {
  const prompt = buildNagiCardCommentPrompt({
    card: anniversaryCard(ANNIVERSARY_SLOTS.halloween),
    displayName: "テストさん",
    isDuplicate: false,
    anniversary: {
      nameJa: "ハロウィン",
      nameEn: "Halloween",
      year: 2026,
      isUserAnniversary: false,
    },
  });

  // 通常カードの最重要ブロック（ガチャで出ただけ）は記念日では成立しない。
  assert.doesNotMatch(prompt, /カードはガチャで\s*出てきただけです/);
  assert.doesNotMatch(prompt, /引き当てたこと/);
  assert.match(prompt, /ガチャで出たものではありません/);
  assert.match(prompt, /レアリティの話をしないでください/);
  assert.match(prompt, /今日は「ハロウィン」です/);
  // レアリティは UR なので、掘り下げる長さは維持する。
  assert.match(prompt, /日本語・2〜3文・最大140文字/);
});

test("ユーザー記念日は名前から中身を推測させない", () => {
  const prompt = buildNagiCardCommentPrompt({
    card: anniversaryCard(SLOT_USER_ANNIVERSARY, 2026, "誕生日"),
    displayName: "テストさん",
    isDuplicate: false,
    anniversary: {
      nameJa: "誕生日",
      nameEn: "誕生日",
      year: 2026,
      isUserAnniversary: true,
    },
  });

  // 「誕生日」という名前でも、本人が何の日として登録したかは分からない。
  assert.match(prompt, /本人しか\s*知りません/);
  assert.match(prompt, /言い当てようとしないこと/);
});

test("Nagi 登録記念日は何年目かを伝えてよい", () => {
  const prompt = buildNagiCardCommentPrompt({
    card: anniversaryCard(SLOT_NAGI_REGISTERED_DAY),
    displayName: "テストさん",
    isDuplicate: false,
    anniversary: {
      nameJa: "Nagi記念日",
      nameEn: "Nagi Anniversary",
      year: 2026,
      isUserAnniversary: false,
      yearsSinceJoined: 2,
    },
  });

  assert.match(prompt, /Nagi に来てくれた日/);
  assert.match(prompt, /2年になります/);
});

test("記念日でない通常カードは今までどおりの枠組みのまま", () => {
  const prompt = buildNagiCardCommentPrompt({
    card: card(1),
    displayName: "テストさん",
    isDuplicate: false,
  });
  assert.match(prompt, /カードはガチャで/);
  assert.doesNotMatch(prompt, /ガチャで出たものではありません/);
});
