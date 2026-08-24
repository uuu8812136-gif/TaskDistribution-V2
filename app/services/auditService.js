'use strict';

const {
  AUDIT_ACTION_VALUES,
  AUDIT_ACTOR_MODES,
  AUDIT_ACTOR_MODE_VALUES,
  AUDIT_ACTOR_ROLES,
  AUDIT_ACTOR_ROLE_VALUES,
  AUDIT_RESOURCE_TYPE_VALUES,
  MEMBERSHIP_ROLES,
  SESSION_MODES
} = require('../config/permissions');

const REDACTED_VALUE = '[REDACTED]';
const BINARY_OMITTED_VALUE = '[BINARY OMITTED]';
const FILE_CONTENT_OMITTED_VALUE = '[FILE CONTENT OMITTED]';
const CIRCULAR_VALUE = '[CIRCULAR]';
const MAX_DEPTH_VALUE = '[MAX DEPTH REACHED]';
const NODE_LIMIT_VALUE = '[NODE LIMIT REACHED]';

const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 8,
  maxArrayLength: 100,
  maxObjectKeys: 200,
  maxStringLength: 4096,
  maxNodes: 5000,
  maxSnapshotBytes: 64 * 1024,
  maxTotalSnapshotBytes: 128 * 1024
});

const actionSet = new Set(AUDIT_ACTION_VALUES);
const resourceTypeSet = new Set(AUDIT_RESOURCE_TYPE_VALUES);
const actorRoleSet = new Set(AUDIT_ACTOR_ROLE_VALUES);
const actorModeSet = new Set(AUDIT_ACTOR_MODE_VALUES);

const SENSITIVE_KEY_PARTS = Object.freeze([
  'password',
  'passwd',
  'pwd',
  'token',
  'authorization',
  'cookie',
  'secret',
  'apikey',
  'privatekey',
  'credential',
  'sessionid',
  'jwt',
  'signingkey'
]);

const ALWAYS_FILE_CONTENT_KEYS = new Set([
  'base64',
  'binary',
  'blob',
  'buffer',
  'bytes',
  'filebody',
  'filebytes',
  'filecontent',
  'filecontents',
  'filedata',
  'stream'
]);

const CONDITIONAL_FILE_CONTENT_KEYS = new Set([
  'body',
  'content',
  'contents',
  'data'
]);

const FILE_METADATA_KEYS = new Set([
  'destination',
  'encoding',
  'fieldname',
  'filename',
  'mimetype',
  'originalname',
  'size'
]);

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function isFileLikeObject(value) {
  if (!value || typeof value !== 'object') return false;

  const keys = Object.keys(value).map(normalizeKey);
  let metadataMatches = 0;
  for (const key of keys) {
    if (FILE_METADATA_KEYS.has(key)) metadataMatches += 1;
  }

  return metadataMatches >= 2 || (
    keys.includes('mimetype') &&
    (keys.includes('content') || keys.includes('data') || keys.includes('buffer'))
  );
}

function isFileContentKey(key, fileLikeParent) {
  const normalized = normalizeKey(key);
  return ALWAYS_FILE_CONTENT_KEYS.has(normalized) || (
    fileLikeParent && CONDITIONAL_FILE_CONTENT_KEYS.has(normalized)
  );
}

function validateIntegerLimit(name, value, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function normalizeLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('audit snapshot limits must be an object');
  }

  const limits = {
    ...DEFAULT_LIMITS,
    ...overrides
  };

  validateIntegerLimit('maxDepth', limits.maxDepth, 0);
  validateIntegerLimit('maxArrayLength', limits.maxArrayLength, 0);
  validateIntegerLimit('maxObjectKeys', limits.maxObjectKeys, 1);
  validateIntegerLimit('maxStringLength', limits.maxStringLength, 1);
  validateIntegerLimit('maxNodes', limits.maxNodes, 1);
  validateIntegerLimit('maxSnapshotBytes', limits.maxSnapshotBytes, 2);
  validateIntegerLimit('maxTotalSnapshotBytes', limits.maxTotalSnapshotBytes, 4);

  return Object.freeze(limits);
}

function truncateString(value, maxLength) {
  if (value.length <= maxLength) return value;

  const marker = '[TRUNCATED]';
  if (marker.length >= maxLength) return marker.slice(0, maxLength);
  return `${value.slice(0, maxLength - marker.length)}${marker}`;
}

function byteLength(value) {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized === undefined ? '' : serialized, 'utf8');
}

