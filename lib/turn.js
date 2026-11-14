const crypto = require('node:crypto');

function createIceServers(options = {}) {
  const secret = options.secret ?? process.env.TURN_SECRET ?? '';
  const host = options.host ?? process.env.TURN_HOST ?? '';
  const port = Number(options.port ?? process.env.TURN_PORT ?? 3478);
  const ttl = Number(options.ttl ?? process.env.TURN_CREDENTIAL_TTL_SECONDS ?? 86400);
  const now = options.now ?? Date.now();
  if (!secret && !host) return [{ urls: ['stun:stun.l.google.com:19302'] }];
  if (!secret || !host) throw new Error('TURN_HOST 与 TURN_SECRET 必须同时配置');
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('TURN_HOST 必须是域名或 IPv4 地址');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('TURN_PORT 无效');
  if (!Number.isSafeInteger(ttl) || ttl < 300 || ttl > 604800) {
    throw new Error('TURN_CREDENTIAL_TTL_SECONDS 需为 300–604800 秒');
  }

  const username = `${Math.floor(now / 1000) + ttl}:${crypto.randomBytes(6).toString('hex')}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return [
    { urls: [`stun:${host}:${port}`] },
    {
      urls: [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`],
      username,
      credential,
    },
  ];
}

module.exports = { createIceServers };
