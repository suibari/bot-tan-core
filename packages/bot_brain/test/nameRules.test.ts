import assert from "node:assert/strict";
import test from "node:test";
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import {
  NAME_RULES_EN,
  NAME_RULES_JA,
} from "@bsky-affirmative-bot/shared-configs";
import { buildAffirmativePrompt } from "../src/ai/generateAffirmativeWord.js";
import { buildConversationPrompt } from "../src/ai/conversation.js";

/**
 * 呼称ドリフトの回帰テスト。
 *
 * displayName をプロンプトに載せるだけだった頃、botたんは同じ相手の呼び方を
 * 数日のうちに何通りにも揺らし、本人が訂正して謝罪した直後にさらに悪化した。
 * 拘束はリプライ（肯定・会話の両方）と
 * 日英の両方に効いている必要がある。呼び出し元は bsky_bot_server と nagi_bot_server の
 * 2つだが実装は共通なので、ここを守れば両方に効く。
 */

const userinfo = (
  displayName: string | undefined,
  langStr: "日本語" | "English",
): UserInfoGemini =>
  ({
    follower: { did: "did:plc:test", handle: "test.example", displayName },
    posts: ["きょうはいい天気だね"],
    langStr,
  }) as UserInfoGemini;

test("NAME_RULES: 名前があれば「そのまま使う」と愛称化の禁止を必ず含む", () => {
  const ja = NAME_RULES_JA("テスト太郎");
  assert.match(ja, /「テスト太郎」をそのまま使う/);
  assert.match(ja, /愛称化/);

  const en = NAME_RULES_EN("Testuser");
  assert.match(en, /"Testuser" exactly as written/);
  assert.match(en, /nickname/);
});

test("NAME_RULES: 名前が空なら名前で呼ばせず、発明も禁じる", () => {
  for (const empty of [undefined, null, "", "   "]) {
    const ja = NAME_RULES_JA(empty);
    assert.match(ja, /名前で呼ばない/);
    assert.match(ja, /発明/);
    // 空文字を穴として埋め込まない（「」が残ると LLM が代わりの名前を作る）
    assert.doesNotMatch(ja, /「」/);

    const en = NAME_RULES_EN(empty);
    assert.match(en, /do not address them by name/);
    assert.match(en, /invent a name/);
    assert.doesNotMatch(en, /""/);
  }
});

test("肯定リプライのプロンプトに呼称の拘束が入る（日英）", async () => {
  const ja = await buildAffirmativePrompt(userinfo("テスト太郎", "日本語"));
  assert.ok(ja.includes(NAME_RULES_JA("テスト太郎")), "日本語プロンプトに拘束が無い");

  const en = await buildAffirmativePrompt(userinfo("Testuser", "English"));
  assert.ok(en.includes(NAME_RULES_EN("Testuser")), "英語プロンプトに拘束が無い");
});

test("会話モードのプロンプトに呼称の拘束が入る（日英）", () => {
  const ja = buildConversationPrompt(userinfo("テスト太郎", "日本語"));
  assert.ok(ja.includes(NAME_RULES_JA("テスト太郎")), "日本語プロンプトに拘束が無い");

  const en = buildConversationPrompt(userinfo("Testuser", "English"));
  assert.ok(en.includes(NAME_RULES_EN("Testuser")), "英語プロンプトに拘束が無い");
});

test("会話モードは訂正には従うが、訂正の言葉から呼び名を作らない", () => {
  // 事故の再現条件。本人の訂正を「改名依頼」と誤解して別の呼び名を作り出したのが原因。
  const ja = buildConversationPrompt(userinfo("テスト太郎", "日本語"));
  assert.match(ja, /訂正された呼び方に従う/);
  assert.match(ja, /推測して作り出さない/);

  const en = buildConversationPrompt(userinfo("Testuser", "English"));
  assert.match(en, /follow the correction/);
  assert.match(en, /never invent a name/i);
});

test("displayName 未設定でもプロンプトに空の呼び名を埋め込まない", async () => {
  const ja = await buildAffirmativePrompt(userinfo(undefined, "日本語"));
  assert.match(ja, /名前で呼ばない/);

  const conv = buildConversationPrompt(userinfo(undefined, "日本語"));
  assert.match(conv, /名前で呼ばない/);
});
