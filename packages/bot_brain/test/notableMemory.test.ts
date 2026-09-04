import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationPrompt } from '../src/ai/conversation.js';
import { memoryAgeLabel } from '../src/ai/util.js';
import type { UserInfoGemini } from '@bsky-affirmative-bot/shared-configs';

const base = {
  follower: { did: 'did:plc:someone', handle: 'someone.test', displayName: 'だれか' },
  langStr: '日本語' as const,
  posts: ['きょうは疲れた'],
};

const now = new Date('2026-09-05T00:00:00Z');

test('思い出が無ければ節ごとプロンプトに出ない', () => {
  const prompt = buildConversationPrompt(base as unknown as UserInfoGemini);
  assert.doesNotMatch(prompt, /覚えている出来事/);
});

test('思い出があるときだけ、時期をぼかして1件だけ載る', () => {
  const prompt = buildConversationPrompt({
    ...base,
    notableMemory: {
      content: '長く準備してた個展、ぶじ終わりました',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
    },
  } as unknown as UserInfoGemini);
  assert.match(prompt, /覚えている出来事/);
  assert.match(prompt, /個展/);
  // 日付そのものは出さない。人が過去に触れる粒度に寄せる。
  assert.doesNotMatch(prompt, /2026-09-01|2026年9月1日/);
});

test('英語でも同じ扱い', () => {
  const prompt = buildConversationPrompt({
    ...base,
    langStr: 'English',
    notableMemory: {
      content: 'my exhibition finally opened',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
    },
  } as unknown as UserInfoGemini);
  assert.match(prompt, /Something you remember/);
  assert.match(prompt, /exhibition/);
});

test('memoryAgeLabel は日付ではなく相対表現を返す', () => {
  const at = (iso: string) => new Date(iso);
  assert.equal(memoryAgeLabel(at('2026-09-05T00:00:00Z'), now, true), 'ついこの前');
  assert.equal(memoryAgeLabel(at('2026-09-01T00:00:00Z'), now, true), 'この前');
  assert.equal(memoryAgeLabel(at('2026-08-20T00:00:00Z'), now, true), 'ちょっと前');
  assert.equal(memoryAgeLabel(at('2026-07-01T00:00:00Z'), now, true), 'だいぶ前');
  assert.equal(memoryAgeLabel(at('2025-09-01T00:00:00Z'), now, true), 'ずっと前');
  // 未来日（時計ずれ）でも壊れない。
  assert.equal(memoryAgeLabel(at('2026-09-10T00:00:00Z'), now, true), 'ついこの前');
});