function utf8Prefix(value, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

function fitSnapshotToBytes(value, maxBytes, maxStringLength) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return value;
  }

  const base = {
    _truncated: true,
    originalBytes: Buffer.byteLength(serialized, 'utf8'),
    preview: ''
  };

  let low = 0;
  let high = Math.min(serialized.length, maxStringLength);
  let fitted = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      ...base,
      preview: utf8Prefix(serialized, middle)
    };
    if (byteLength(candidate) <= maxBytes) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (fitted) return fitted;

  const marker = '[SNAPSHOT TRUNCATED]';
  let markerLow = 0;
  let markerHigh = marker.length;
  let markerResult = '';
  while (markerLow <= markerHigh) {
    const middle = Math.floor((markerLow + markerHigh) / 2);
    const candidate = marker.slice(0, middle);
    if (byteLength(candidate) <= maxBytes) {
      markerResult = candidate;
      markerLow = middle + 1;
    } else {
      markerHigh = middle - 1;
    }
  }
  return markerResult;
}

function binaryPlaceholder(value) {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    return `${BINARY_OMITTED_VALUE.slice(0, -1)}: ${value.byteLength} bytes]`;
  }
  if (value instanceof ArrayBuffer) {
    return `${BINARY_OMITTED_VALUE.slice(0, -1)}: ${value.byteLength} bytes]`;
  }
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    return `${BINARY_OMITTED_VALUE.slice(0, -1)}: ${value.byteLength} bytes]`;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return `${BINARY_OMITTED_VALUE.slice(0, -1)}: ${value.size} bytes]`;
  }
  return null;
}

function normalizeSpecialObject(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.code === undefined ? {} : { code: value.code })
    };
  }
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (
    typeof value._bsontype === 'string' &&
    typeof value.toString === 'function'
  ) {
    return value.toString();
  }
  return null;
}

function sanitizeAuditSnapshot(value, options = {}) {
  const limits = normalizeLimits(options);
  const ancestors = new WeakSet();
  const state = { nodes: 0 };

  function visit(current, depth, parentIsFileLike = false, arrayItem = false) {
    state.nodes += 1;
    if (state.nodes > limits.maxNodes) return NODE_LIMIT_VALUE;

    if (current === null) return null;
    if (current === undefined) return arrayItem ? null : undefined;

    const valueType = typeof current;
    if (valueType === 'string') {
      return truncateString(current, limits.maxStringLength);
    }
    if (valueType === 'number') {
      return Number.isFinite(current) ? current : String(current);
    }
    if (valueType === 'boolean') return current;
    if (valueType === 'bigint') return current.toString();
    if (valueType === 'function' || valueType === 'symbol') {
      return arrayItem ? null : undefined;
    }

    const omittedBinary = binaryPlaceholder(current);
    if (omittedBinary !== null) return omittedBinary;

    const specialValue = normalizeSpecialObject(current);
    if (specialValue !== null) return visit(specialValue, depth, false, arrayItem);

    if (depth >= limits.maxDepth) return MAX_DEPTH_VALUE;
    if (ancestors.has(current)) return CIRCULAR_VALUE;

    let source = current;
    if (
      !Array.isArray(source) &&
      !(source instanceof Map) &&
      !(source instanceof Set) &&
      typeof source.toObject === 'function'
    ) {
      source = source.toObject({
        depopulate: true,
        flattenMaps: true,
        getters: false,
        virtuals: false,
        versionKey: false
      });
      if (!source || typeof source !== 'object') {
        return visit(source, depth, parentIsFileLike, arrayItem);
      }
    }

    if (ancestors.has(source)) return CIRCULAR_VALUE;
    ancestors.add(current);
    if (source !== current) ancestors.add(source);

    try {
      if (Array.isArray(source)) {
        if (limits.maxArrayLength === 0) return [];

        const isTruncated = source.length > limits.maxArrayLength;
        const itemLimit = isTruncated
          ? Math.max(0, limits.maxArrayLength - 1)
          : source.length;
        const output = source
          .slice(0, itemLimit)
          .map((item) => visit(item, depth + 1, false, true));
        if (isTruncated) {
          output.push(`[${source.length - itemLimit} ARRAY ITEMS OMITTED]`);
        }
        return output;
      }

      if (source instanceof Set) {
        return visit([...source], depth, false, arrayItem);
      }

      const entries = source instanceof Map
        ? [...source.entries()].map(([key, item]) => [String(key), item])
        : Object.entries(source);
      const output = {};
      const fileLike = parentIsFileLike || isFileLikeObject(source);
      const selectedEntries = entries.slice(0, limits.maxObjectKeys);

      for (const [key, item] of selectedEntries) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
          continue;
        }
        if (isSensitiveKey(key)) {
          output[key] = REDACTED_VALUE;
          continue;
        }
        if (isFileContentKey(key, fileLike)) {
          output[key] = FILE_CONTENT_OMITTED_VALUE;
          continue;
        }

        const sanitized = visit(item, depth + 1, fileLike, false);
        if (sanitized !== undefined) output[key] = sanitized;
      }

      if (entries.length > limits.maxObjectKeys) {
        output._omittedKeys = entries.length - limits.maxObjectKeys;
      }
      return output;
    } finally {
      ancestors.delete(current);
      if (source !== current) ancestors.delete(source);
    }
  }

  const sanitized = visit(value, 0);
  return fitSnapshotToBytes(
    sanitized,
    limits.maxSnapshotBytes,
    limits.maxStringLength
  );
}

