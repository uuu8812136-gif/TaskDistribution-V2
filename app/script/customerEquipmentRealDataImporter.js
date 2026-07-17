'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const EquipmentAsset = require('../models/EquipmentAsset');
const EquipmentCategory = require('../models/EquipmentCategory');
const FileAsset = require('../models/FileAsset');
const { parseEquipmentWorkbook } = require('../services/equipmentImportParser');
const {
  extractEquipmentWorkbookMedia,
  rowKey
} = require('../services/equipmentWorkbookMediaExtractor');

const EQUIPMENT_IMPORT_TAG = 'customer-fixed-assets-2026-midyear-v1';
const EQUIPMENT_WORKBOOK_FILE = '变速箱物流部2026年中固定资产盘点表(1).xlsx';
const EXPECTED_EQUIPMENT_ROWS = 144;
const EXPECTED_PUBLISHED_EQUIPMENT_ASSETS = 141;
const EXPECTED_WPS_DEFINITIONS = 195;
const EXPECTED_WPS_REFERENCES = 220;
const EXPECTED_DRAWING_IMAGES = 8;
const EXPECTED_ROWS_WITH_IMAGES = 135;
const EXPECTED_PHOTO_ASSOCIATIONS = 228;

const ASSET_TYPE_BY_SHEET = Object.freeze({
  运输装备: 'TRANSPORT_EQUIPMENT',
  装卸装备: 'HANDLING_EQUIPMENT',
  物流信息装备: 'LOGISTICS_INFORMATION_EQUIPMENT',
  辅助设施设备: 'AUXILIARY_FACILITY',
  闲置: 'IDLE'
});

const CATEGORY_DEFINITIONS = Object.freeze([
  Object.freeze({ assetType: 'TRANSPORT_EQUIPMENT', name: '运输装备', code: 'TRN', sortOrder: 10 }),
  Object.freeze({ assetType: 'HANDLING_EQUIPMENT', name: '装卸装备', code: 'HDL', sortOrder: 20 }),
  Object.freeze({ assetType: 'LOGISTICS_INFORMATION_EQUIPMENT', name: '物流信息装备', code: 'INF', sortOrder: 30 }),
  Object.freeze({ assetType: 'AUXILIARY_FACILITY', name: '辅助设施设备', code: 'AUX', sortOrder: 40 }),
  Object.freeze({ assetType: 'IDLE', name: '闲置设备', code: 'IDL', sortOrder: 50 })
]);

const ASSET_FIELDS = Object.freeze([
  'orgUnitId', 'assetCode', 'sourceAssetCode', 'sourceSequence', 'assetType',
  'sourceSheetName', 'sourceRowNumber', 'sourceRawValues', 'sourceImageRefs',
  'productCode', 'plateNumber', 'serialNumber', 'brandSerialNumber', 'name',
  'categoryId', 'specification', 'manufacturer', 'brand', 'vehicleLength',
  'ratedCapacityText', 'quantity', 'unit', 'acquisitionDate', 'productionDate',
  'productionDatePrecision', 'productionDateRaw', 'productionDateDisplay', 'activationDate',
  'activationDatePrecision', 'activationDateRaw', 'activationDateDisplay', 'idlePlacedAt', 'idlePlacedAtRaw',
  'idlePlacedAtDisplay', 'bookQuantity', 'physicalQuantity', 'originalValue',
  'custodianUserId', 'custodianDisplayName', 'orgUnitNameSnapshot', 'location',
  'status', 'conditionText', 'forkliftPosition', 'environmentalRegistrationCode',
  'photoFileIds', 'dataQuality', 'remark'
]);

