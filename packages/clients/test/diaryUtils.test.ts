import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLangStr,
  sampleDiaryTimeline,
  selectDiaryInteractionTexts,
} from '../src/diaryUtils.js';

test('langsはNagiと同じく先頭の基本言語を採用する', () => {
  assert.equal(getLangStr(['ja', 'en']), '日本語');
  assert.equal(getLangStr(['es-MX', 'en']), 'Spanish');
  assert.equal(getLangStr(['EN-us']), 'English');
  assert.equal(getLangStr([]), 'English');
  assert.equal(getLangStr(undefined), 'English');
  assert.equal(getLangStr(['xx']), 'English');
});

test('長い日記材料は一日の先頭・中盤・末尾を残して均等に縮める', () => {
  const values = Array.from({ length: 101 }, (_, index) => index);
  const sampled = sampleDiaryTimeline(values, 5);
  assert.deepEqual(sampled, [0, 25, 50, 75, 100]);
});

test('日記の投稿材料は重複・空白・極端に長い本文を正規化して上限内にする', () => {
  const selected = selectDiaryInteractionTexts([
    '  朝の散歩が気持ちよかった  ',
    '朝の散歩が気持ちよかった',
    '',
    undefined,
    'x'.repeat(40),
    '昼の読書',
    '夜のゲーム',
  ], 4, 20);

  assert.equal(selected.length, 4);
  assert.equal(selected[0], '朝の散歩が気持ちよかった');
  assert.equal(selected[1], 'xxxxxxxxxxxxxxxxxxx…');
  assert.equal(selected[3], '夜のゲーム');
});