function sanitizeAuditSnapshots({ before, after }, options = {}) {
  const limits = normalizeLimits(options);
  const suppliedCount = Number(before !== undefined) + Number(after !== undefined);
  if (suppliedCount === 0) return {};

  const allocatedBytes = Math.floor(
    limits.maxTotalSnapshotBytes / suppliedCount
  );
  const perSnapshotBytes = Math.min(limits.maxSnapshotBytes, allocatedBytes);
  const snapshotLimits = {
    ...limits,
    maxSnapshotBytes: perSnapshotBytes
  };

  return {
    ...(before === undefined
      ? {}
      : { before: sanitizeAuditSnapshot(before, snapshotLimits) }),
    ...(after === undefined
      ? {}
      : { after: sanitizeAuditSnapshot(after, snapshotLimits) })
  };
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id !== undefined) return normalizeId(value._id);

  const converted = typeof value.toString === 'function' ? value.toString() : '';
  return converted && converted !== '[object Object]' ? converted : null;
}

function boundedString(value, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).slice(0, maxLength);
}

function redactSensitiveText(value, maxLength) {
  if (value === null || value === undefined || value === '') return null;

  const redacted = String(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=:-]+/gi, '$1[REDACTED]')
    .replace(
      /\b(password|passwd|pwd|token|authorization|cookie|secret|api[_-]?key|credential)\s*([:=])\s*([^\r\n,;&]*)/gi,
      '$1$2[REDACTED]'
    );
  return boundedString(redacted, maxLength);
}

function readHeader(req, headerName) {
  if (!req) return null;
  if (typeof req.get === 'function') {
    const value = req.get(headerName);
    if (value !== undefined && value !== null) return value;
  }

  const headers = req.headers || {};
  const target = headerName.toLowerCase();
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === target);
  const value = matchingKey ? headers[matchingKey] : null;
  return Array.isArray(value) ? value[0] : value;
}

