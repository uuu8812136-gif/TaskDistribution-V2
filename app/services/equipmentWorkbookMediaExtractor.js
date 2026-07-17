'use strict';

const path = require('node:path');
const XLSX = require('xlsx');
const { XMLParser } = require('fast-xml-parser');
const { validateFileContent } = require('./fileStorageService');

const MAX_MEDIA_FILE_BYTES = 40 * 1024 * 1024;
const MAX_REFERENCED_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_JPEG_TRAILING_BYTES = 64;
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const JPEG_TRAILING_DATA_SANITIZATION = 'JPEG_TRAILING_DATA_STRIPPED';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true
});

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseXml(buffer, label) {
  try {
    return xmlParser.parse(Buffer.from(buffer).toString('utf8'));
  } catch (error) {
    throw new TypeError(`Invalid ${label} XML: ${error.message}`);
  }
}

function zipEntry(zip, entryPath, { required = true } = {}) {
  const normalized = path.posix.normalize(`/${String(entryPath).replace(/^\/+/, '')}`);
  const entry = XLSX.CFB.find(zip, normalized);
  if (!entry) {
    if (!required) return null;
    throw new TypeError(`Workbook package entry is missing: ${normalized.slice(1)}`);
  }
  return Buffer.from(entry.content || []);
}

function relationshipsPath(partPath) {
  const directory = path.posix.dirname(partPath);
  return path.posix.join(directory, '_rels', `${path.posix.basename(partPath)}.rels`);
}

function resolveRelationshipTarget(partPath, target) {
  const value = String(target || '').replace(/\\/g, '/');
  if (!value) throw new TypeError(`Relationship target is missing for ${partPath}`);
  if (value.startsWith('/')) return path.posix.normalize(value.slice(1));
  return path.posix.normalize(path.posix.join(path.posix.dirname(partPath), value));
}

function relationshipMap(xmlBuffer, label) {
  const parsed = parseXml(xmlBuffer, label);
  const relationships = asArray(parsed.Relationships?.Relationship);
  return new Map(relationships.map((relationship) => {
    if (!relationship.Id || !relationship.Target) {
      throw new TypeError(`${label} contains an incomplete relationship`);
    }
    return [String(relationship.Id), String(relationship.Target)];
  }));
}

function workbookSheetParts(zip) {
  const workbookPart = 'xl/workbook.xml';
  const workbook = parseXml(zipEntry(zip, workbookPart), 'workbook');
  const relationships = relationshipMap(
    zipEntry(zip, relationshipsPath(workbookPart)),
    'workbook relationships'
  );
  return asArray(workbook.workbook?.sheets?.sheet).map((sheet) => {
    const relationshipId = sheet.id;
    const target = relationships.get(String(relationshipId || ''));
    if (!sheet.name || !target) throw new TypeError('Workbook contains an unresolved worksheet');
    return {
      name: String(sheet.name),
      partPath: resolveRelationshipTarget(workbookPart, target)
    };
  });
}

