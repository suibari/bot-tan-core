import assert from 'node:assert/strict';
import test from 'node:test';
import type { UserInfoGemini } from '@bsky-affirmative-bot/shared-configs';
import { buildConversationPrompt } from '../src/ai/conversation.js';
import { buildAffirmativeInstructions, buildAffirmativeUserPost } from '../src/ai/generateAffirmativeWord.js';

const base = {
  follower: { did: 'did:plc:someone', handle: 'someone.test', displayName: 'だれか' },
  langStr: '日本語' as const,
  posts: ['きょうは雨だった'],
};

const followUp = {
  text: 'EO5-5をクリアする',
  occurredAt: new Date('2026-10-20T00:00:00Z'),
};

test('予定が無ければ節ごと出ない', async () => {
  const prompt = await buildAffirmativeInstructions(base as unknown as UserInfoGemini);
  assert.doesNotMatch(prompt, /前に聞いていた予定/);
});

test('予定は結果を知らない前提で、指示側に載る', async () => {
  const info = { ...base, followUp } as unknown as UserInfoGemini;
  const prompt = await buildAffirmativeInstructions(info);
  assert.match(prompt, /## 前に聞いていた予定/);
  assert.match(prompt, /「EO5-5をクリアする」/);
  assert.match(prompt, /結果はまだ聞いていません/);
  assert.match(prompt, /決めつけないこと/);
  // ユーザ投稿の後ろへ材料を積まない（AGENTS.md「プロンプトの並び順」）。
  assert.ok(!buildAffirmativeUserPost(info).includes('EO5-5をクリアする'));
});

test('英語の肯定リプライにも載る', async () => {
  const prompt = await buildAffirmativeInstructions(
    { ...base, langStr: 'English', followUp } as unknown as UserInfoGemini,
  );
  assert.match(prompt, /## A plan they told you about/);
  assert.match(prompt, /Do not guess the outcome/);
});

test('会話モードにも載り、無ければ出ない', () => {
  assert.match(
    buildConversationPrompt({ ...base, followUp } as unknown as UserInfoGemini),
    /前に聞いていた予定: .*「EO5-5をクリアする」/,
  );
  assert.doesNotMatch(
    buildConversationPrompt(base as unknown as UserInfoGemini),
    /前に聞いていた予定/,
  );
});
