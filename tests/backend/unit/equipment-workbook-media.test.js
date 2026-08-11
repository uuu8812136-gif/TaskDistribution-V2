'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const XLSX = require('../../../app/node_modules/xlsx');
const {
  JPEG_TRAILING_DATA_SANITIZATION,
  MAX_JPEG_TRAILING_BYTES,
  drawingAnchorCell,
  extractEquipmentWorkbookMedia,
  relationshipMap,
  resolveRelationshipTarget,
  rowKey,
  sanitizeWorkbookJpegTrailingData
} = require('../../../app/services/equipmentWorkbookMediaExtractor');

const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0'),
  Buffer.alloc(12, 0x01),
  Buffer.from([0xff, 0xd9])
]);

function workbookWithWpsMedia({ imageRef, mediaPath, mediaBytes }) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([['图片'], ['']]);
  worksheet.A2 = {
    t: 's',
    v: `=DISPIMG("${imageRef}",1)`,
    f: `DISPIMG("${imageRef}",1)`
  };
  XLSX.utils.book_append_sheet(workbook, worksheet, '设备');
  const packageFile = XLSX.CFB.read(
    XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    { type: 'buffer' }
  );
  XLSX.CFB.utils.cfb_add(packageFile, '/xl/cellimages.xml', Buffer.from([
    '<etc:cellImages xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData"',
    ' xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"',
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<etc:cellImage><xdr:pic>',
    `<xdr:nvPicPr><xdr:cNvPr id="1" name="${imageRef}"/></xdr:nvPicPr>`,
    '<xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill>',
    '</xdr:pic></etc:cellImage></etc:cellImages>'
  ].join('')));
  XLSX.CFB.utils.cfb_add(
    packageFile,
    '/xl/_rels/cellimages.xml.rels',
    Buffer.from([
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      `<Relationship Id="rId1" Target="media/${mediaPath}"/>`,
      '</Relationships>'
    ].join(''))
  );
  XLSX.CFB.utils.cfb_add(packageFile, `/xl/media/${mediaPath}`, mediaBytes);
  return XLSX.CFB.write(packageFile, { type: 'buffer', fileType: 'zip' });
}

test('workbook media relationships resolve package-relative paths', () => {
  const relationships = relationshipMap(Buffer.from([
    '<?xml version="1.0"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Target="../media/image1.jpeg"/>',
    '</Relationships>'
  ].join('')), 'fixture relationships');

  assert.equal(relationships.get('rId1'), '../media/image1.jpeg');
  assert.equal(
    resolveRelationshipTarget('xl/drawings/drawing1.xml', relationships.get('rId1')),
    'xl/media/image1.jpeg'
  );
});

test('drawing anchors retain their exact source column and cell address', () => {
  assert.deepEqual(drawingAnchorCell({ from: { row: '2', col: '5' } }, '设备'), {
    rowNumber: 3,
    columnNumber: 6,
    cellAddress: 'F3'
  });
  assert.throws(
    () => drawingAnchorCell({ from: { row: '2' } }, '设备'),
    /Drawing anchor is incomplete/
  );
});

test('WPS DISPIMG cells map to their packaged image bytes and source row', () => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([['图片'], ['']]);
  worksheet.A2 = {
    t: 's',
    v: '=DISPIMG("ID_TEST_IMAGE",1)',
    f: 'DISPIMG("ID_TEST_IMAGE",1)'
  };
  XLSX.utils.book_append_sheet(workbook, worksheet, '设备');
  const packageFile = XLSX.CFB.read(
    XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    { type: 'buffer' }
  );
  XLSX.CFB.utils.cfb_add(packageFile, '/xl/cellimages.xml', Buffer.from([
    '<etc:cellImages xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData"',
    ' xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"',
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<etc:cellImage><xdr:pic>',
    '<xdr:nvPicPr><xdr:cNvPr id="1" name="ID_TEST_IMAGE"/></xdr:nvPicPr>',
    '<xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill>',
    '</xdr:pic></etc:cellImage></etc:cellImages>'
  ].join('')));
  XLSX.CFB.utils.cfb_add(
    packageFile,
    '/xl/_rels/cellimages.xml.rels',
    Buffer.from([
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Target="media/image99.png"/>',
      '</Relationships>'
    ].join(''))
  );
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4),
    Buffer.from('IHDR'),
    Buffer.alloc(8)
  ]);
  XLSX.CFB.utils.cfb_add(packageFile, '/xl/media/image99.png', pngBytes);
  const buffer = XLSX.CFB.write(packageFile, { type: 'buffer', fileType: 'zip' });

  const extracted = extractEquipmentWorkbookMedia(buffer);
  const images = extracted.imagesByRow.get(rowKey('设备', 2));
  assert.equal(images.length, 1);
  assert.equal(images[0].imageRef, 'ID_TEST_IMAGE');
  assert.equal(images[0].cellAddress, 'A2');
  assert.equal(images[0].mimeType, 'image/png');
  assert.deepEqual(images[0].buffer, pngBytes);
  assert.deepEqual(extracted.summary, {
    wpsImageDefinitions: 1,
    wpsCellReferences: 1,
    uniqueWpsImageReferences: 1,
    unusedWpsImageDefinitions: [],
    drawingImages: 0,
    rowsWithImages: 1,
    referencedMediaBytes: pngBytes.length,
    sanitizedMediaFiles: 0,
    sanitizedMediaReferences: 0,
    sanitizedBytesRemoved: 0,
    sanitizedMediaPaths: [],
    invalidMediaFiles: 0,
    invalidMediaReferences: 0,
    invalidMediaPaths: []
  });
});