function mimeForMediaPath(mediaPath) {
  switch (path.posix.extname(mediaPath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return { extension: '.jpg', mimeType: 'image/jpeg' };
    case '.png':
      return { extension: '.png', mimeType: 'image/png' };
    default:
      throw new TypeError(`Unsupported workbook image format: ${mediaPath}`);
  }
}

function sanitizeWorkbookJpegTrailingData(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const eoiOffset = buffer.lastIndexOf(JPEG_EOI);
  if (eoiOffset < 0) return null;
  const normalizedByteLength = eoiOffset + JPEG_EOI.length;
  const removedTrailingBytes = buffer.length - normalizedByteLength;
  if (
    removedTrailingBytes < 1 ||
    removedTrailingBytes > MAX_JPEG_TRAILING_BYTES
  ) {
    return null;
  }

  const normalizedBuffer = Buffer.from(buffer.subarray(0, normalizedByteLength));
  try {
    validateFileContent(normalizedBuffer, 'image/jpeg');
  } catch {
    return null;
  }
  return {
    buffer: normalizedBuffer,
    sanitizationType: JPEG_TRAILING_DATA_SANITIZATION,
    originalByteLength: buffer.length,
    normalizedByteLength,
    removedTrailingBytes
  };
}

function checkedMedia(zip, mediaPath, referencedBytes) {
  const buffer = zipEntry(zip, mediaPath);
  if (buffer.length === 0 || buffer.length > MAX_MEDIA_FILE_BYTES) {
    throw new RangeError(`Workbook image has an invalid size: ${mediaPath}`);
  }
  const media = mimeForMediaPath(mediaPath);
  referencedBytes.value += buffer.length;
  if (referencedBytes.value > MAX_REFERENCED_MEDIA_BYTES) {
    throw new RangeError('Workbook referenced images exceed the safe extraction limit');
  }
  let validationError = null;
  let acceptedBuffer = buffer;
  let sanitization = null;
  try {
    validateFileContent(buffer, media.mimeType);
  } catch (error) {
    if (media.mimeType === 'image/jpeg') {
      sanitization = sanitizeWorkbookJpegTrailingData(buffer);
    }
    if (sanitization) acceptedBuffer = sanitization.buffer;
    else validationError = error.message;
  }
  return {
    buffer: validationError ? null : acceptedBuffer,
    byteLength: buffer.length,
    validationError,
    isValid: validationError === null,
    ...(sanitization || {}),
    ...media
  };
}

function cellImageDefinitions(zip, referencedBytes) {
  const partPath = 'xl/cellimages.xml';
  const xml = zipEntry(zip, partPath, { required: false });
  if (!xml) return new Map();
  const parsed = parseXml(xml, 'WPS cell images');
  const relationships = relationshipMap(
    zipEntry(zip, relationshipsPath(partPath)),
    'WPS cell image relationships'
  );
  const definitions = new Map();
  for (const item of asArray(parsed.cellImages?.cellImage)) {
    const name = item.pic?.nvPicPr?.cNvPr?.name;
    const relationshipId = item.pic?.blipFill?.blip?.embed;
    const target = relationships.get(String(relationshipId || ''));
    if (!name || !target) throw new TypeError('WPS cell image contains an unresolved media reference');
    const mediaPath = resolveRelationshipTarget(partPath, target);
    definitions.set(String(name), {
      imageRef: String(name),
      relationshipId: String(relationshipId),
      mediaPath,
      ...checkedMedia(zip, mediaPath, referencedBytes)
    });
  }
  return definitions;
}

function worksheetDrawingParts(zip) {
  const results = [];
  for (const sheet of workbookSheetParts(zip)) {
    const worksheet = parseXml(zipEntry(zip, sheet.partPath), `worksheet ${sheet.name}`);
    const relationshipId = worksheet.worksheet?.drawing?.id;
    if (!relationshipId) continue;
    const relationships = relationshipMap(
      zipEntry(zip, relationshipsPath(sheet.partPath)),
      `worksheet relationships ${sheet.name}`
    );
    const target = relationships.get(String(relationshipId));
    if (!target) throw new TypeError(`Worksheet drawing is unresolved: ${sheet.name}`);
    results.push({
      sheetName: sheet.name,
      drawingPart: resolveRelationshipTarget(sheet.partPath, target)
    });
  }
  return results;
}

function drawingImages(zip, referencedBytes) {
  const images = [];
  for (const { sheetName, drawingPart } of worksheetDrawingParts(zip)) {
    const drawing = parseXml(zipEntry(zip, drawingPart), `drawing ${sheetName}`);
    const relationships = relationshipMap(
      zipEntry(zip, relationshipsPath(drawingPart)),
      `drawing relationships ${sheetName}`
    );
    for (const anchor of asArray(drawing.wsDr?.twoCellAnchor)) {
      const zeroBasedRow = Number(anchor.from?.row);
      const relationshipId = anchor.pic?.blipFill?.blip?.embed;
      const target = relationships.get(String(relationshipId || ''));
      if (!Number.isInteger(zeroBasedRow) || zeroBasedRow < 0 || !target) {
        throw new TypeError(`Drawing anchor is incomplete: ${sheetName}`);
      }
      const mediaPath = resolveRelationshipTarget(drawingPart, target);
      images.push({
        sheetName,
        rowNumber: zeroBasedRow + 1,
        imageRef: `DRAWING:${drawingPart}:${relationshipId}`,
        relationshipId: String(relationshipId),
        mediaPath,
        sourceKind: 'DRAWING',
        ...checkedMedia(zip, mediaPath, referencedBytes)
      });
    }
  }
  return images;
}

function rowKey(sheetName, rowNumber) {
  return `${sheetName}\u0000${rowNumber}`;
}

function appendImage(imagesByRow, image) {
  const key = rowKey(image.sheetName, image.rowNumber);
  const current = imagesByRow.get(key) || [];
  if (!current.some((item) => item.imageRef === image.imageRef)) current.push(image);
  imagesByRow.set(key, current);
}

function extractEquipmentWorkbookMedia(buffer, { workbook = null } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('A non-empty equipment workbook buffer is required');
  }
  const zip = XLSX.CFB.read(buffer, { type: 'buffer' });
  const referencedBytes = { value: 0 };
  const definitions = cellImageDefinitions(zip, referencedBytes);
  const parsedWorkbook = workbook || XLSX.read(buffer, {
    type: 'buffer',
    cellFormula: true,
    dense: false
  });
  const imagesByRow = new Map();
  let wpsCellReferences = 0;
  const usedDefinitionIds = new Set();

  for (const sheetName of parsedWorkbook.SheetNames) {
    const worksheet = parsedWorkbook.Sheets[sheetName];
    const denseRows = Array.isArray(worksheet)
      ? worksheet
      : Array.isArray(worksheet?.['!data']) ? worksheet['!data'] : null;
    const cells = denseRows
      ? denseRows.flatMap((row, rowIndex) => (Array.isArray(row) ? row : []).map(
        (cell, columnIndex) => [XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex }), cell]
      ))
      : Object.entries(worksheet);
    for (const [address, cell] of cells) {
      if (!denseRows && address.startsWith('!')) continue;
      const formula = String(cell?.f || cell?.v || '');
      const match = /DISPIMG\s*\(\s*"([^"]+)"/i.exec(formula);
      if (!match) continue;
      const definition = definitions.get(match[1]);
      if (!definition) throw new TypeError(`WPS cell image definition is missing: ${match[1]}`);
      const decoded = XLSX.utils.decode_cell(address);
      appendImage(imagesByRow, {
        ...definition,
        sheetName,
        rowNumber: decoded.r + 1,
        cellAddress: address,
        sourceKind: 'WPS_CELL_IMAGE'
      });
      wpsCellReferences += 1;
      usedDefinitionIds.add(match[1]);
    }
  }

  const drawings = drawingImages(zip, referencedBytes);
  drawings.forEach((image) => appendImage(imagesByRow, image));
  const missingDefinitionIds = [...definitions.keys()].filter((id) => !usedDefinitionIds.has(id));
  const associatedImages = [...imagesByRow.values()].flat();
  const invalidMediaPaths = [...new Set(associatedImages
    .filter(({ isValid }) => !isValid)
    .map(({ mediaPath }) => mediaPath))];
  const sanitizedImages = associatedImages.filter(
    ({ sanitizationType }) => sanitizationType === JPEG_TRAILING_DATA_SANITIZATION
  );
  const sanitizedByPath = new Map();
  sanitizedImages.forEach((image) => {
    if (!sanitizedByPath.has(image.mediaPath)) sanitizedByPath.set(image.mediaPath, image);
  });
  const sanitizedMediaPaths = [...sanitizedByPath.keys()];
  return {
    imagesByRow,
    summary: {
      wpsImageDefinitions: definitions.size,
      wpsCellReferences,
      uniqueWpsImageReferences: usedDefinitionIds.size,
      unusedWpsImageDefinitions: missingDefinitionIds,
      drawingImages: drawings.length,
      rowsWithImages: imagesByRow.size,
      referencedMediaBytes: referencedBytes.value,
      sanitizedMediaFiles: sanitizedMediaPaths.length,
      sanitizedMediaReferences: sanitizedImages.length,
      sanitizedBytesRemoved: [...sanitizedByPath.values()].reduce(
        (total, image) => total + image.removedTrailingBytes,
        0
      ),
      sanitizedMediaPaths,
      invalidMediaFiles: invalidMediaPaths.length,
      invalidMediaReferences: associatedImages.filter(({ isValid }) => !isValid).length,
      invalidMediaPaths
    }
  };
}

module.exports = {
  JPEG_TRAILING_DATA_SANITIZATION,
  MAX_MEDIA_FILE_BYTES,
  MAX_JPEG_TRAILING_BYTES,
  MAX_REFERENCED_MEDIA_BYTES,
  asArray,
  extractEquipmentWorkbookMedia,
  relationshipMap,
  resolveRelationshipTarget,
  rowKey,
  sanitizeWorkbookJpegTrailingData
};
