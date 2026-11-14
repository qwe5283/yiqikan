const DEFAULT_MAX_FILE_SIZE = 2 * 1024 ** 3;

function readMaxFileSize(value = process.env.MAX_FILE_SIZE_BYTES) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_FILE_SIZE;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error('MAX_FILE_SIZE_BYTES 必须是正整数（单位：字节）');
  }
  return size;
}

function fileSizeLabel(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toFixed(2))} ${units[unit]}`;
}

module.exports = { DEFAULT_MAX_FILE_SIZE, readMaxFileSize, fileSizeLabel };
