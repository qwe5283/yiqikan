const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_MAX_FILE_SIZE, readMaxFileSize, fileSizeLabel } = require('../lib/config');

test('上传大小默认 2 GiB并支持字节数环境变量', () => {
  assert.equal(DEFAULT_MAX_FILE_SIZE, 2_147_483_648);
  assert.equal(readMaxFileSize(undefined), DEFAULT_MAX_FILE_SIZE);
  assert.equal(readMaxFileSize('1048576'), 1_048_576);
});

test('拒绝无效上传大小配置', () => {
  for (const value of ['abc', '0', '-1', '1.5', '9007199254740992']) {
    assert.throws(() => readMaxFileSize(value), /正整数/);
  }
});

test('上传大小使用二进制单位显示', () => {
  assert.equal(fileSizeLabel(DEFAULT_MAX_FILE_SIZE), '2 GiB');
  assert.equal(fileSizeLabel(1536 * 1024), '1.5 MiB');
  assert.equal(fileSizeLabel(512), '512 B');
});
