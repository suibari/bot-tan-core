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