function requestPath(req) {
  if (!req) return null;
  const path = req.path && req.baseUrl
    ? `${req.baseUrl}${req.path}`
    : req.path || req.originalUrl || req.url;
  if (!path) return null;
  return String(path).split(/[?#]/, 1)[0];
}

function inferActorRole(context) {
  if (context.actorRole !== null && context.actorRole !== undefined) {
    if (!actorRoleSet.has(context.actorRole)) {
      throw new TypeError(`Unsupported audit actor role: ${context.actorRole}`);
    }
    return context.actorRole;
  }
  if (context.isSuperAdmin === true) return AUDIT_ACTOR_ROLES.SUPER_ADMIN;
  if (context.membership?.role === MEMBERSHIP_ROLES.PROJECT_ADMIN) {
    return AUDIT_ACTOR_ROLES.PROJECT_ADMIN;
  }
  return AUDIT_ACTOR_ROLES.MEMBER;
}

function buildAuditContext({
  req = null,
  authContext = null,
  targetTeamId = undefined,
  systemActor = false
} = {}) {
  const context = authContext || req?.authContext || null;
  let actorUserId = null;
  let actorRole;
  let actorMode;
  let activeTeamId = null;

  if (systemActor) {
    actorRole = AUDIT_ACTOR_ROLES.SYSTEM;
    actorMode = AUDIT_ACTOR_MODES.SYSTEM;
  } else {
    if (!context || typeof context !== 'object') {
      throw new TypeError('authContext is required for a user audit actor');
    }

    actorUserId = normalizeId(
      context.userId || context.user?._id || req?.user?._id
    );
    if (!actorUserId) {
      throw new TypeError('authContext must identify the audit actor user');
    }

    actorRole = inferActorRole(context);
    actorMode = context.actorMode || context.mode;
    activeTeamId = actorMode === SESSION_MODES.TEAM
      ? normalizeId(context.activeTeamId)
      : null;
  }

  if (!actorRoleSet.has(actorRole)) {
    throw new TypeError(`Unsupported audit actor role: ${actorRole}`);
  }
  if (!actorModeSet.has(actorMode)) {
    throw new TypeError(`Unsupported audit actor mode: ${actorMode}`);
  }
  if (actorMode === AUDIT_ACTOR_MODES.TEAM && !activeTeamId) {
    throw new TypeError('TEAM audit actor mode requires activeTeamId');
  }

  const resolvedTargetTeamId = normalizeId(
    targetTeamId === undefined
      ? context?.targetTeamId || activeTeamId
      : targetTeamId
  );
  const requestId = req?.id || req?.requestId ||
    readHeader(req, 'x-request-id') || readHeader(req, 'x-correlation-id');
  const ip = req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  const method = boundedString(req?.method, 16)?.toUpperCase() || null;

  return Object.freeze({
    actorUserId,
    actorRole,
    actorMode,
    activeTeamId,
    targetTeamId: resolvedTargetTeamId,
    requestId: redactSensitiveText(requestId, 128),
    requestMethod: method,
    requestPath: boundedString(requestPath(req), 1000),
    ip: boundedString(ip, 64),
    userAgent: redactSensitiveText(readHeader(req, 'user-agent'), 1000)
  });
}

function assertConfiguredValue(value, allowedValues, fieldName) {
  if (typeof value !== 'string' || !allowedValues.has(value)) {
    throw new TypeError(`${fieldName} is not configured in config/permissions`);
  }
}

function createAuditService(options = {}) {
  const AuditLog = options.AuditLog || require('../models/AuditLog');
  const limits = normalizeLimits(options.limits || {});
  if (!AuditLog || typeof AuditLog.create !== 'function') {
    throw new TypeError('AuditLog model with a create function is required');
  }

  function buildPayload({
    req = null,
    authContext = null,
    systemActor = false,
    action,
    resourceType,
    resourceId = null,
    before,
    after,
    reason = null,
    targetTeamId
  } = {}) {
    assertConfiguredValue(action, actionSet, 'action');
    assertConfiguredValue(resourceType, resourceTypeSet, 'resourceType');

    const contextFields = buildAuditContext({
      req,
      authContext,
      targetTeamId,
      systemActor
    });
    const snapshots = sanitizeAuditSnapshots({ before, after }, limits);
    return {
      ...contextFields,
      action,
      resourceType,
      resourceId: redactSensitiveText(normalizeId(resourceId), 128),
      ...snapshots,
      reason: redactSensitiveText(reason, 2000)
    };
  }

  async function record({ session = null, ...input } = {}) {
    const payload = buildPayload(input);

    // Mongoose requires an array form when create options (notably session)
    // must be applied to every inserted document.
    if (session) {
      const created = await AuditLog.create([payload], { session });
      return Array.isArray(created) ? created[0] : created;
    }

    return AuditLog.create(payload);
  }

  async function recordMany(inputs, { session = null } = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) return { insertedCount: 0 };
    if (typeof AuditLog.bulkWrite !== 'function') {
      throw new TypeError('AuditLog model with a bulkWrite function is required');
    }
    const operations = inputs.map((input) => ({
      insertOne: { document: buildPayload(input) }
    }));
    const result = await AuditLog.bulkWrite(operations, { session, ordered: true });
    if (result.insertedCount !== operations.length) {
      throw new Error('Audit bulk insert count mismatch');
    }
    return result;
  }

  async function recordManySystem(inputs, { session = null } = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new TypeError('recordManySystem requires a non-empty input array');
    }
    if (typeof AuditLog.bulkWrite !== 'function') {
      throw new TypeError('AuditLog model with a bulkWrite function is required');
    }
    const operations = inputs.map((input) => ({
      insertOne: { document: buildPayload({ ...input, systemActor: true }) }
    }));
    const result = await AuditLog.bulkWrite(operations, { session, ordered: true });
    if (result.insertedCount !== operations.length) {
      throw new Error('Audit bulk insert count mismatch');
    }
    return result;
  }

  return Object.freeze({
    record,
    recordMany,
    recordSystem(input = {}) {
      return record({ ...input, systemActor: true });
    },
    recordManySystem
  });
}

module.exports = {
  BINARY_OMITTED_VALUE,
  CIRCULAR_VALUE,
  DEFAULT_LIMITS,
  FILE_CONTENT_OMITTED_VALUE,
  MAX_DEPTH_VALUE,
  NODE_LIMIT_VALUE,
  REDACTED_VALUE,
  buildAuditContext,
  byteLength,
  createAuditService,
  isSensitiveKey,
  normalizeLimits,
  sanitizeAuditSnapshot,
  sanitizeAuditSnapshots
};
