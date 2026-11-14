const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createUploadStore } = require('../lib/uploads');

function md5Of(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yiqikan-upload-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const tempDir = path.join(root, 'tmp');
  const uploadDir = path.join(root, 'media');
  await fs.promises.mkdir(tempDir, { recursive: true });
  await fs.promises.mkdir(uploadDir, { recursive: true });
  const options = {
    tempDir,
    uploadDir,
    maxFileSize: 1024,
    maxFileSizeLabel: '1 KiB',
    chunkSize: 4,
    allowedExtensions: ['.mp4', '.mp3'],
  };
  const store = createUploadStore(options);
  return { root, tempDir, uploadDir, store, options };
}

function append(store, uploadId, offset, buffer) {
  return store.append({
    uploadId,
    offset,
    contentLength: buffer.length,
    body: Readable.from([buffer]),
  });
}

test('分片中断后按服务端实际偏移续传，完成接口可重复调用', async (t) => {
  const { uploadDir, store, options } = await fixture(t);
  const content = Buffer.from('abcdefghij');
  const md5 = md5Of(content);
  let session = await store.init({ md5, name: 'demo.mp4', size: content.length });
  assert.equal(session.uploadId, md5);
  assert.equal(session.offset, 0);

  await append(store, md5, 0, Buffer.from('abcd'));
  let sent = false;
  const interruptedBody = new Readable({
    read() {
      if (sent) return this.destroy(new Error('模拟断线'));
      sent = true;
      this.push(Buffer.from('ef'));
    },
  });
  await assert.rejects(
    store.append({ uploadId: md5, offset: 4, contentLength: 4, body: interruptedBody }),
    (error) => error.code === 'CHUNK_INCOMPLETE' && error.offset >= 4 && error.offset <= 6,
  );

  const restartedStore = createUploadStore(options);
  session = await restartedStore.init({ md5, name: 'demo.mp4', size: content.length });
  assert.ok(session.offset >= 4 && session.offset <= 6);
  while (session.offset < content.length) {
    const end = Math.min(session.offset + session.chunkSize, content.length);
    const accepted = await append(restartedStore, md5, session.offset, content.subarray(session.offset, end));
    session = { ...session, ...accepted };
  }
  assert.equal(session.offset, 10);

  const completed = await restartedStore.complete(md5);
  assert.equal(completed.md5, md5);
  assert.equal(completed.extension, '.mp4');
  assert.deepEqual(await fs.promises.readFile(completed.path), content);
  assert.equal(path.dirname(completed.path), uploadDir);
  assert.equal((await restartedStore.complete(md5)).path, completed.path);
  assert.equal((await restartedStore.init({ md5, name: 'demo.mp4', size: content.length })).published.path, completed.path);
});

test('过期偏移不会写入，未收完整时不能发布', async (t) => {
  const { tempDir, store } = await fixture(t);
  const content = Buffer.from('abcdefghij');
  const md5 = md5Of(content);
  await store.init({ md5, name: 'demo.mp4', size: content.length });

  await assert.rejects(
    append(store, md5, 2, Buffer.from('cd')),
    (error) => error.status === 409 && error.code === 'OFFSET_MISMATCH' && error.offset === 0,
  );
  await append(store, md5, 0, Buffer.from('abcd'));
  await assert.rejects(
    store.complete(md5),
    (error) => error.status === 409 && error.code === 'UPLOAD_INCOMPLETE' && error.offset === 4,
  );
  assert.equal((await fs.promises.stat(path.join(tempDir, `${md5}.part`))).size, 4);
});

test('最终 MD5 不匹配会清理会话且不会发布媒体', async (t) => {
  const { tempDir, uploadDir, store } = await fixture(t);
  const content = Buffer.from('abcdefghij');
  const md5 = md5Of(Buffer.from('不同内容'));
  await store.init({ md5, name: 'demo.mp4', size: content.length });
  await append(store, md5, 0, content.subarray(0, 4));
  await append(store, md5, 4, content.subarray(4, 8));
  await append(store, md5, 8, content.subarray(8));

  await assert.rejects(store.complete(md5), (error) => error.code === 'MD5_MISMATCH');
  await assert.rejects(fs.promises.stat(path.join(tempDir, `${md5}.json`)), { code: 'ENOENT' });
  await assert.rejects(fs.promises.stat(path.join(tempDir, `${md5}.part`)), { code: 'ENOENT' });
  assert.deepEqual(await fs.promises.readdir(uploadDir), []);
});

test('同一文件的并发分片串行落盘，后到的旧偏移收到 409', async (t) => {
  const { store } = await fixture(t);
  const content = Buffer.from('abcdefghij');
  const md5 = md5Of(content);
  await store.init({ md5, name: 'demo.mp4', size: content.length });

  const results = await Promise.allSettled([
    append(store, md5, 0, Buffer.from('abcd')),
    append(store, md5, 0, Buffer.from('abcd')),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'OFFSET_MISMATCH');
  assert.equal(rejected.reason.offset, 4);
});

test('只清理过期的未完成会话', async (t) => {
  const { tempDir, store } = await fixture(t);
  const content = Buffer.from('abcdefghij');
  const expiredMd5 = md5Of(content);
  const activeMd5 = md5Of(Buffer.from('active-file'));
  await store.init({ md5: expiredMd5, name: 'old.mp4', size: content.length });
  await store.init({ md5: activeMd5, name: 'active.mp4', size: 11 });
  const oldPart = path.join(tempDir, `${expiredMd5}.part`);
  const oldDate = new Date(Date.now() - 60_000);
  await fs.promises.utimes(oldPart, oldDate, oldDate);

  await store.cleanup(1000);
  await assert.rejects(fs.promises.stat(oldPart), { code: 'ENOENT' });
  await assert.rejects(fs.promises.stat(path.join(tempDir, `${expiredMd5}.json`)), { code: 'ENOENT' });
  await fs.promises.stat(path.join(tempDir, `${activeMd5}.json`));
  await fs.promises.stat(path.join(tempDir, `${activeMd5}.part`));
});
