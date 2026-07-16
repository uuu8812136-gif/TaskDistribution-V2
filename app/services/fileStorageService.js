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
  const normalized = path.basename(value.replace(/[\u0000-\u001f\u007f]/g, '')).trim();
  if (!normalized || normalized.length > 255) {
    throw new TypeError('originalName must contain between 1 and 255 characters');
  }
  return normalized;
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
  validatedExtension
};
