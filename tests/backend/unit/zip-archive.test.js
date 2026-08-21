'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const {
  extractPaymentReceiptEntries,
  extractZipEntries
} = require('../../../app/services/zipArchiveService');

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

test('extracts payment receipts as valid PDF/JPG/JPEG/PNG files only', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  const archive = zipFile([
    { name: 'SUP-001__RENT-1.pdf', content: '%PDF-1.7\n%%EOF' },
    { name: 'SUP-001__RENT-2.JPG', content: jpeg, deflate: true },
    { name: 'SUP-001__RENT-3.jpeg', content: jpeg },
    { name: 'SUP-001__RENT-4.PNG', content: png }
  ]);
  const entries = extractPaymentReceiptEntries(archive);
  assert.deepEqual(entries.map((entry) => [entry.extension, entry.mimeType]), [
    ['.pdf', 'application/pdf'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png']
  ]);
});

test('rejects unsupported, malformed, and unsafe payment receipt entries', () => {
  assert.throws(() => extractPaymentReceiptEntries(zipFile([
    { name: 'receipt.txt', content: 'not an attachment' }
  ])), { code: 'CONTRACT_PAYMENT_ZIP_UNSUPPORTED' });
  assert.throws(() => extractPaymentReceiptEntries(zipFile([
    { name: 'receipt.jpg', content: 'not a jpeg' }
  ])), { code: 'CONTRACT_PAYMENT_FILE_INVALID' });
  assert.throws(() => extractPaymentReceiptEntries(zipFile([
    { name: 'receipt.pdf', content: '%PDF-1.7\nmissing eof' }
  ])), { code: 'CONTRACT_PDF_FILE_INVALID' });
  assert.throws(() => extractPaymentReceiptEntries(zipFile([
    { name: 'safe.png', content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }
  ], { traversal: true })), { code: 'CONTRACT_PDF_ZIP_PATH_INVALID' });
});
