import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateDelayUntilLocal22,
  getLangStr,
  isPastLocal22,
  localDateStr,
  localHourToUtc,
  sampleDiaryTimeline,
  selectDiaryInteractionTexts,
} from '../src/diaryUtils.js';

const HOUR_MS = 60 * 60 * 1000;

/** UTC の壁時計を指定して Date を作る。 */
const utc = (hour: number, minute = 0, day = 15) =>
  new Date(Date.UTC(2026, 7, day, hour, minute, 0));

test('langsはNagiと同じく先頭の基本言語を採用する', () => {
  assert.equal(getLangStr(['ja', 'en']), '日本語');
  assert.equal(getLangStr(['es-MX', 'en']), 'Spanish');
  assert.equal(getLangStr(['EN-us']), 'English');
  assert.equal(getLangStr([]), 'English');
  assert.equal(getLangStr(undefined), 'English');
  assert.equal(getLangStr(['xx']), 'English');
});

test('22時ちょうどから翌0時までが「22時を過ぎた」扱い', () => {
  assert.equal(isPastLocal22('UTC', utc(21, 59)), false);
  assert.equal(isPastLocal22('UTC', utc(22, 0)), true);
  assert.equal(isPastLocal22('UTC', utc(23, 59)), true);
  assert.equal(isPastLocal22('UTC', utc(0, 30)), false);
});

test('タイムゾーンはユーザーのローカル時刻で判定する', () => {
  // UTC 13:00 = Asia/Tokyo 22:00
  assert.equal(isPastLocal22('Asia/Tokyo', utc(13, 0)), true);
  assert.equal(isPastLocal22('UTC', utc(13, 0)), false);
  // UTC 12:59 = Asia/Tokyo 21:59
  assert.equal(isPastLocal22('Asia/Tokyo', utc(12, 59)), false);
});

test('22時を過ぎていれば翌日22時までの遅延を返す（即実行の判定と裏表）', () => {
  assert.equal(calculateDelayUntilLocal22('UTC', utc(21, 0)), HOUR_MS);
  // 22:00 ちょうどは「今日ぶんは過ぎた」= 24時間後。だから isPastLocal22 側で拾う必要がある。
  assert.equal(calculateDelayUntilLocal22('UTC', utc(22, 0)), 24 * HOUR_MS);
  assert.equal(calculateDelayUntilLocal22('UTC', utc(23, 0)), 23 * HOUR_MS);
});

test('ローカル22時をUTCに戻せる（バックフィルの収集窓）', () => {
  // Asia/Tokyo は UTC+9 固定
  assert.equal(
    localHourToUtc('2026-08-05', 22, 'Asia/Tokyo').toISOString(),
    '2026-08-05T13:00:00.000Z',
  );
  assert.equal(
    localHourToUtc('2026-08-05', 22, 'UTC').toISOString(),
    '2026-08-05T22:00:00.000Z',
  );
  // 夏時間中の New York は UTC-4（冬なら UTC-5）
  assert.equal(
    localHourToUtc('2026-08-05', 22, 'America/New_York').toISOString(),
    '2026-08-06T02:00:00.000Z',
  );
  assert.equal(
    localHourToUtc('2026-01-05', 22, 'America/New_York').toISOString(),
    '2026-01-06T03:00:00.000Z',
  );
});

test('localHourToUtc の結果はそのタイムゾーンで同じ日付・同じ時刻に戻る', () => {
  for (const timezone of ['UTC', 'Asia/Tokyo', 'America/New_York', 'Australia/Sydney']) {
    for (const date of ['2026-01-05', '2026-03-29', '2026-08-05', '2026-11-01']) {
      const instant = localHourToUtc(date, 22, timezone);
      assert.equal(localDateStr(timezone, instant), date, `${timezone} ${date} の日付`);
      assert.equal(isPastLocal22(timezone, instant), true, `${timezone} ${date} の時刻`);
    }
  }
});

test('ローカル日付は YYYY-MM-DD でタイムゾーンごとに求まる', () => {
  assert.equal(localDateStr('UTC', utc(22, 0)), '2026-08-15');
  // UTC 22:00 は Asia/Tokyo では翌日の 07:00
  assert.equal(localDateStr('Asia/Tokyo', utc(22, 0)), '2026-08-16');
  // UTC 01:00 は America/New_York では前日の 21:00
  assert.equal(localDateStr('America/New_York', utc(1, 0)), '2026-08-14');
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
