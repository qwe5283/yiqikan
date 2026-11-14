const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCode,
  cleanNickname,
  playbackPosition,
  playbackSnapshot,
  appendMessage,
} = require('../lib/rooms');

test('房间码为 4 位字母或数字且避开现有房间', () => {
  const first = createCode();
  assert.match(first, /^[A-Z2-9]{4}$/);
  assert.notEqual(createCode(new Set([first])), first);
});

test('昵称清理空白并限制长度', () => {
  assert.equal(cleanNickname('  小   李  '), '小 李');
  assert.throws(() => cleanNickname('  '));
  assert.throws(() => cleanNickname('太'.repeat(17)));
});

test('播放位置只在播放时随时间前进', () => {
  const now = 10_000;
  assert.equal(playbackPosition({ currentTime: 8, paused: true, updatedAt: 8_000 }, now), 8);
  assert.equal(playbackPosition({ currentTime: 8, paused: false, updatedAt: 8_000 }, now), 10);
  const room = { playback: { mediaId: 'a', currentTime: 8, paused: false, updatedAt: 8_000 } };
  assert.deepEqual(playbackSnapshot(room, now), {
    mediaId: 'a', currentTime: 10, paused: false, updatedAt: now,
  });
});

test('消息历史保留最近 200 条', () => {
  const room = { messages: [] };
  for (let index = 0; index < 205; index += 1) {
    appendMessage(room, { kind: 'user', text: String(index) });
  }
  assert.equal(room.messages.length, 200);
  assert.equal(room.messages[0].text, '5');
  assert.equal(room.messages.at(-1).text, '204');
});
