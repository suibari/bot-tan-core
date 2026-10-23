import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBotContext } from '../src/ai/util.js';
import type { BotContext } from '@bsky-affirmative-bot/shared-configs';

const base: BotContext = {
  datetime: '2026年8月21日10時00分',
  weather: 'はれ',
  botActivity: 'おさんぽ',
  botActivityEn: 'walking',
  botEnergy: 70,
};

// JST 2026-08-21T09:00
const now = new Date('2026-08-21T00:00:00Z');

test('短期記憶は相対表現の見出し付きで載る', () => {
  const text = formatBotContext(
    {
      ...base,
      recentDigests: [
        { date: '2026-08-20', summary: 'にぎやかな一日だった。' },
        { date: '2026-08-18', summary: 'しずかな一日だった。' },
      ],
    },
    '日本語',
    { now },
  );
  assert.match(text, /### この数日の出来事/);
  assert.match(text, /- きのう: にぎやかな一日だった。/);
  assert.match(text, /- 3日前: しずかな一日だった。/);
});

test('短期記憶が無ければ節ごと出さない', () => {
  const text = formatBotContext(base, '日本語', { now });
  assert.doesNotMatch(text, /この数日の出来事/);
});

test('短期記憶は載せすぎない', () => {
  const text = formatBotContext(
    {
      ...base,
      recentDigests: Array.from({ length: 7 }, (_, index) => ({
        date: `2026-08-${20 - index}`,
        summary: `ダイジェスト${index}`,
      })),
    },
    '日本語',
    { now },
  );
  assert.equal((text.match(/ダイジェスト\d/g) ?? []).length, 4);
});

test('英語でも短期記憶の節が出る', () => {
  const text = formatBotContext(
    { ...base, recentDigests: [{ date: '2026-08-20', summary: 'A busy day.' }] },
    'English',
    { now },
  );
  assert.match(text, /### What happened over the last few days/);
  assert.match(text, /- yesterday: A busy day\./);
});

test('定期ポストには自分の最近の投稿と前夜のひとことが載る', () => {
  const text = formatBotContext(
    {
      ...base,
      recentOwnPosts: [
        { at: '2026-08-20T13:00:00Z', kind: 'goodnight', text: 'きょうもありがとう、おやすみ' },
        { at: '2026-08-20T23:30:00Z', kind: 'morning', text: 'おはよう！' },
      ],
      tomorrowHook: '星の図鑑の続きを読みたい',
    },
    '日本語',
    { now, purpose: 'scheduledPost' },
  );
  assert.match(text, /### 昨日の夜、自分で言っていたこと\n「星の図鑑の続きを読みたい」/);
  assert.match(text, /### 自分の最近の投稿/);
  assert.match(text, /・おやすみ: きょうもありがとう、おやすみ/);
  assert.match(text, /・おはよう: おはよう！/);
});

test('リプライには自分の投稿と前夜のひとことを載せない', () => {
  const text = formatBotContext(
    {
      ...base,
      recentOwnPosts: [{ at: '2026-08-20T23:30:00Z', kind: 'morning', text: 'おはよう！' }],
      tomorrowHook: '星の図鑑の続きを読みたい',
    },
    '日本語',
    { now },
  );
  assert.doesNotMatch(text, /自分の最近の投稿|昨日の夜/);
});

test('自分の投稿は長ければ切って1行にする', () => {
  const text = formatBotContext(
    {
      ...base,
      recentOwnPosts: [{ at: '2026-08-20T23:30:00Z', kind: 'whimsical', text: `あ\nい${'う'.repeat(200)}` }],
    },
    '日本語',
    { now, purpose: 'scheduledPost' },
  );
  assert.match(text, /・気まぐれ: あ いう+…\n/);
});