test('WPS JPEG trailing data is stripped and reported without invalidating the image', () => {
  const trailingBytes = Buffer.alloc(24, 0xa5);
  const originalBytes = Buffer.concat([JPEG_BYTES, trailingBytes]);
  const extracted = extractEquipmentWorkbookMedia(workbookWithWpsMedia({
    imageRef: 'ID_WPS_TRAILING_JPEG',
    mediaPath: 'wps-trailing.jpeg',
    mediaBytes: originalBytes
  }));
  const image = extracted.imagesByRow.get(rowKey('设备', 2))[0];

  assert.equal(image.isValid, true);
  assert.equal(image.validationError, null);
  assert.deepEqual(image.buffer, JPEG_BYTES);
  assert.equal(image.sanitizationType, JPEG_TRAILING_DATA_SANITIZATION);
  assert.equal(image.originalByteLength, originalBytes.length);
  assert.equal(image.normalizedByteLength, JPEG_BYTES.length);
  assert.equal(image.removedTrailingBytes, 24);
  assert.equal(extracted.summary.sanitizedMediaFiles, 1);
  assert.equal(extracted.summary.sanitizedMediaReferences, 1);
  assert.equal(extracted.summary.sanitizedBytesRemoved, 24);
  assert.deepEqual(extracted.summary.sanitizedMediaPaths, ['xl/media/wps-trailing.jpeg']);
  assert.equal(extracted.summary.invalidMediaFiles, 0);
  assert.equal(extracted.summary.invalidMediaReferences, 0);
});

test('JPEG normalization rejects content without an EOI marker', () => {
  const withoutEoi = Buffer.concat([
    JPEG_BYTES.subarray(0, JPEG_BYTES.length - 2),
    Buffer.alloc(24, 0xa5)
  ]);
  assert.equal(sanitizeWorkbookJpegTrailingData(withoutEoi), null);

  const extracted = extractEquipmentWorkbookMedia(workbookWithWpsMedia({
    imageRef: 'ID_WPS_NO_EOI',
    mediaPath: 'no-eoi.jpeg',
    mediaBytes: withoutEoi
  }));
  const image = extracted.imagesByRow.get(rowKey('设备', 2))[0];
  assert.equal(image.isValid, false);
  assert.equal(image.buffer, null);
  assert.equal(extracted.summary.sanitizedMediaFiles, 0);
  assert.equal(extracted.summary.invalidMediaFiles, 1);
});

test('JPEG normalization rejects trailing data beyond the 64-byte limit', () => {
  const excessiveTrailingBytes = Buffer.concat([
    JPEG_BYTES,
    Buffer.alloc(MAX_JPEG_TRAILING_BYTES + 1, 0xa5)
  ]);
  assert.equal(sanitizeWorkbookJpegTrailingData(excessiveTrailingBytes), null);

  const extracted = extractEquipmentWorkbookMedia(workbookWithWpsMedia({
    imageRef: 'ID_WPS_EXCESSIVE_TRAILING_JPEG',
    mediaPath: 'excessive-trailing.jpeg',
    mediaBytes: excessiveTrailingBytes
  }));
  const image = extracted.imagesByRow.get(rowKey('设备', 2))[0];
  assert.equal(image.isValid, false);
  assert.equal(image.buffer, null);
  assert.equal(extracted.summary.sanitizedMediaFiles, 0);
  assert.equal(extracted.summary.invalidMediaFiles, 1);
});

test('invalid embedded media is reported without aborting workbook extraction', () => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([['图片'], ['']]);
  worksheet.A2 = {
    t: 's',
    v: '=DISPIMG("ID_INVALID_IMAGE",1)',
    f: 'DISPIMG("ID_INVALID_IMAGE",1)'
  };
  XLSX.utils.book_append_sheet(workbook, worksheet, '设备');
  const packageFile = XLSX.CFB.read(
    XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    { type: 'buffer' }
  );
  XLSX.CFB.utils.cfb_add(packageFile, '/xl/cellimages.xml', Buffer.from([
    '<etc:cellImages xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData"',
    ' xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"',
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<etc:cellImage><xdr:pic>',
    '<xdr:nvPicPr><xdr:cNvPr id="1" name="ID_INVALID_IMAGE"/></xdr:nvPicPr>',
    '<xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill>',
    '</xdr:pic></etc:cellImage></etc:cellImages>'
  ].join('')));
  XLSX.CFB.utils.cfb_add(
    packageFile,
    '/xl/_rels/cellimages.xml.rels',
    Buffer.from([
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '<Relationship Id="rId1" Target="media/invalid.png"/>',
      '</Relationships>'
    ].join(''))
  );
  XLSX.CFB.utils.cfb_add(
    packageFile,
    '/xl/media/invalid.png',
    Buffer.from('not-a-real-png')
  );
  const extracted = extractEquipmentWorkbookMedia(
    XLSX.CFB.write(packageFile, { type: 'buffer', fileType: 'zip' })
  );
  const image = extracted.imagesByRow.get(rowKey('设备', 2))[0];
  assert.equal(image.isValid, false);
  assert.equal(image.buffer, null);
  assert.match(image.validationError, /does not match/);
  assert.equal(extracted.summary.invalidMediaFiles, 1);
  assert.equal(extracted.summary.invalidMediaReferences, 1);
});
