const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createIceServers } = require('../lib/turn');

test('未配置 TURN 时保留公共 STUN', () => {
  assert.deepEqual(createIceServers({ secret: '', host: '' }), [
    { urls: ['stun:stun.l.google.com:19302'] },
  ]);
});

test('TURN 使用自有 STUN、UDP/TCP 中继和短期 HMAC 凭据', () => {
  const now = 1_700_000_000_000;
  const [stun, turn] = createIceServers({
    secret: 'test-secret', host: 'turn.example.com', port: 3478, ttl: 600, now,
  });
  assert.deepEqual(stun, { urls: ['stun:turn.example.com:3478'] });
  assert.deepEqual(turn.urls, [
    'turn:turn.example.com:3478?transport=udp',
    'turn:turn.example.com:3478?transport=tcp',
  ]);
  const [expiry, label] = turn.username.split(':');
  assert.equal(Number(expiry), now / 1000 + 600);
  assert.match(label, /^[a-f0-9]{12}$/);
  assert.ok(Number(expiry) > now / 1000);
  const expected = crypto.createHmac('sha1', 'test-secret').update(turn.username).digest('base64');
  assert.equal(turn.credential, expected);
});

test('拒绝不完整或无效的 TURN 配置', () => {
  assert.throws(() => createIceServers({ secret: 'only-secret', host: '' }), /同时配置/);
  assert.throws(() => createIceServers({ secret: 'secret', host: 'bad/host' }), /域名或 IPv4/);
  assert.throws(() => createIceServers({ secret: 'secret', host: 'turn.example.com', port: 0 }), /TURN_PORT/);
  assert.throws(() => createIceServers({ secret: 'secret', host: 'turn.example.com', ttl: 60 }), /300/);
});
