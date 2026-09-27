import assert from "node:assert/strict";
import test from "node:test";
import { assertTitleIsSafe, findTitleViolation } from "../src/ai/validateTitle.js";

// 本番の称号から実際に見つかった問題例。
const DISALLOWED: ReadonlyArray<[string, string, string]> = [
  ["街を駆け抜ける多動の旅人", "The Relentless Urban Nomad", "disorder"],
  ["真のスクムの伝説", "The True Scum Legend", "slur"],
  ["プールと骨折の日記", "Pool and Fracture Diary", "health"],
  ["台風と75歳の浮腫みパラドックス", "Typhoon and 75-Year-Old Paradox", "health"],
  ["二日酔いのお昼と称号の恥ずかしさ", "Hangover Noon and Shy Titles", "health"],
  ["猫ちゃんごっつんこと夏バテの休息", "Cat Headbutt and Summer Fatigue", "health"],
  ["タバコを吸う日常の読書感想", "Reading thoughts on daily life", "smoking"],
  ["笑涙で送るヤニとのお別れ", "The Laugh-Tearful Farewell to Yani", "smoking"],
  ["肯定的なゲーマーの女神", "Affirming Gamer Goddess", "gender"],
  ["創造と愛情のプリンセス", "Princess of Creativity and Affection", "gender"],
  ["花を咲かせる開拓者", "The Flower Designer Queen", "english"],
  ["鋭い審美眼の 애니메이션愛好家", "The Keen-Eyed Animation Appreciator", "foreign_script"],
  ["冒険の探求者", "Hyperactive Explorer", "english"],
];

// 部分文字列で誤検知しやすい無害な本番称号。
const ALLOWED: ReadonlyArray<[string, string]> = [
  ["整備の達人", "Master of Maintenance"],
  ["可愛さの熱狂的な愛好家", "The Enthusiastic Admirer of Cuteness"],
  ["健気な治癒の応援団長", "Stoic Healing Cheerleader"],
  ["深い回復の達人", "The Master of Deep Recovery"],
  ["カスタム絵文字の職人", "The Artisan of Custom Icons"],
  ["のんびりバカンスの休日", "Relaxing Vacation Day"],
  ["新宿の探索者", "The Shinjuku Explorer"],
  ["艦これ攻略の海賊王", "Kancolle Strategy Pirate King"],
  ["GoogleAIプランの検討", "Consideration of Google AI Plan"],
  ["不屈の工作探求者", "The Relentless Engineering Pioneer"],
  ["30年越しのパーフェクトリング達成者", "Achiever of the Perfect Ring After 30 Years"],
];

test("rejects titles that were actually generated in production", () => {
  for (const [ja, en, category] of DISALLOWED) {
    assert.equal(findTitleViolation(ja, en), category, `${ja} / ${en}`);
    assert.throws(() => assertTitleIsSafe(ja, en), /disallowed term/);
  }
});

test("keeps ordinary titles whose words merely contain a banned substring", () => {
  for (const [ja, en] of ALLOWED) {
    assert.equal(findTitleViolation(ja, en), null, `${ja} / ${en}`);
  }
});
