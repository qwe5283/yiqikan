const crypto = require('node:crypto');
const path = require('node:path');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac']);

function cleanFileName(value) {
  return path.basename(String(value || '未命名媒体')).replace(/[\0\r\n]/g, '').trim().slice(0, 120) || '未命名媒体';
}

function mediaFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('请输入媒体 URL');
  if (raw.length > 2048) throw new Error('媒体 URL 不能超过 2048 个字符');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('请输入有效的媒体 URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('仅支持 HTTP 或 HTTPS 媒体链接');
  }
  if (parsed.username || parsed.password) {
    throw new Error('媒体链接不能包含账号或密码');
  }

  let name = path.posix.basename(parsed.pathname) || parsed.hostname;
  try {
    name = decodeURIComponent(name);
  } catch {
    // 文件名含有未转义的 % 时保留原样，不影响链接本身。
  }
  const url = parsed.href;
  return {
    id: crypto.createHash('sha256').update(url).digest('hex'),
    url,
    name: cleanFileName(name),
    size: null,
    kind: AUDIO_EXTENSIONS.has(path.posix.extname(parsed.pathname).toLowerCase()) ? 'audio' : 'video',
    source: 'url',
  };
}

module.exports = { cleanFileName, mediaFromUrl };
