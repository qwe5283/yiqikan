const { randomInt, randomUUID } = require('node:crypto');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createCode(existing = new Set()) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
    if (!existing.has(code)) return code;
  }
  throw new Error('暂时无法分配房间码，请稍后重试');
}

function cleanNickname(value) {
  const nickname = String(value ?? '').trim().replace(/\s+/g, ' ');
  const length = [...nickname].length;
  if (!length || length > 16) throw new Error('昵称需为 1–16 个字符');
  return nickname;
}

function playbackPosition(playback, now = Date.now()) {
  const current = Math.max(0, Number(playback.currentTime) || 0);
  if (playback.paused) return current;
  return current + Math.max(0, now - playback.updatedAt) / 1000;
}

function playbackSnapshot(room, now = Date.now()) {
  return {
    ...room.playback,
    currentTime: playbackPosition(room.playback, now),
    updatedAt: now,
  };
}

function appendMessage(room, data) {
  const message = { id: randomUUID(), at: Date.now(), ...data };
  room.messages.push(message);
  if (room.messages.length > 200) room.messages.splice(0, room.messages.length - 200);
  return message;
}

function systemMessage(room, text) {
  return appendMessage(room, { kind: 'system', text });
}

module.exports = {
  createCode,
  cleanNickname,
  playbackPosition,
  playbackSnapshot,
  appendMessage,
  systemMessage,
};
