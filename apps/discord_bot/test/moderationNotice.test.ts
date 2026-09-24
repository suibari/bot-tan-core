import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canModerate,
  moderationCustomId,
  noticeFooter,
  overrideResultLine,
  parseModerationCustomId,
  parseNoticeSubject,
} from '../src/moderationNotice.js';

const POST_URI = 'at://did:plc:abcdefghijklmnopqrstuvwx/com.suibari.nagi.post/3lbcdefghijkl';
const CID = 'bafyreih5ffa2cglu6twb35yrymaqpcjuyqjb6frh4qfzy7kvvbvilskcbi';

test('custom ids fit Discord and carry only the action', () => {
  const id = moderationCustomId('allow');
  assert.ok(id.length <= 100);
  assert.deepEqual(parseModerationCustomId(id), { action: 'allow' });
});

test('foreign or unknown custom ids are ignored', () => {
  assert.equal(parseModerationCustomId('other:allow'), null);
  assert.equal(parseModerationCustomId('mod:ban'), null);
  // 旧形式（URI 入り）のボタンは cid を持たないので受け付けない。
  assert.equal(parseModerationCustomId(`mod:allow:${POST_URI}`), null);
});

test('the notice footer round-trips the judged uri and cid', () => {
  assert.deepEqual(parseNoticeSubject(noticeFooter(POST_URI, CID)), { uri: POST_URI, cid: CID });
  // プロフィールの cid は内容の sha256（hex）。
  const hash = 'a'.repeat(64);
  assert.deepEqual(parseNoticeSubject(noticeFooter('at://did:plc:x/com.suibari.nagi.profile/self', hash))?.cid, hash);
});

test('footers that do not name a subject are rejected', () => {
  for (const footer of [undefined, null, '', 'hello', `subject: ${POST_URI}`, `subject: https://x ${CID}`, `subject: ${POST_URI} ${CID} extra`])
    assert.equal(parseNoticeSubject(footer), null);
});

test('only moderators or server managers can release', () => {
  assert.equal(canModerate({ roleIds: ['mod'], manageGuild: false }, 'mod'), true);
  assert.equal(canModerate({ roleIds: [], manageGuild: true }, 'mod'), true);
  assert.equal(canModerate({ roleIds: ['subscriber'], manageGuild: false }, 'mod'), false);
  // 専用ロール未設定なら、管理権限の無い人は誰も押せない。
  assert.equal(canModerate({ roleIds: ['subscriber'], manageGuild: false }, undefined), false);
});

test('result lines tell the operator what did and did not come back', () => {
  assert.match(overrideResultLine({ status: 'restored' }, 'a'), /返信は戻りません/);
  assert.match(overrideResultLine({ status: 'restored', cidChanged: true }, 'a'), /改めて判定/);
  assert.match(overrideResultLine({ status: 'absent' }, 'a'), /削除されています/);
  assert.match(overrideResultLine({ status: 'stale' }, 'a'), /新しい通知/);
});
