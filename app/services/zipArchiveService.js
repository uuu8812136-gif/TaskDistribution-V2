'use strict';

const path = require('node:path');
const zlib = require('node:zlib');

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const MAX_ENTRIES = 500;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

class ZipArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipArchiveError';
    this.code = code;
    this.status = 400;
    this.expose = true;
  }
}

function zipError(code, message) {
  return new ZipArchiveError(code, message);
}

function findEndRecord(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_SIGNATURE) return offset;
  }
  throw zipError('CONTRACT_PDF_ZIP_INVALID', '无法读取ZIP文件目录');
}

function decodeEntryName(buffer, flags) {
  if (flags & 0x800) return buffer.toString('utf8');
  return buffer.toString('utf8');
}

function safeEntryName(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/')) return null;
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw zipError('CONTRACT_PDF_ZIP_PATH_INVALID', 'ZIP内含有不安全的文件路径');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw zipError('CONTRACT_PDF_ZIP_PATH_INVALID', 'ZIP内含有不安全的文件路径');
  }
  const basename = path.posix.basename(normalized);
  return basename;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function readCentralEntries(buffer) {
  const endOffset = findEndRecord(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw zipError('CONTRACT_PDF_ZIP_UNSUPPORTED', '不支持分卷ZIP文件');
  }
  if (entryCount > MAX_ENTRIES) {
    throw zipError('CONTRACT_PDF_ZIP_TOO_MANY_FILES', `ZIP内文件不能超过${MAX_ENTRIES}个`);
  }
  if (centralOffset + centralSize > buffer.length || centralOffset < 0) {
    throw zipError('CONTRACT_PDF_ZIP_INVALID', 'ZIP目录范围无效');
  }
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw zipError('CONTRACT_PDF_ZIP_INVALID', 'ZIP目录记录无效');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > buffer.length) {
      throw zipError('CONTRACT_PDF_ZIP_INVALID', 'ZIP目录记录超出文件范围');
    }
    const name = safeEntryName(decodeEntryName(
      buffer.subarray(offset + 46, offset + 46 + nameLength), flags
    ));
    if (name) entries.push({
      name,
      flags,
      compression,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset
    });
    offset = recordEnd;
  }
  return entries;
}

function extractZipEntriesWithPolicy(buffer, {
  allowedExtensions,
  emptyCode,
  emptyMessage,
  fileTooLargeCode,
  invalidFileCode,
  validateContent,
  unsupportedCode,
  unsupportedMessage
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw zipError('CONTRACT_PDF_ZIP_INVALID', '请选择有效的ZIP文件');
  }
  const entries = readCentralEntries(buffer);
  let totalBytes = 0;
  const extracted = [];
  for (const entry of entries) {
    if ((entry.flags & 0x1) !== 0) {
      throw zipError('CONTRACT_PDF_ZIP_UNSUPPORTED', 'ZIP内不支持加密文件');
    }
    if (entry.compression !== 0 && entry.compression !== 8) {
      throw zipError('CONTRACT_PDF_ZIP_UNSUPPORTED', 'ZIP内含有不支持的压缩格式');
    }
    if (entry.uncompressedSize > 20 * 1024 * 1024) {
      throw zipError(fileTooLargeCode, `文件“${entry.name}”不能超过20MB`);
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw zipError('CONTRACT_PDF_ZIP_TOO_LARGE', 'ZIP解压后的文件总量不能超过200MB');
    }
    const extension = path.posix.extname(entry.name).toLocaleLowerCase('en-US');
    if (!allowedExtensions.has(extension)) {
      if (unsupportedCode) throw zipError(unsupportedCode, unsupportedMessage);
      continue;
    }
    if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== ZIP_LOCAL_SIGNATURE) {
      throw zipError('CONTRACT_PDF_ZIP_INVALID', `文件“${entry.name}”的本地记录无效`);
    }
    const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < 0 || dataEnd > buffer.length) {
      throw zipError('CONTRACT_PDF_ZIP_INVALID', `文件“${entry.name}”的数据范围无效`);
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    let content;
    try {
      content = entry.compression === 0
        ? Buffer.from(compressed)
        : zlib.inflateRawSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
    } catch {
      throw zipError('CONTRACT_PDF_ZIP_INVALID', `文件“${entry.name}”无法解压`);
    }
    if (content.length !== entry.uncompressedSize || crc32(content) !== entry.crc) {
      throw zipError('CONTRACT_PDF_ZIP_INVALID', `文件“${entry.name}”校验失败`);
    }
    let metadata;
    try {
      metadata = validateContent(content, extension);
    } catch (error) {
      if (error instanceof ZipArchiveError) throw error;
      throw zipError(invalidFileCode, `文件“${entry.name}”内容无效`);
    }
    extracted.push({ name: entry.name, buffer: content, extension, ...metadata });
  }
  if (!extracted.length) {
    throw zipError(emptyCode, emptyMessage);
  }
  return extracted;
}

function validatePdfContent(content, extension) {
  if (extension !== '.pdf' || !content.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
    !content.subarray(Math.max(0, content.length - 1024)).includes(Buffer.from('%%EOF'))) {
    throw zipError('CONTRACT_PDF_FILE_INVALID', '文件不是有效的PDF');
  }
  return { mimeType: 'application/pdf' };
}

function extractZipEntries(buffer) {
  return extractZipEntriesWithPolicy(buffer, {
    allowedExtensions: new Set(['.pdf']),
    emptyCode: 'CONTRACT_PDF_ZIP_EMPTY',
    emptyMessage: 'ZIP内没有PDF文件',
    fileTooLargeCode: 'CONTRACT_PDF_FILE_TOO_LARGE',
    invalidFileCode: 'CONTRACT_PDF_FILE_INVALID',
    validateContent: validatePdfContent
  });
}

function validatePaymentReceiptContent(content, extension) {
  if (extension === '.pdf') return validatePdfContent(content, extension);
  if (extension === '.png' && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: 'image/png' };
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
      return { mimeType: 'image/jpeg' };
    }
  }
  throw zipError('CONTRACT_PAYMENT_FILE_INVALID', '文件不是有效的PDF或图片');
}

function extractPaymentReceiptEntries(buffer) {
  return extractZipEntriesWithPolicy(buffer, {
    allowedExtensions: new Set(['.pdf', '.jpg', '.jpeg', '.png']),
    emptyCode: 'CONTRACT_PAYMENT_ZIP_EMPTY',
    emptyMessage: 'ZIP内没有PDF或图片文件',
    fileTooLargeCode: 'CONTRACT_PAYMENT_FILE_TOO_LARGE',
    invalidFileCode: 'CONTRACT_PAYMENT_FILE_INVALID',
    unsupportedCode: 'CONTRACT_PAYMENT_ZIP_UNSUPPORTED',
    unsupportedMessage: '打款凭证ZIP内只允许PDF、JPG、JPEG或PNG文件',
    validateContent: validatePaymentReceiptContent
  });
}

module.exports = {
  MAX_ENTRIES,
  MAX_UNCOMPRESSED_BYTES,
  ZipArchiveError,
  extractZipEntries,
  extractPaymentReceiptEntries
};
