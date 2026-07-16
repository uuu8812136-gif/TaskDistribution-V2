'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': Object.freeze(['.jpg', '.jpeg']),
  'image/png': Object.freeze(['.png']),
  'image/gif': Object.freeze(['.gif']),
  'application/pdf': Object.freeze(['.pdf']),
  'application/msword': Object.freeze(['.doc']),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': Object.freeze(['.docx']),
  'application/vnd.ms-excel': Object.freeze(['.xls']),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': Object.freeze(['.xlsx']),
  'text/plain': Object.freeze(['.txt'])
});

const STORAGE_KEY_PATTERN = /^[0-9a-f]{24}\/\d{4}\/\d{2}\/[0-9a-f-]{36}(?:\.[a-z0-9]{1,16})?$/;

function normalizeTeamId(value) {
  const teamId = typeof value === 'string'
    ? value
    : value && typeof value.toHexString === 'function'
      ? value.toHexString()
      : '';
  if (!/^[0-9a-fA-F]{24}$/.test(teamId)) {
    throw new TypeError('A trusted team ObjectId is required');
  }
  return teamId.toLowerCase();
}

function normalizeOriginalName(value) {
  if (typeof value !== 'string') throw new TypeError('originalName is required');
  let decodedValue = value;
  if ([...value].every((character) => character.codePointAt(0) <= 0xff)) {
    const rawBytes = Buffer.from(value, 'latin1');
    const utf8Candidate = rawBytes.toString('utf8');
    if (
      !utf8Candidate.includes('\ufffd') &&
      Buffer.from(utf8Candidate, 'utf8').equals(rawBytes)
    ) {
      decodedValue = utf8Candidate;
    }
  }
  const withoutControls = decodedValue
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '/');
  const normalized = path.posix.basename(withoutControls).trim();
  if (!normalized || normalized.length > 255) {
    throw new TypeError('originalName must contain between 1 and 255 characters');
  }
  return normalized;
}

function startsWith(buffer, signature, offset = 0) {
  return buffer.length >= offset + signature.length &&
    buffer.subarray(offset, offset + signature.length).equals(signature);
}

function isZipContainer(buffer, requiredDirectory) {
  const zipSignatures = [
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.from([0x50, 0x4b, 0x07, 0x08])
  ];
  return zipSignatures.some((signature) => startsWith(buffer, signature)) &&
    buffer.includes(Buffer.from('[Content_Types].xml')) &&
    buffer.includes(Buffer.from(requiredDirectory));
}

function isPlainText(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function validateFileContent(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('Uploaded file is empty');
  }

  const validators = {
    'image/jpeg': (value) => (
      startsWith(value, Buffer.from([0xff, 0xd8, 0xff])) &&
      value.length >= 5 &&
      value.subarray(value.length - 2).equals(Buffer.from([0xff, 0xd9]))
    ),
    'image/png': (value) => (
      startsWith(value, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
      value.length >= 24 &&
      value.subarray(12, 16).equals(Buffer.from('IHDR'))
    ),
    'image/gif': (value) => startsWith(value, Buffer.from('GIF87a')) ||
      startsWith(value, Buffer.from('GIF89a')),
    'application/pdf': (value) => (
      startsWith(value, Buffer.from('%PDF-')) &&
      value.subarray(Math.max(0, value.length - 1024)).includes(Buffer.from('%%EOF'))
    ),
    'application/msword': (value) => startsWith(
      value,
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    ),
    'application/vnd.ms-excel': (value) => startsWith(
      value,
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    ),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (value) => (
      isZipContainer(value, 'word/')
    ),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (value) => (
      isZipContainer(value, 'xl/')
    ),
    'text/plain': isPlainText
  };

  const validator = validators[mimeType];
  if (!validator || !validator(buffer)) {
    throw new TypeError('File content does not match its declared MIME type');
  }
  return true;
}

function validatedExtension(originalName, mimeType) {
  const allowedExtensions = ALLOWED_MIME_EXTENSIONS[mimeType];
  if (!allowedExtensions) throw new TypeError('Unsupported file MIME type');
  const extension = path.extname(normalizeOriginalName(originalName)).toLowerCase();
  if (!allowedExtensions.includes(extension)) {
    throw new TypeError('File extension does not match its MIME type');
  }
  return extension;
}

function createStorageKey({
  teamId,
  originalName,
  mimeType,
  now = new Date(),
  id = crypto.randomUUID()
}) {
  const normalizedTeamId = normalizeTeamId(teamId);
  const extension = validatedExtension(originalName, mimeType);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new TypeError('Storage id must be a UUID');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${normalizedTeamId}/${year}/${month}/${id}${extension}`;
}

function resolveStoragePath(storageRoot, storageKey) {
  if (typeof storageKey !== 'string' || !STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new TypeError('Invalid file storage key');
  }
  const root = path.resolve(storageRoot);
  const target = path.resolve(root, ...storageKey.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError('File storage key escapes the configured storage root');
  }
  return target;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

module.exports = {
  ALLOWED_MIME_EXTENSIONS,
  STORAGE_KEY_PATTERN,
  createStorageKey,
  normalizeOriginalName,
  normalizeTeamId,
  resolveStoragePath,
  sha256File,
  validateFileContent,
  validatedExtension
};
