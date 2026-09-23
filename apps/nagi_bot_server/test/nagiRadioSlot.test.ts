import assert from 'node:assert/strict';
import test from 'node:test';
import { currentRadioSlotKey } from '@bsky-affirmative-bot/nagi-lexicon';

test('botたんラジオはJST 8・14・20時に枠が切り替わる', () => {
  assert.equal(currentRadioSlotKey(new Date('2026-09-22T22:59:59Z')), '2026-09-22-20');
  assert.equal(currentRadioSlotKey(new Date('2026-09-22T23:00:00Z')), '2026-09-23-08');
  assert.equal(currentRadioSlotKey(new Date('2026-09-23T05:00:00Z')), '2026-09-23-14');
  assert.equal(currentRadioSlotKey(new Date('2026-09-23T11:00:00Z')), '2026-09-23-20');
});
