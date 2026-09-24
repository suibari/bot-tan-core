import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CUSTOM_ID_MAX,
  canModerate,
  moderationCustomId,
  overrideResultLine,
  parseModerationCustomId,
} from '../src/moderationNotice.js';

const POST_URI = 'at://did:plc:abcdefghijklmnopqrstuvwx/com.suibari.nagi.post/3lbcdefghijkl';

test('custom ids round-trip for ordinary Nagi post URIs', () => {
  const id = moderationCustomId('allow', POST_URI);
  assert.ok(id && id.length <= CUSTOM_ID_MAX);
  assert.deepEqual(parseModerationCustomId(id!), { action: 'allow', uri: POST_URI });
});

test('URIs too long for a custom id get no button', () => {
  assert.equal(moderationCustomId('allow', `at://did:web:${'x'.repeat(100)}/a/b`), null);
});

test('foreign or malformed custom ids are ignored', () => {
  assert.equal(parseModerationCustomId('other:allow:at://x'), null);
  assert.equal(parseModerationCustomId('mod:ban:at://x'), null);
  assert.equal(parseModerationCustomId('mod:allow:https://example.com'), null);
  assert.equal(parseModerationCustomId('mod:allow'), null);
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
});