function canonical(value) {
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value === undefined ? null : value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function selected(document, fields) {
  const value = document?.toObject ? document.toObject() : document;
  return Object.fromEntries(fields.map((field) => [field, value?.[field]]));
}

function deterministicObjectId(seed) {
  return new mongoose.Types.ObjectId(
    crypto.createHash('sha256').update(`${EQUIPMENT_IMPORT_TAG}:${seed}`).digest('hex').slice(0, 24)
  );
}

function deterministicUuid(seed) {
  const hex = crypto.createHash('sha256').update(`${EQUIPMENT_IMPORT_TAG}:${seed}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeIdentifier(value) {
  return String(value || '').normalize('NFKC').trim().toUpperCase();
}

function sourceIdentifiers(candidate) {
  return [
    candidate.assetCode,
    candidate.sourceAssetCode,
    candidate.productCode,
    candidate.serialNumber,
    candidate.brandSerialNumber,
    candidate.plateNumber
  ].map(normalizeIdentifier).filter((value) => value && !['无', '暂无', '不详', '/', '-', '--'].includes(value));
}

function generatedAssetCode(assetType, rowNumber) {
  const definition = CATEGORY_DEFINITIONS.find((item) => item.assetType === assetType);
  if (!definition) throw new TypeError(`Unsupported equipment asset type: ${assetType}`);
  return `CUST26-${definition.code}-${String(rowNumber).padStart(3, '0')}`;
}

function issue(exceptionType, values = {}) {
  return {
    field: values.field || '_source',
    exceptionType,
    severity: values.severity || 'WARNING',
    originalValue: values.originalValue ?? null,
    suggestedValue: values.suggestedValue ?? null,
    message: values.message || exceptionType
  };
}

function buildEquipmentFixtures(sourceDir) {
  const workbookPath = path.join(sourceDir, 'spreadsheets', EQUIPMENT_WORKBOOK_FILE);
  const workbookBuffer = fs.readFileSync(workbookPath);
  const sourceDocumentSha256 = sha256(workbookBuffer);
  const parsed = parseEquipmentWorkbook(workbookBuffer);
  const media = extractEquipmentWorkbookMedia(workbookBuffer, { workbook: parsed.workbook });
  if (parsed.rows.length !== EXPECTED_EQUIPMENT_ROWS) {
    throw new Error(`Expected ${EXPECTED_EQUIPMENT_ROWS} equipment rows, received ${parsed.rows.length}`);
  }
  const expectedSheets = Object.keys(ASSET_TYPE_BY_SHEET);
  if (!sameValue(parsed.sheetNames, expectedSheets)) {
    throw new Error(`Unexpected equipment worksheets: ${parsed.sheetNames.join(', ')}`);
  }
  const expectedMedia = {
    wpsImageDefinitions: EXPECTED_WPS_DEFINITIONS,
    wpsCellReferences: EXPECTED_WPS_REFERENCES,
    drawingImages: EXPECTED_DRAWING_IMAGES,
    rowsWithImages: EXPECTED_ROWS_WITH_IMAGES
  };
  for (const [field, expected] of Object.entries(expectedMedia)) {
    if (media.summary[field] !== expected) {
      throw new Error(`Equipment media ${field} mismatch: expected ${expected}, received ${media.summary[field]}`);
    }
  }

  const codeCounts = new Map();
  for (const row of parsed.rows) {
    const code = normalizeIdentifier(row.candidate.assetCode);
    if (code) codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
  }
  const nonIdleIdentifiers = new Map();
  for (const row of parsed.rows) {
    if (row.sheetName === '闲置') continue;
    for (const identifier of sourceIdentifiers(row.candidate)) {
      const references = nonIdleIdentifiers.get(identifier) || [];
      references.push(`${row.sheetName}!${row.rowNumber}`);
      nonIdleIdentifiers.set(identifier, references);
    }
  }

  const fixtures = parsed.rows.map((row) => {
    const assetType = ASSET_TYPE_BY_SHEET[row.sheetName];
    if (!assetType) throw new Error(`Unsupported equipment worksheet: ${row.sheetName}`);
    const candidate = { ...row.candidate, assetType };
    const sourceCode = String(candidate.assetCode || '').normalize('NFKC').trim();
    const sourceCodeKey = normalizeIdentifier(sourceCode);
    const useSourceCode = Boolean(sourceCode) && sourceCode.length <= 100 && codeCounts.get(sourceCodeKey) === 1;
    const assetCode = useSourceCode ? sourceCode : generatedAssetCode(assetType, row.rowNumber);
    const images = media.imagesByRow.get(rowKey(row.sheetName, row.rowNumber)) || [];
    const parserIssues = row.exceptions.filter(({ exceptionType }) => exceptionType !== 'PHOTO_MAPPING_PENDING');
    const resolvedIssues = row.exceptions.filter(({ exceptionType }) => exceptionType === 'PHOTO_MAPPING_PENDING');
    const issues = parserIssues.map((entry) => canonical(entry));
    if (!useSourceCode) {
      issues.push(issue('ASSET_CODE_GENERATED_FOR_TEST', {
        field: 'assetCode',
        originalValue: sourceCode || null,
        suggestedValue: assetCode,
        message: 'Source asset code is missing, too long, or duplicated; a deterministic test code is used'
      }));
    }
    if (sourceCodeKey && codeCounts.get(sourceCodeKey) > 1) {
      issues.push(issue('SOURCE_ASSET_CODE_DUPLICATE', {
        field: 'sourceAssetCode',
        originalValue: sourceCode,
        message: 'The source workbook repeats this asset code on multiple rows'
      }));
    }
    if (assetType === 'IDLE') {
      const matched = [...new Set(sourceIdentifiers(candidate).flatMap(
        (identifier) => nonIdleIdentifiers.get(identifier) || []
      ))];
      if (matched.length > 0) {
        issues.push(issue('POSSIBLE_IDLE_DUPLICATE', {
          field: '_source',
          severity: 'ERROR',
          originalValue: matched,
          message: 'This idle row appears to describe an asset already present on an active worksheet'
        }));
      }
    }
    const mappedWpsRefs = images.filter(({ sourceKind }) => sourceKind === 'WPS_CELL_IMAGE').length;
    if (mappedWpsRefs !== (candidate.sourceImageRefs || []).length) {
      issues.push(issue('PHOTO_MAPPING_COUNT_MISMATCH', {
        field: '_photos',
        severity: 'ERROR',
        originalValue: {
          sourceReferences: (candidate.sourceImageRefs || []).length,
          mappedReferences: mappedWpsRefs
        }
      }));
    }
    return {
      sheetName: row.sheetName,
      rowNumber: row.rowNumber,
      candidate: {
        ...candidate,
        assetCode,
        sourceAssetCode: candidate.sourceAssetCode || sourceCode,
        dataQuality: {
          source: 'CUSTOMER_FIXED_ASSET_WORKBOOK',
          importTag: EQUIPMENT_IMPORT_TAG,
          status: issues.length > 0 ? 'PENDING_CONFIRMATION' : 'IMPORTED',
          issues,
          resolvedIssues: resolvedIssues.map((entry) => canonical(entry)),
          exceptionTypes: [...new Set(issues.map(({ exceptionType }) => exceptionType))],
          photoMappingStatus: images.length > 0 ? 'MAPPED' : 'NO_SOURCE_PHOTO',
          photoCount: images.length,
          sourceDocumentSha256
        }
      },
      images
    };
  });
  const pendingDuplicateRows = [];
  for (const fixture of fixtures) {
    const duplicateIssue = fixture.candidate.dataQuality.issues.find(
      ({ exceptionType }) => exceptionType === 'POSSIBLE_IDLE_DUPLICATE'
    );
    if (!duplicateIssue) continue;
    fixture.publish = false;
    pendingDuplicateRows.push({
      sheetName: fixture.sheetName,
      rowNumber: fixture.rowNumber,
      candidate: canonical(fixture.candidate)
    });
    for (const sourceReference of duplicateIssue.originalValue || []) {
      const separator = String(sourceReference).lastIndexOf('!');
      if (separator < 1) continue;
      const targetSheet = String(sourceReference).slice(0, separator);
      const targetRow = Number(String(sourceReference).slice(separator + 1));
      const target = fixtures.find((item) => (
        item.sheetName === targetSheet && item.rowNumber === targetRow
      ));
      if (!target) throw new Error(`Idle duplicate target is missing: ${sourceReference}`);
      const pendingIssue = issue('PENDING_IDLE_SOURCE_ROW', {
        field: '_source',
        severity: 'ERROR',
        originalValue: {
          sheetName: fixture.sheetName,
          rowNumber: fixture.rowNumber,
          sourceRawValues: fixture.candidate.sourceRawValues,
          identifiers: sourceIdentifiers(fixture.candidate)
        },
        message: 'The idle worksheet contains a pending update for this existing asset; customer confirmation is required'
      });
      target.candidate.dataQuality.status = 'PENDING_CONFIRMATION';
      target.candidate.dataQuality.issues.push(pendingIssue);
      target.candidate.dataQuality.exceptionTypes = [...new Set([
        ...target.candidate.dataQuality.exceptionTypes,
        pendingIssue.exceptionType
      ])];
      target.candidate.dataQuality.pendingSourceRows = [
        ...(target.candidate.dataQuality.pendingSourceRows || []),
        pendingIssue.originalValue
      ];
    }
  }
  const publishableFixtures = fixtures.filter(({ publish }) => publish !== false);
  if (publishableFixtures.length !== EXPECTED_PUBLISHED_EQUIPMENT_ASSETS) {
    throw new Error(
      `Expected ${EXPECTED_PUBLISHED_EQUIPMENT_ASSETS} publishable equipment assets, received ${publishableFixtures.length}`
    );
  }
  const photoAssociations = publishableFixtures.reduce((sum, fixture) => sum + fixture.images.length, 0);
  if (photoAssociations !== EXPECTED_PHOTO_ASSOCIATIONS) {
    throw new Error(`Expected ${EXPECTED_PHOTO_ASSOCIATIONS} equipment photo associations, received ${photoAssociations}`);
  }
  return {
    workbookPath,
    sourceDocumentSha256,
    fixtures,
    publishableFixtures,
    pendingDuplicateRows,
    mediaSummary: media.summary,
    photoAssociations
  };
}

async function resolveCategories({ scope, apply, changes }) {
  const categoryIds = new Map();
  for (const definition of CATEGORY_DEFINITIONS) {
    let category = await EquipmentCategory.findOne({
      teamId: scope.team._id,
      name: definition.name
    });
    const existing = Boolean(category);
    if (!category) {
      category = new EquipmentCategory({
        _id: deterministicObjectId(`category:${scope.team._id}:${definition.assetType}`),
        teamId: scope.team._id,
        name: definition.name,
        createdBy: scope.user._id,
        updatedBy: scope.user._id
      });
    }
    const desired = {
      parentId: null,
      sortOrder: definition.sortOrder,
      status: EquipmentCategory.EQUIPMENT_CATEGORY_STATUSES.ACTIVE,
      updatedBy: scope.user._id
    };
    const unchanged = existing && sameValue(selected(category, Object.keys(desired)), desired);
    changes[existing ? (unchanged ? 'unchanged' : 'updated') : 'created'] += 1;
    Object.assign(category, desired);
    await category.validate();
    if (apply && !unchanged) await category.save();
    categoryIds.set(definition.assetType, category._id);
  }
  return categoryIds;
}

function isInside(root, candidate, allowRoot = false) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative) return allowRoot;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function storagePath(uploadDir, storageKey) {
  const resolved = path.resolve(uploadDir, ...storageKey.split('/'));
  if (!isInside(uploadDir, resolved)) throw new Error('Equipment image storageKey escapes upload-dir');
  let existingAncestor = resolved;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error('Cannot resolve equipment image storage target');
    existingAncestor = parent;
  }
  const realUploadDir = fs.realpathSync(uploadDir);
  const realAncestor = fs.realpathSync(existingAncestor);
  if (!isInside(realUploadDir, realAncestor, true)) {
    throw new Error('Equipment image target resolves outside upload-dir');
  }
  const realTarget = path.resolve(realAncestor, path.relative(existingAncestor, resolved));
  if (!isInside(realUploadDir, realTarget)) {
    throw new Error('Equipment image target escapes upload-dir through a reparse point');
  }
  return resolved;
}

function fileHash(filename) {
  return fs.existsSync(filename) && fs.statSync(filename).isFile()
    ? sha256(fs.readFileSync(filename))
    : null;
}

async function writeImageIfNeeded({ image, targetPath, apply, changes }) {
  const sourceHash = sha256(image.buffer);
  const currentHash = fileHash(targetPath);
  if (currentHash) {
    if (currentHash !== sourceHash) throw new Error(`Equipment image hash mismatch: ${targetPath}`);
    changes.alreadyPresent += 1;
    return;
  }
  changes.missing += 1;
  if (!apply) return;
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, image.buffer, { flag: 'wx' });
    if (fileHash(temporaryPath) !== sourceHash) throw new Error('Equipment image copy verification failed');
    await fs.promises.rename(temporaryPath, targetPath);
    changes.copied += 1;
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function upsertEquipmentImage({
  fixture,
  image,
  imageIndex,
  assetId,
  scope,
  options,
  fileChanges,
  storageChanges
}) {
  const imageSha256 = sha256(image.buffer);
  const fileId = deterministicObjectId(
    `photo:${scope.team._id}:${assetId}:${image.imageRef}:${image.mediaPath}`
  );
  const storageKey = [
    String(scope.team._id),
    '2026',
    '07',
    `${deterministicUuid(`storage:${assetId}:${image.imageRef}:${imageSha256}`)}${image.extension}`
  ].join('/');
  let file = await FileAsset.findById(fileId);
  const existing = Boolean(file);
  const uploaderId = existing ? file.uploaderId : scope.user._id;
  if (!file) {
    file = new FileAsset({
      _id: fileId,
      teamId: scope.team._id,
      storageKey,
      sha256: imageSha256,
      uploaderId
    });
  }
  if (
    String(file.teamId) !== String(scope.team._id) ||
    file.storageKey !== storageKey ||
    file.sha256 !== imageSha256 ||
    String(file.uploaderId) !== String(uploaderId)
  ) {
    throw new Error(`Immutable equipment FileAsset metadata mismatch: ${fixture.sheetName}!${fixture.rowNumber}`);
  }
  const desired = {
    ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT,
    ownerId: assetId,
    originalName: `equipment-${fixture.candidate.assetType.toLowerCase()}-${fixture.rowNumber}-${imageIndex + 1}${image.extension}`,
    mimeType: image.mimeType,
    size: image.buffer.length,
    status: FileAsset.FILE_STATUSES.ACTIVE,
    deletedAt: null,
    deletedBy: null
  };
  const unchanged = existing && sameValue(selected(file, Object.keys(desired)), desired);
  fileChanges[existing ? (unchanged ? 'unchanged' : 'updated') : 'created'] += 1;
  Object.assign(file, desired);
  await file.validate();
  await writeImageIfNeeded({
    image,
    targetPath: storagePath(options.uploadDir, storageKey),
    apply: options.apply,
    changes: storageChanges
  });
  if (options.apply && !unchanged) await file.save();
  return file._id;
}

async function resolveAssetDocument(fixture, scope) {
  const sourceFilter = {
    teamId: scope.team._id,
    sourceSheetName: fixture.sheetName,
    sourceRowNumber: fixture.rowNumber
  };
  const matches = await EquipmentAsset.find(sourceFilter).limit(2);
  if (matches.length > 1) {
    throw new Error(`Duplicate imported equipment source rows: ${fixture.sheetName}!${fixture.rowNumber}`);
  }
  if (matches[0]) {
    if (matches[0].dataQuality?.importTag !== EQUIPMENT_IMPORT_TAG) {
      throw new Error(
        `Customer import refuses to overwrite an existing equipment source row: ${fixture.sheetName}!${fixture.rowNumber}`
      );
    }
    return matches[0];
  }
  const deterministicId = deterministicObjectId(
    `asset:${scope.team._id}:${fixture.sheetName}:${fixture.rowNumber}`
  );
  const byId = await EquipmentAsset.findById(deterministicId);
  if (byId && (
    String(byId.teamId) !== String(scope.team._id) ||
    byId.dataQuality?.importTag !== EQUIPMENT_IMPORT_TAG
  )) {
    throw new Error(`Deterministic equipment asset ID collision: ${deterministicId}`);
  }
  return byId || new EquipmentAsset({ _id: deterministicId, ...sourceFilter });
}

async function collisionSafeAssetCode({ fixture, document, scope }) {
  let assetCode = fixture.candidate.assetCode;
  const collision = await EquipmentAsset.findOne({
    teamId: scope.team._id,
    assetCode,
    _id: { $ne: document._id }
  }).select('_id sourceSheetName sourceRowNumber').lean();
  if (!collision) return { assetCode, collision: null };
  assetCode = generatedAssetCode(fixture.candidate.assetType, fixture.rowNumber);
  const generatedCollision = await EquipmentAsset.exists({
    teamId: scope.team._id,
    assetCode,
    _id: { $ne: document._id }
  });
  if (generatedCollision) throw new Error(`Generated equipment asset code collision: ${assetCode}`);
  return { assetCode, collision };
}

async function upsertEquipmentFixtures({ bundle, scope, options, changes }) {
  const categoryIds = await resolveCategories({
    scope,
    apply: options.apply,
    changes: changes.categories
  });
  const assetIds = [];
  const fileIds = [];
  const expectedAssets = [];
  for (const fixture of bundle.publishableFixtures) {
    const document = await resolveAssetDocument(fixture, scope);
    const existing = !document.isNew;
    const candidate = fixture.candidate;
    if (existing) {
      const immutableExpected = {
        sourceSheetName: fixture.sheetName,
        sourceRowNumber: fixture.rowNumber,
        sourceRawValues: candidate.sourceRawValues || {},
        sourceImageRefs: candidate.sourceImageRefs || []
      };
      if (!sameValue(selected(document, Object.keys(immutableExpected)), immutableExpected)) {
        throw new Error(
          `Immutable equipment source fields differ from the workbook: ${fixture.sheetName}!${fixture.rowNumber}`
        );
      }
    }
    const codeResult = await collisionSafeAssetCode({ fixture, document, scope });
    const dataQuality = canonical(fixture.candidate.dataQuality);
    if (codeResult.collision) {
      dataQuality.status = 'PENDING_CONFIRMATION';
      dataQuality.issues.push(issue('ASSET_CODE_COLLISION_EXISTING', {
        field: 'assetCode',
        originalValue: fixture.candidate.assetCode,
        suggestedValue: codeResult.assetCode,
        message: 'Source asset code collides with an existing local test asset'
      }));
      dataQuality.exceptionTypes = [...new Set(dataQuality.issues.map(({ exceptionType }) => exceptionType))];
    }
    const photoFileIds = [];
    for (let index = 0; index < fixture.images.length; index += 1) {
      const fileId = await upsertEquipmentImage({
        fixture,
        image: fixture.images[index],
        imageIndex: index,
        assetId: document._id,
        scope,
        options,
        fileChanges: changes.fileAssets,
        storageChanges: changes.storage
      });
      photoFileIds.push(fileId);
      fileIds.push(fileId);
    }
    const desired = {
      orgUnitId: scope.orgUnit._id,
      assetCode: codeResult.assetCode,
      sourceAssetCode: candidate.sourceAssetCode || '',
      sourceSequence: candidate.sourceSequence || '',
      assetType: candidate.assetType,
      sourceSheetName: fixture.sheetName,
      sourceRowNumber: fixture.rowNumber,
      sourceRawValues: candidate.sourceRawValues || {},
      sourceImageRefs: candidate.sourceImageRefs || [],
      productCode: candidate.productCode || '',
      plateNumber: candidate.plateNumber || '',
      serialNumber: candidate.serialNumber || '',
      brandSerialNumber: candidate.brandSerialNumber || '',
      name: candidate.name,
      categoryId: categoryIds.get(candidate.assetType),
      specification: candidate.specification || '',
      manufacturer: candidate.manufacturer || '',
      brand: candidate.brand || '',
      vehicleLength: candidate.vehicleLength || '',
      ratedCapacityText: candidate.ratedCapacityText || '',
      quantity: Number.isFinite(candidate.quantity) ? candidate.quantity : 1,
      unit: candidate.unit || '',
      acquisitionDate: candidate.acquisitionDate || null,
      productionDate: candidate.productionDate || null,
      productionDatePrecision: candidate.productionDatePrecision || null,
      productionDateRaw: candidate.productionDateRaw || '',
      productionDateDisplay: candidate.productionDateDisplay || '',
      activationDate: candidate.activationDate || null,
      activationDatePrecision: candidate.activationDatePrecision || null,
      activationDateRaw: candidate.activationDateRaw || '',
      activationDateDisplay: candidate.activationDateDisplay || '',
      idlePlacedAt: candidate.idlePlacedAt || null,
      idlePlacedAtRaw: candidate.idlePlacedAtRaw || '',
      idlePlacedAtDisplay: candidate.idlePlacedAtDisplay || '',
      bookQuantity: Number.isFinite(candidate.bookQuantity) ? candidate.bookQuantity : null,
      physicalQuantity: Number.isFinite(candidate.physicalQuantity) ? candidate.physicalQuantity : null,
      originalValue: Number.isFinite(candidate.originalValue) ? candidate.originalValue : null,
      custodianUserId: null,
      custodianDisplayName: candidate.custodianDisplayName || candidate.custodianName || '',
      orgUnitNameSnapshot: candidate.orgUnitNameSnapshot || candidate.orgUnitName || '',
      location: candidate.location || '',
      status: candidate.status,
      conditionText: candidate.conditionText || '',
      forkliftPosition: candidate.forkliftPosition || '',
      environmentalRegistrationCode: candidate.environmentalRegistrationCode || '',
      photoFileIds,
      dataQuality,
      remark: candidate.remark || ''
    };
    const unchanged = existing && sameValue(selected(document, ASSET_FIELDS), desired);
    changes.assets[existing ? (unchanged ? 'unchanged' : 'updated') : 'created'] += 1;
    Object.assign(document, desired, { updatedBy: scope.user._id });
    if (!existing) document.createdBy = scope.user._id;
    await document.validate();
    if (options.apply && !unchanged) await document.save();
    assetIds.push(document._id);
    expectedAssets.push({ _id: document._id, desired: canonical(desired) });
  }
  return { assetIds, fileIds, expectedAssets };
}

async function verifyEquipmentApplied({ bundle, scope, ids, uploadDir }) {
  const assets = await EquipmentAsset.find({ _id: { $in: ids.assetIds } }).lean();
  if (assets.length !== EXPECTED_PUBLISHED_EQUIPMENT_ASSETS) {
    throw new Error(`Persisted equipment count mismatch: ${assets.length}`);
  }
  const assetsById = new Map(assets.map((asset) => [String(asset._id), asset]));
  for (const expected of ids.expectedAssets) {
    const persisted = assetsById.get(String(expected._id));
    if (!persisted || !sameValue(selected(persisted, ASSET_FIELDS), expected.desired)) {
      throw new Error(`Persisted equipment field verification failed: ${expected._id}`);
    }
  }
  const files = await FileAsset.find({
    _id: { $in: ids.fileIds },
    ownerType: FileAsset.FILE_OWNER_TYPES.EQUIPMENT,
    status: FileAsset.FILE_STATUSES.ACTIVE
  }).lean();
  if (files.length !== EXPECTED_PHOTO_ASSOCIATIONS) {
    throw new Error(`Persisted equipment photo count mismatch: ${files.length}`);
  }
  for (const file of files) {
    if (fileHash(storagePath(uploadDir, file.storageKey)) !== file.sha256) {
      throw new Error(`Persisted equipment image verification failed: ${file.originalName}`);
    }
  }
  const grouped = await EquipmentAsset.aggregate([
    { $match: { _id: { $in: ids.assetIds }, teamId: scope.team._id } },
    { $group: { _id: '$assetType', count: { $sum: 1 }, photos: { $sum: { $size: '$photoFileIds' } } } }
  ]);
  return {
    assets: assets.length,
    fileAssets: files.length,
    rowsWithPhotos: assets.filter(({ photoFileIds }) => photoFileIds.length > 0).length,
    pendingConfirmation: assets.filter(({ dataQuality }) => dataQuality?.status === 'PENDING_CONFIRMATION').length,
    byAssetType: Object.fromEntries(grouped.map((entry) => [entry._id, {
      count: entry.count,
      photos: entry.photos
    }]))
  };
}

module.exports = {
  ASSET_TYPE_BY_SHEET,
  CATEGORY_DEFINITIONS,
  EQUIPMENT_IMPORT_TAG,
  EQUIPMENT_WORKBOOK_FILE,
  EXPECTED_EQUIPMENT_ROWS,
  EXPECTED_PUBLISHED_EQUIPMENT_ASSETS,
  EXPECTED_PHOTO_ASSOCIATIONS,
  buildEquipmentFixtures,
  upsertEquipmentFixtures,
  verifyEquipmentApplied
};
