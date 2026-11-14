const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
const MD5_PATTERN = /^[a-f0-9]{32}$/;

class UploadError extends Error {
  constructor(status, code, message, offset) {
    super(message);
    this.status = status;
    this.code = code;
    if (Number.isSafeInteger(offset)) this.offset = offset;
  }
}

function createUploadStore({
  tempDir,
  uploadDir,
  maxFileSize,
  maxFileSizeLabel,
  chunkSize = DEFAULT_CHUNK_SIZE,
  allowedExtensions,
}) {
  const extensions = new Set(allowedExtensions);
  const locks = new Map();

  function normalizeId(value) {
    const uploadId = String(value || '').toLowerCase();
    if (!MD5_PATTERN.test(uploadId)) throw new UploadError(400, 'INVALID_UPLOAD_ID', '无效的上传标识');
    return uploadId;
  }

  function cleanName(value) {
    return path.basename(String(value || '未命名媒体')).replace(/[\0\r\n]/g, '').trim().slice(0, 120) || '未命名媒体';
  }

  function paths(uploadId) {
    return {
      metadata: path.join(tempDir, `${uploadId}.json`),
      part: path.join(tempDir, `${uploadId}.part`),
    };
  }

  async function exclusive(uploadId, action) {
    const previous = locks.get(uploadId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    locks.set(uploadId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (locks.get(uploadId) === current) locks.delete(uploadId);
    }
  }

  async function statOrNull(filePath) {
    try {
      return await fs.promises.stat(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function unlinkIfPresent(filePath) {
    await fs.promises.unlink(filePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async function removeSession(uploadId) {
    const files = paths(uploadId);
    await Promise.all([unlinkIfPresent(files.metadata), unlinkIfPresent(files.part)]);
  }

  async function readSession(uploadId) {
    const { metadata } = paths(uploadId);
    let session;
    try {
      session = JSON.parse(await fs.promises.readFile(metadata, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
    if (
      session.md5 !== uploadId
      || !Number.isSafeInteger(session.size)
      || session.size <= 0
      || typeof session.name !== 'string'
      || !extensions.has(path.extname(session.name).toLowerCase())
    ) return null;
    return session;
  }

  async function writeSession(uploadId, session) {
    const { metadata } = paths(uploadId);
    const temporary = `${metadata}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(session), { flag: 'wx' });
    try {
      await fs.promises.rename(temporary, metadata);
    } finally {
      await unlinkIfPresent(temporary);
    }
  }

  async function findPublished(uploadId) {
    const names = await fs.promises.readdir(uploadDir);
    for (const extension of extensions) {
      const name = names.find((file) => file.toLowerCase() === `${uploadId}${extension}`);
      if (!name) continue;
      const filePath = path.join(uploadDir, name);
      const stat = await fs.promises.stat(filePath);
      return {
        md5: uploadId,
        name: `已上传媒体${extension}`,
        size: stat.size,
        extension,
        path: filePath,
      };
    }
    return null;
  }

  async function hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('md5');
      fs.createReadStream(filePath)
        .on('data', (chunk) => hash.update(chunk))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')));
    });
  }

  async function init({ md5, name, size }) {
    const uploadId = normalizeId(md5);
    const clean = cleanName(name);
    const extension = path.extname(clean).toLowerCase();
    if (!extensions.has(extension)) {
      throw new UploadError(415, 'UNSUPPORTED_MEDIA_TYPE', '格式暂不支持，请选择常见音视频文件');
    }
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new UploadError(400, 'INVALID_FILE_SIZE', '无效的文件大小');
    }
    if (size > maxFileSize) {
      throw new UploadError(413, 'FILE_TOO_LARGE', `单个文件不能超过 ${maxFileSizeLabel}`);
    }

    return exclusive(uploadId, async () => {
      const published = await findPublished(uploadId);
      if (published) {
        await removeSession(uploadId);
        return { uploadId, offset: published.size, chunkSize, published };
      }

      let session = await readSession(uploadId);
      if (session && session.size !== size) {
        throw new UploadError(409, 'UPLOAD_SIZE_MISMATCH', '同一文件的上传大小不一致，请重新选择文件');
      }
      const files = paths(uploadId);
      let stat = await statOrNull(files.part);
      if (session && stat && stat.size > session.size) {
        await removeSession(uploadId);
        session = null;
        stat = null;
      }
      if (!session) {
        session = { md5: uploadId, name: clean, size, createdAt: new Date().toISOString() };
        await fs.promises.writeFile(files.part, '', { flag: 'w' });
        await writeSession(uploadId, session);
        stat = await fs.promises.stat(files.part);
      } else if (!stat) {
        await fs.promises.writeFile(files.part, '', { flag: 'w' });
        stat = await fs.promises.stat(files.part);
      }
      return { uploadId, offset: stat.size, chunkSize };
    });
  }

  async function append({ uploadId: id, offset, contentLength, body }) {
    const uploadId = normalizeId(id);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new UploadError(400, 'INVALID_OFFSET', '无效的上传偏移');
    }
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      throw new UploadError(411, 'INVALID_CHUNK_LENGTH', '分片必须包含有效的 Content-Length');
    }
    if (contentLength > chunkSize) {
      throw new UploadError(413, 'CHUNK_TOO_LARGE', `单个分片不能超过 ${chunkSize} 字节`);
    }

    return exclusive(uploadId, async () => {
      const session = await readSession(uploadId);
      if (!session) throw new UploadError(404, 'UPLOAD_NOT_FOUND', '上传会话不存在或已过期');
      if (offset + contentLength > session.size) {
        throw new UploadError(416, 'CHUNK_OVERFLOW', '分片超出文件声明大小');
      }
      const { part } = paths(uploadId);
      const stat = await statOrNull(part);
      const currentOffset = stat ? stat.size : 0;
      if (offset !== currentOffset) {
        throw new UploadError(409, 'OFFSET_MISMATCH', '上传偏移已变化', currentOffset);
      }

      const output = fs.createWriteStream(part, { flags: 'a' });
      try {
        await pipeline(body, output);
      } catch (error) {
        if (error.code && !['ABORT_ERR', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code)) {
          throw error;
        }
        const actual = await statOrNull(part);
        throw new UploadError(400, 'CHUNK_INCOMPLETE', '分片接收中断，请重试', actual ? actual.size : 0);
      }
      const actual = await statOrNull(part);
      const nextOffset = actual ? actual.size : 0;
      if (nextOffset !== offset + contentLength) {
        throw new UploadError(400, 'CHUNK_INCOMPLETE', '分片接收不完整，请重试', nextOffset);
      }
      return { offset: nextOffset };
    });
  }

  async function complete(id) {
    const uploadId = normalizeId(id);
    return exclusive(uploadId, async () => {
      const session = await readSession(uploadId);
      if (!session) {
        const published = await findPublished(uploadId);
        if (published) return published;
        throw new UploadError(404, 'UPLOAD_NOT_FOUND', '上传会话不存在或已过期');
      }
      const files = paths(uploadId);
      const stat = await statOrNull(files.part);
      const offset = stat ? stat.size : 0;
      if (offset !== session.size) {
        throw new UploadError(409, 'UPLOAD_INCOMPLETE', '文件尚未上传完整', offset);
      }
      if (await hashFile(files.part) !== uploadId) {
        await removeSession(uploadId);
        throw new UploadError(400, 'MD5_MISMATCH', '文件校验失败，请重新上传');
      }

      const existing = await findPublished(uploadId);
      if (existing) {
        await removeSession(uploadId);
        return existing;
      }
      const extension = path.extname(session.name).toLowerCase();
      const target = path.join(uploadDir, `${uploadId}${extension}`);
      await fs.promises.rename(files.part, target);
      await unlinkIfPresent(files.metadata);
      return { md5: uploadId, name: session.name, size: session.size, extension, path: target };
    });
  }

  async function cleanup(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const names = await fs.promises.readdir(tempDir);
    const ids = new Set();
    for (const name of names) {
      const match = name.match(/^([a-f0-9]{32})\.(?:json|part)$/);
      if (match) ids.add(match[1]);
    }
    for (const uploadId of ids) {
      await exclusive(uploadId, async () => {
        const files = paths(uploadId);
        const [metadata, part] = await Promise.all([statOrNull(files.metadata), statOrNull(files.part)]);
        if (metadata && !part) await unlinkIfPresent(files.metadata);
        else if (!metadata && part && part.mtimeMs < cutoff) await unlinkIfPresent(files.part);
        else if (metadata && part && part.mtimeMs < cutoff) await removeSession(uploadId);
      });
    }
  }

  return { init, append, complete, cleanup };
}

module.exports = { DEFAULT_CHUNK_SIZE, UploadError, createUploadStore };
