const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanFileName, mediaFromUrl } = require('../lib/media-url');

test('URL 媒体保留完整直链并从路径生成名称和类型', () => {
  const media = mediaFromUrl(' https://example.com/media/%E6%B5%8B%E8%AF%95.mp3?token=abc ');
  assert.equal(media.url, 'https://example.com/media/%E6%B5%8B%E8%AF%95.mp3?token=abc');
  assert.equal(media.name, '测试.mp3');
  assert.equal(media.kind, 'audio');
  assert.equal(media.source, 'url');
  assert.equal(media.size, null);
  assert.match(media.id, /^[a-f0-9]{64}$/);
  assert.equal(media.id, mediaFromUrl(media.url).id);
});

test('无扩展名的 URL 默认作为视频并使用最后一段路径命名', () => {
  const media = mediaFromUrl('https://example.com/watch?id=1');
  assert.equal(media.name, 'watch');
  assert.equal(media.kind, 'video');
});

test('拒绝空、无效、非 HTTP 或带凭据的媒体 URL', () => {
  for (const value of ['', 'not a url', 'ftp://example.com/movie.mp4', 'file:///movie.mp4', 'https://user:pass@example.com/movie.mp4']) {
    assert.throws(() => mediaFromUrl(value));
  }
  assert.throws(() => mediaFromUrl(`https://example.com/${'a'.repeat(2048)}`), /2048/);
});

test('媒体文件名清理路径和控制字符并限制长度', () => {
  assert.equal(cleanFileName('../folder/movie.mp4'), 'movie.mp4');
  assert.equal(cleanFileName('bad\r\nname.mp4'), 'badname.mp4');
  assert.equal(cleanFileName(''), '未命名媒体');
  assert.equal(cleanFileName('a'.repeat(150)).length, 120);
});
