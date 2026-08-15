'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { extractZipEntries } = require('../../../app/services/zipArchiveService');

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipFile(entries, { traversal = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [index, input] of entries.entries()) {
    const name = Buffer.from(traversal && index === 0 ? '../outside.pdf' : input.name, 'utf8');
    const content = Buffer.from(input.content);
    const compressed = input.deflate ? zlib.deflateRawSync(content) : content;
    const method = input.deflate ? 8 : 0;
    const crc = crc32(content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

test('extracts stored and deflated PDFs with CRC validation', () => {
  const archive = zipFile([
    { name: 'SUP-001__MAIN-1.pdf', content: '%PDF-1.7\n%%EOF' },
    { name: 'SUP-002__MAIN-2.PDF', content: '%PDF-1.7\nbody\n%%EOF', deflate: true },
    { name: 'README.txt', content: 'ignored' }
  ]);
  const entries = extractZipEntries(archive);
  assert.deepEqual(entries.map((entry) => entry.name), [
    'SUP-001__MAIN-1.pdf',
    'SUP-002__MAIN-2.PDF'
  ]);
  assert.equal(entries[1].buffer.toString(), '%PDF-1.7\nbody\n%%EOF');
});

test('rejects path traversal and non-PDF-only archives', () => {
  assert.throws(() => extractZipEntries(zipFile([
    { name: 'safe.pdf', content: '%PDF-1.7\n%%EOF' }
  ], { traversal: true })), (error) => error.code === 'CONTRACT_PDF_ZIP_PATH_INVALID');
  assert.throws(() => extractZipEntries(zipFile([
    { name: 'notes.txt', content: 'not a pdf' }
  ])), (error) => error.code === 'CONTRACT_PDF_ZIP_EMPTY');
});
