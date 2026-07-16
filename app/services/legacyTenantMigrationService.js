'use strict';

const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_MODES,
  AUDIT_ACTOR_ROLES,
  AUDIT_RESOURCE_TYPES,
  DATA_SCOPE_MODULE_VALUES,
  DATA_SCOPES,
  FUNCTIONAL_ROLE_KEY_VALUES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUS_VALUES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES,
  PERMISSIONS_BY_MODULE,
  PERMISSION_KEYS,
  POSITION_KEYS,
  POSITION_LEVEL_BY_KEY,
  TEAM_STATUSES,
  deriveModuleDataScopes
} = require('../config/permissions');
const {
  REQUIRED_BACKUP_COLLECTIONS,
  verifyBackupManifest
} = require('./migrationBackupManifestService');

const TARGET_TEAM = Object.freeze({
  code: 'GEARBOX_LOGISTICS',
  name: '变速箱物流部'
});
const TARGET_ROOT_ORG = Object.freeze({
  code: 'GEARBOX_LOGISTICS_ROOT',
  name: '变速箱物流部',
  type: ORG_UNIT_TYPES.DEPARTMENT,
  level: 1,
  path: '/'
});
const SAFE_DATABASE_SUFFIXES = Object.freeze(['_v2_dev', '_v2_test', '_v2_staging']);
const COLLECTIONS = Object.freeze({
  users: 'users',
  tasks: 'tasks',
  taskreviews: 'taskreviews',
  extensionrequests: 'extensionrequests',
  messages: 'messages',
  fileassets: 'fileassets',
  projectteams: 'projectteams',
  orgunits: 'orgunits',
  teammemberships: 'teammemberships',
  auditlogs: 'audit_logs'
});
const LEGACY_ROLE_VALUES = new Set(['admin', 'executor', 'cc']);
const KNOWN_FILE_TASK_OWNER_TYPES = new Set(['TASK', 'TASK_COMPLETION']);
const KNOWN_FILE_REVIEW_OWNER_TYPES = new Set(['TASK_REVIEW']);
const PERMISSION_SET = new Set(PERMISSION_KEYS);
const PROJECT_ADMIN_PERMISSIONS = Object.freeze([
  'member.view',
  'member.manage',
  'org.manage',
  'reporter.assign',
  'audit.view'
]);
const ROLE_PERMISSION_MAP = Object.freeze({
  admin: Object.freeze([
    ...PERMISSIONS_BY_MODULE.task,
    ...PROJECT_ADMIN_PERMISSIONS
  ]),
  executor: Object.freeze(['task.view', 'task.edit']),
  cc: Object.freeze(['task.view', 'task.review'])
});
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const MAX_ANOMALY_DETAILS = 500;

class LegacyTenantMigrationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'LegacyTenantMigrationError';
    this.code = code;
    this.details = details;
  }
}

function migrationError(code, message, details) {
  throw new LegacyTenantMigrationError(code, message, details);
}

function normalizeUsername(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase()
    : null;
}

function idString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value.toHexString === 'function') return value.toHexString().toLowerCase();
  return String(value).toLowerCase();
}

function isObjectId(value) {
  const normalized = idString(value);
  return Boolean(normalized && OBJECT_ID_PATTERN.test(normalized));
}

function sameId(left, right) {
  const normalizedLeft = idString(left);
  const normalizedRight = idString(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

function createObjectId(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return new mongoose.Types.ObjectId();
  }
  if (!isObjectId(value)) {
    migrationError('MIGRATION_OBJECT_ID_INVALID', `${fieldName} must be a 24 character ObjectId`);
  }
  return new mongoose.Types.ObjectId(idString(value));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function arrayEquals(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeDate(value, fallback) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : fallback;
}

function projectAdminRole(roles) {
  return Array.isArray(roles) && roles.includes('admin');
}

function permissionsForLegacyRoles(roles) {
  if (!Array.isArray(roles)) return [];
  return uniqueSorted(roles.flatMap((role) => ROLE_PERMISSION_MAP[role] || []));
}

function defaultModuleDataScopes() {
  return DATA_SCOPE_MODULE_VALUES.map((moduleKey) => ({
    moduleKey,
    scope: DATA_SCOPES.ORG_UNIT
  }));
}

function createAnomalyCollector(maxDetails = MAX_ANOMALY_DETAILS) {
  const details = [];
  const counts = {};
  let total = 0;
  let blockerCount = 0;
  let warningCount = 0;

  return Object.freeze({
    add(code, severity, input = {}) {
      total += 1;
      counts[code] = (counts[code] || 0) + 1;
      if (severity === 'BLOCKER') blockerCount += 1;
      if (severity === 'WARNING') warningCount += 1;
      if (details.length < maxDetails) {
        details.push({ code, severity, ...input });
      }
    },
    result() {
      return {
        total,
        blockerCount,
        warningCount,
        counts,
        details,
        truncated: total > details.length
      };
    }
  });
}

function addAnomaly(collector, code, severity, collection, document, field, message, extra = {}) {
  collector.add(code, severity, {
    collection,
    documentId: idString(document?._id),
    field,
    message,
    ...extra
  });
}

function findOptions(session, projection) {
  return session ? { session, projection } : { projection };
}

async function loadSnapshot(db, session = null) {
  const find = (name, projection) => db.collection(name)
    .find({}, findOptions(session, projection))
    .toArray();

  const [
    users,
    tasks,
    taskreviews,
    extensionrequests,
    messages,
    fileassets,
    projectteams,
    orgunits,
    teammemberships
  ] = await Promise.all([
    find(COLLECTIONS.users, {
      _id: 1,
      username: 1,
      usernameNormalized: 1,
      isSuperAdmin: 1,
      isSystemAccount: 1,
      tokenVersion: 1,
      roles: 1,
      status: 1,
      createdAt: 1
    }),
    find(COLLECTIONS.tasks, {
      _id: 1,
      teamId: 1,
      orgUnitId: 1,
      creator: 1,
      executor: 1,
      mainExecutor: 1,
      ccUsers: 1,
      completedBy: 1,
      confirmedBy: 1,
      parentTask: 1,
      attachments: 1,
      completionAttachments: 1,
      executorCompletions: 1
    }),
    find(COLLECTIONS.taskreviews, {
      _id: 1,
      teamId: 1,
      task: 1,
      reviewer: 1,
      attachments: 1
    }),
    find(COLLECTIONS.extensionrequests, {
      _id: 1,
      teamId: 1,
      task: 1,
      applicant: 1,
      approver: 1
    }),
    find(COLLECTIONS.messages, {
      _id: 1,
      teamId: 1,
      recipient: 1,
      sender: 1,
      relatedTask: 1,
      relatedExtension: 1
    }),
    find(COLLECTIONS.fileassets, {
      _id: 1,
      teamId: 1,
      ownerType: 1,
      ownerId: 1,
      storageKey: 1,
      uploaderId: 1,
      status: 1,
      deletedBy: 1
    }),
    find(COLLECTIONS.projectteams, {
      _id: 1,
      code: 1,
      name: 1,
      status: 1,
      createdBy: 1,
      settings: 1
    }),
    find(COLLECTIONS.orgunits, {
      _id: 1,
      teamId: 1,
      parentId: 1,
      type: 1,
      code: 1,
      name: 1,
      status: 1,
      level: 1,
      path: 1
    }),
    find(COLLECTIONS.teammemberships, {
      _id: 1,
      teamId: 1,
      userId: 1,
      orgUnitId: 1,
      role: 1,
      positionKey: 1,
      positionLevel: 1,
      functionalRoleKeys: 1,
      permissionKeys: 1,
      moduleDataScopes: 1,
      status: 1,
      joinedAt: 1,
      createdAt: 1
    })
  ]);

  return {
    users,
    tasks,
    taskreviews,
    extensionrequests,
    messages,
    fileassets,
    projectteams,
    orgunits,
    teammemberships
  };
}

function resolveTarget(snapshot, collector, plannedTeamId, plannedRootOrgId) {
  const codeMatches = snapshot.projectteams.filter(
    (team) => String(team.code || '').trim().toUpperCase() === TARGET_TEAM.code
  );
  const nameMatches = snapshot.projectteams.filter(
    (team) => String(team.name || '').trim() === TARGET_TEAM.name
  );

  if (codeMatches.length > 1) {
    collector.add('TARGET_TEAM_CODE_DUPLICATE', 'BLOCKER', {
      collection: COLLECTIONS.projectteams,
      field: 'code',
      message: 'More than one project team uses the migration team code'
    });
  }
  if (nameMatches.some((team) => !codeMatches.some((candidate) => sameId(candidate._id, team._id)))) {
    collector.add('TARGET_TEAM_NAME_CONFLICT', 'BLOCKER', {
      collection: COLLECTIONS.projectteams,
      field: 'name',
      message: 'The target team name is already used by another team code'
    });
  }

  const existingTeam = codeMatches[0] || null;
  if (existingTeam && String(existingTeam.name || '').trim() !== TARGET_TEAM.name) {
    addAnomaly(
      collector,
      'TARGET_TEAM_CODE_CONFLICT',
      'BLOCKER',
      COLLECTIONS.projectteams,
      existingTeam,
      'name',
      'The target team code exists with a different name'
    );
  }
  if (existingTeam && existingTeam.status !== TEAM_STATUSES.ACTIVE) {
    addAnomaly(
      collector,
      'TARGET_TEAM_NOT_ACTIVE',
      'BLOCKER',
      COLLECTIONS.projectteams,
      existingTeam,
      'status',
      'The migration target team exists but is not active'
    );
  }
  const teamId = existingTeam?._id || plannedTeamId;

  const targetOrgUnits = snapshot.orgunits.filter((unit) => sameId(unit.teamId, teamId));
  const rootCodeMatches = targetOrgUnits.filter(
    (unit) => String(unit.code || '').trim().toUpperCase() === TARGET_ROOT_ORG.code
  );
  const rootNameMatches = targetOrgUnits.filter(
    (unit) => String(unit.name || '').trim() === TARGET_ROOT_ORG.name && isMissing(unit.parentId)
  );
  if (rootCodeMatches.length > 1) {
    collector.add('TARGET_ROOT_CODE_DUPLICATE', 'BLOCKER', {
      collection: COLLECTIONS.orgunits,
      field: 'code',
      message: 'More than one organization unit uses the migration root code'
    });
  }
  if (
    rootNameMatches.some(
      (unit) => !rootCodeMatches.some((candidate) => sameId(candidate._id, unit._id))
    )
  ) {
    collector.add('TARGET_ROOT_NAME_CONFLICT', 'BLOCKER', {
      collection: COLLECTIONS.orgunits,
      field: 'name',
      message: 'The target root organization name is already used by another root code'
    });
  }

  const existingRoot = rootCodeMatches[0] || null;
  if (existingRoot && (
    !isMissing(existingRoot.parentId) ||
    existingRoot.type !== TARGET_ROOT_ORG.type ||
    existingRoot.level !== TARGET_ROOT_ORG.level ||
    existingRoot.path !== TARGET_ROOT_ORG.path ||
    String(existingRoot.name || '').trim() !== TARGET_ROOT_ORG.name ||
    existingRoot.status !== ORG_UNIT_STATUSES.ACTIVE
  )) {
    addAnomaly(
      collector,
      'TARGET_ROOT_SHAPE_CONFLICT',
      'BLOCKER',
      COLLECTIONS.orgunits,
      existingRoot,
      'code',
      'The target root organization exists with an incompatible hierarchy shape'
    );
  }

  return {
    team: existingTeam,
    teamId,
    rootOrg: existingRoot,
    rootOrgId: existingRoot?._id || plannedRootOrgId
  };
}

function inspectTeamField({
  collector,
  collection,
  documents,
  targetTeamId
}) {
  let missingTeamId = 0;
  let targetTeamIdCount = 0;
  let otherTeamId = 0;
  const distinctOtherTeamIds = [];

  for (const document of documents) {
    if (isMissing(document.teamId)) {
      missingTeamId += 1;
      continue;
    }
    if (!isObjectId(document.teamId)) {
      otherTeamId += 1;
      addAnomaly(
        collector,
        'TEAM_ID_INVALID',
        'BLOCKER',
        collection,
        document,
        'teamId',
        'teamId is not a valid ObjectId'
      );
      continue;
    }
    if (sameId(document.teamId, targetTeamId)) {
      targetTeamIdCount += 1;
      continue;
    }
    otherTeamId += 1;
    distinctOtherTeamIds.push(idString(document.teamId));
    addAnomaly(
      collector,
      'OTHER_TEAM_ID_PRESENT',
      'BLOCKER',
      collection,
      document,
      'teamId',
      'A legacy collection contains a teamId outside the migration target',
      { referenceId: idString(document.teamId) }
    );
  }

  return {
    total: documents.length,
    missingTeamId,
    targetTeamId: targetTeamIdCount,
    otherTeamId,
    distinctOtherTeamIds: uniqueSorted(distinctOtherTeamIds)
  };
}

function inspectUserIdentity(snapshot, collector, requestedSuperAdminUsername) {
  const desiredUsernameGroups = new Map();
  const userIdSet = new Set();
  const canonicalByUserId = new Map();

  for (const user of snapshot.users) {
    const userId = idString(user._id);
    if (!isObjectId(user._id)) {
      addAnomaly(
        collector,
        'USER_ID_INVALID',
        'BLOCKER',
        COLLECTIONS.users,
        user,
        '_id',
        'User _id is not a valid ObjectId'
      );
      continue;
    }
    userIdSet.add(userId);
    const canonical = normalizeUsername(user.username);
    canonicalByUserId.set(userId, canonical);
    if (!canonical || canonical.length < 3 || canonical.length > 50) {
      addAnomaly(
        collector,
        'USERNAME_CANONICAL_INVALID',
        'BLOCKER',
        COLLECTIONS.users,
        user,
        'username',
        'Username cannot be normalized to a valid global username'
      );
      continue;
    }
    const group = desiredUsernameGroups.get(canonical) || [];
    group.push(user);
    desiredUsernameGroups.set(canonical, group);

    if (!Array.isArray(user.roles)) {
      addAnomaly(
        collector,
        'LEGACY_ROLES_INVALID',
        'BLOCKER',
        COLLECTIONS.users,
        user,
        'roles',
        'Legacy roles must be an array before permission migration'
      );
    } else {
      for (const role of user.roles) {
        if (!LEGACY_ROLE_VALUES.has(role)) {
          addAnomaly(
            collector,
            'LEGACY_ROLE_UNKNOWN',
            'BLOCKER',
            COLLECTIONS.users,
            user,
            'roles',
            'An unknown legacy role has no fixed permission mapping',
            { value: String(role) }
          );
        }
      }
    }

    if (
      !isMissing(user.tokenVersion) &&
      (!Number.isInteger(user.tokenVersion) || user.tokenVersion < 0)
    ) {
      addAnomaly(
        collector,
        'TOKEN_VERSION_INVALID',
        'BLOCKER',
        COLLECTIONS.users,
        user,
        'tokenVersion',
        'Existing tokenVersion must be a non-negative integer'
      );
    }
  }

  const collisions = [];
  for (const [canonical, users] of desiredUsernameGroups) {
    if (users.length <= 1) continue;
    collisions.push({
      usernameNormalized: canonical,
      userIds: users.map((user) => idString(user._id)).sort()
    });
    for (const user of users) {
      addAnomaly(
        collector,
        'USERNAME_NORMALIZED_COLLISION',
        'BLOCKER',
        COLLECTIONS.users,
        user,
        'usernameNormalized',
        'Multiple usernames normalize to the same global identity',
        { value: canonical }
      );
    }
  }

  const normalizedRequested = normalizeUsername(requestedSuperAdminUsername);
  const selectedUsers = normalizedRequested
    ? snapshot.users.filter(
      (user) => canonicalByUserId.get(idString(user._id)) === normalizedRequested
    )
    : [];
  if (normalizedRequested && selectedUsers.length !== 1) {
    collector.add('SUPER_ADMIN_NOT_UNIQUE', 'BLOCKER', {
      collection: COLLECTIONS.users,
      field: 'username',
      message: 'The requested super administrator must resolve to exactly one user',
      value: normalizedRequested,
      matchCount: selectedUsers.length
    });
  }
  const selectedUser = selectedUsers.length === 1 ? selectedUsers[0] : null;
  if (!normalizedRequested) {
    collector.add('SUPER_ADMIN_NOT_SELECTED', 'WARNING', {
      collection: COLLECTIONS.users,
      field: 'username',
      message: 'Dry-run inventory has no selected super administrator'
    });
  }

  if (selectedUser) {
    for (const user of snapshot.users) {
      if (
        user.isSuperAdmin === true &&
        user.isSystemAccount !== true &&
        !sameId(user._id, selectedUser._id)
      ) {
        addAnomaly(
          collector,
          'UNEXPECTED_EXISTING_SUPER_ADMIN',
          'BLOCKER',
          COLLECTIONS.users,
          user,
          'isSuperAdmin',
          'Another user is already marked as super administrator'
        );
      }
    }
  }

  return {
    userIdSet,
    canonicalByUserId,
    collisions,
    normalizedRequested,
    selectedUser
  };
}

function inspectReference({
  collector,
  collection,
  document,
  field,
  value,
  targetIds,
  required = false,
  code = 'ORPHAN_USER_REFERENCE'
}) {
  if (isMissing(value)) {
    if (required) {
      addAnomaly(
        collector,
        `${code}_MISSING`,
        'BLOCKER',
        collection,
        document,
        field,
        `Required reference ${field} is missing`
      );
    }
    return;
  }
  if (!isObjectId(value) || !targetIds.has(idString(value))) {
    addAnomaly(
      collector,
      code,
      'BLOCKER',
      collection,
      document,
      field,
      `Reference ${field} does not resolve to an existing document`,
      { referenceId: idString(value) }
    );
  }
}

function inspectReferenceArray({
  collector,
  collection,
  document,
  field,
  values,
  targetIds
}) {
  if (isMissing(values)) return;
  if (!Array.isArray(values)) {
    addAnomaly(
      collector,
      'REFERENCE_ARRAY_INVALID',
      'BLOCKER',
      collection,
      document,
      field,
      `${field} must be an array`
    );
    return;
  }
  for (const value of values) {
    inspectReference({
      collector,
      collection,
      document,
      field,
      value,
      targetIds,
      code: 'ORPHAN_USER_REFERENCE'
    });
  }
}

function attachmentStats(snapshot) {
  const result = {
    documents: 0,
    files: 0,
    declaredBytes: 0,
    sources: {
      taskAttachments: 0,
      taskCompletionAttachments: 0,
      executorCompletionAttachments: 0,
      taskReviewAttachments: 0
    },
    disposition: 'PENDING_FILE_ASSET_MIGRATION',
    diskFilesTouched: false
  };
  const documents = new Set();

  function add(source, owner, attachments) {
    if (!Array.isArray(attachments)) return;
    if (attachments.length > 0) documents.add(idString(owner._id));
    result.sources[source] += attachments.length;
    result.files += attachments.length;
    for (const attachment of attachments) {
      if (Number.isFinite(attachment?.size) && attachment.size >= 0) {
        result.declaredBytes += attachment.size;
      }
    }
  }

  for (const task of snapshot.tasks) {
    add('taskAttachments', task, task.attachments);
    add('taskCompletionAttachments', task, task.completionAttachments);
    if (Array.isArray(task.executorCompletions)) {
      for (const completion of task.executorCompletions) {
        add('executorCompletionAttachments', task, completion?.attachments);
      }
    }
  }
  for (const review of snapshot.taskreviews) {
    add('taskReviewAttachments', review, review.attachments);
  }
  result.documents = documents.size;
  return result;
}

function inspectBusinessReferences(snapshot, collector, target, identity) {
  const taskIds = new Set(snapshot.tasks.map((task) => idString(task._id)));
  const reviewIds = new Set(snapshot.taskreviews.map((review) => idString(review._id)));
  const extensionIds = new Set(
    snapshot.extensionrequests.map((request) => idString(request._id))
  );
  const orgById = new Map(snapshot.orgunits.map((unit) => [idString(unit._id), unit]));
  const taskById = new Map(snapshot.tasks.map((task) => [idString(task._id), task]));
  const extensionById = new Map(
    snapshot.extensionrequests.map((request) => [idString(request._id), request])
  );

  let missingTaskOrgUnitId = 0;
  for (const task of snapshot.tasks) {
    if (!isObjectId(task._id)) {
      addAnomaly(
        collector,
        'TASK_ID_INVALID',
        'BLOCKER',
        COLLECTIONS.tasks,
        task,
        '_id',
        'Task _id is not a valid ObjectId'
      );
    }
    if (isMissing(task.orgUnitId)) {
      missingTaskOrgUnitId += 1;
    } else {
      const org = orgById.get(idString(task.orgUnitId));
      if (!org || !sameId(org.teamId, target.teamId)) {
        addAnomaly(
          collector,
          'TASK_ORG_UNIT_INVALID',
          'BLOCKER',
          COLLECTIONS.tasks,
          task,
          'orgUnitId',
          'Existing task orgUnitId must resolve inside the target team',
          { referenceId: idString(task.orgUnitId) }
        );
      }
    }
    inspectReference({
      collector,
      collection: COLLECTIONS.tasks,
      document: task,
      field: 'creator',
      value: task.creator,
      targetIds: identity.userIdSet,
      required: true
    });
    inspectReferenceArray({
      collector,
      collection: COLLECTIONS.tasks,
      document: task,
      field: 'executor',
      values: task.executor,
      targetIds: identity.userIdSet
    });
    inspectReferenceArray({
      collector,
      collection: COLLECTIONS.tasks,
      document: task,
      field: 'ccUsers',
      values: task.ccUsers,
      targetIds: identity.userIdSet
    });
    for (const field of ['mainExecutor', 'completedBy', 'confirmedBy']) {
      inspectReference({
        collector,
        collection: COLLECTIONS.tasks,
        document: task,
        field,
        value: task[field],
        targetIds: identity.userIdSet
      });
    }
    if (Array.isArray(task.executorCompletions)) {
      for (const completion of task.executorCompletions) {
        inspectReference({
          collector,
          collection: COLLECTIONS.tasks,
          document: task,
          field: 'executorCompletions.executor',
          value: completion?.executor,
          targetIds: identity.userIdSet,
          required: true
        });
      }
    }
    inspectReference({
      collector,
      collection: COLLECTIONS.tasks,
      document: task,
      field: 'parentTask',
      value: task.parentTask,
      targetIds: taskIds,
      code: 'ORPHAN_TASK_REFERENCE'
    });
    if (sameId(task.parentTask, task._id)) {
      addAnomaly(
        collector,
        'TASK_PARENT_SELF_REFERENCE',
        'BLOCKER',
        COLLECTIONS.tasks,
        task,
        'parentTask',
        'A task cannot be its own parent'
      );
    }
  }

  for (const review of snapshot.taskreviews) {
    inspectReference({
      collector,
      collection: COLLECTIONS.taskreviews,
      document: review,
      field: 'task',
      value: review.task,
      targetIds: taskIds,
      required: true,
      code: 'ORPHAN_TASK_REFERENCE'
    });
    inspectReference({
      collector,
      collection: COLLECTIONS.taskreviews,
      document: review,
      field: 'reviewer',
      value: review.reviewer,
      targetIds: identity.userIdSet,
      required: true
    });
    const task = taskById.get(idString(review.task));
    if (task && !isMissing(review.teamId) && !isMissing(task.teamId) && !sameId(review.teamId, task.teamId)) {
      addAnomaly(
        collector,
        'RELATED_TEAM_MISMATCH',
        'BLOCKER',
        COLLECTIONS.taskreviews,
        review,
        'teamId',
        'Task review and task teamId values differ'
      );
    }
  }

  for (const request of snapshot.extensionrequests) {
    inspectReference({
      collector,
      collection: COLLECTIONS.extensionrequests,
      document: request,
      field: 'task',
      value: request.task,
      targetIds: taskIds,
      required: true,
      code: 'ORPHAN_TASK_REFERENCE'
    });
    inspectReference({
      collector,
      collection: COLLECTIONS.extensionrequests,
      document: request,
      field: 'applicant',
      value: request.applicant,
      targetIds: identity.userIdSet,
      required: true
    });
    inspectReference({
      collector,
      collection: COLLECTIONS.extensionrequests,
      document: request,
      field: 'approver',
      value: request.approver,
      targetIds: identity.userIdSet
    });
    const task = taskById.get(idString(request.task));
    if (task && !isMissing(request.teamId) && !isMissing(task.teamId) && !sameId(request.teamId, task.teamId)) {
      addAnomaly(
        collector,
        'RELATED_TEAM_MISMATCH',
        'BLOCKER',
        COLLECTIONS.extensionrequests,
        request,
        'teamId',
        'Extension request and task teamId values differ'
      );
    }
  }

  for (const message of snapshot.messages) {
    inspectReference({
      collector,
      collection: COLLECTIONS.messages,
      document: message,
      field: 'recipient',
      value: message.recipient,
      targetIds: identity.userIdSet,
      required: true
    });
    inspectReference({
      collector,
      collection: COLLECTIONS.messages,
      document: message,
      field: 'sender',
      value: message.sender,
      targetIds: identity.userIdSet
    });
    inspectReference({
      collector,
      collection: COLLECTIONS.messages,
      document: message,
      field: 'relatedTask',
      value: message.relatedTask,
      targetIds: taskIds,
      code: 'ORPHAN_TASK_REFERENCE'
    });
    inspectReference({
      collector,
      collection: COLLECTIONS.messages,
      document: message,
      field: 'relatedExtension',
      value: message.relatedExtension,
      targetIds: extensionIds,
      code: 'ORPHAN_EXTENSION_REFERENCE'
    });
    const task = taskById.get(idString(message.relatedTask));
    const extension = extensionById.get(idString(message.relatedExtension));
    if (
      task &&
      extension &&
      !sameId(extension.task, task._id)
    ) {
      addAnomaly(
        collector,
        'MESSAGE_RELATED_RESOURCES_INCONSISTENT',
        'BLOCKER',
        COLLECTIONS.messages,
        message,
        'relatedExtension',
        'Message relatedTask does not match the task referenced by relatedExtension'
      );
    }
    for (const related of [task, extension]) {
      if (
        related &&
        !isMissing(message.teamId) &&
        !isMissing(related.teamId) &&
        !sameId(message.teamId, related.teamId)
      ) {
        addAnomaly(
          collector,
          'RELATED_TEAM_MISMATCH',
          'BLOCKER',
          COLLECTIONS.messages,
          message,
          'teamId',
          'Message and related resource teamId values differ'
        );
      }
    }
  }

  for (const file of snapshot.fileassets) {
    inspectReference({
      collector,
      collection: COLLECTIONS.fileassets,
      document: file,
      field: 'uploaderId',
      value: file.uploaderId,
      targetIds: identity.userIdSet,
      required: true
    });
    inspectReference({
      collector,
      collection: COLLECTIONS.fileassets,
      document: file,
      field: 'deletedBy',
      value: file.deletedBy,
      targetIds: identity.userIdSet
    });
    if (KNOWN_FILE_TASK_OWNER_TYPES.has(file.ownerType)) {
      inspectReference({
        collector,
        collection: COLLECTIONS.fileassets,
        document: file,
        field: 'ownerId',
        value: file.ownerId,
        targetIds: taskIds,
        required: true,
        code: 'ORPHAN_FILE_OWNER_REFERENCE'
      });
    } else if (KNOWN_FILE_REVIEW_OWNER_TYPES.has(file.ownerType)) {
      inspectReference({
        collector,
        collection: COLLECTIONS.fileassets,
        document: file,
        field: 'ownerId',
        value: file.ownerId,
        targetIds: reviewIds,
        required: true,
        code: 'ORPHAN_FILE_OWNER_REFERENCE'
      });
    } else if (file.ownerType === 'TEMPORARY') {
      if (!isMissing(file.ownerId)) {
        addAnomaly(
          collector,
          'TEMPORARY_FILE_OWNER_INVALID',
          'BLOCKER',
          COLLECTIONS.fileassets,
          file,
          'ownerId',
          'Temporary file assets cannot have an ownerId'
        );
      }
    } else {
      addAnomaly(
        collector,
        'FILE_OWNER_COLLECTION_NOT_IN_MIGRATION_SCOPE',
        'WARNING',
        COLLECTIONS.fileassets,
        file,
        'ownerType',
        'The owner collection is outside this legacy task-data migration scope',
        { value: String(file.ownerType || '') }
      );
    }
    const storageTeamPrefix = typeof file.storageKey === 'string'
      ? file.storageKey.split('/')[0]
      : null;
    if (!isObjectId(storageTeamPrefix) || !sameId(storageTeamPrefix, target.teamId)) {
      addAnomaly(
        collector,
        'FILE_STORAGE_KEY_REQUIRES_LATER_RECONCILIATION',
        'WARNING',
        COLLECTIONS.fileassets,
        file,
        'storageKey',
        'File bytes are not moved; storage key layout must be reconciled in the later FileAsset migration'
      );
    }
  }

  return {
    missingTaskOrgUnitId,
    taskIds,
    reviewIds,
    extensionIds
  };
}

function validMembershipPermissions(permissionKeys) {
  return Array.isArray(permissionKeys) &&
    new Set(permissionKeys).size === permissionKeys.length &&
    permissionKeys.every((key) => PERMISSION_SET.has(key));
}

function inspectMemberships(snapshot, collector, target, identity) {
  const targetMemberships = new Map();
  const orgById = new Map(snapshot.orgunits.map((unit) => [idString(unit._id), unit]));
  let otherTeamId = 0;

  for (const membership of snapshot.teammemberships) {
    if (!sameId(membership.teamId, target.teamId)) {
      otherTeamId += 1;
      addAnomaly(
        collector,
        'OTHER_TEAM_MEMBERSHIP_PRESENT',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'teamId',
        'Single-team legacy migration cannot run with memberships in another team',
        { referenceId: idString(membership.teamId) }
      );
      continue;
    }
    const userId = idString(membership.userId);
    if (!identity.userIdSet.has(userId)) {
      addAnomaly(
        collector,
        'ORPHAN_MEMBERSHIP_USER',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'userId',
        'Membership userId does not resolve to a legacy user',
        { referenceId: userId }
      );
      continue;
    }
    if (targetMemberships.has(userId)) {
      addAnomaly(
        collector,
        'TARGET_MEMBERSHIP_DUPLICATE',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'userId',
        'More than one target membership exists for the same user',
        { referenceId: userId }
      );
      continue;
    }
    targetMemberships.set(userId, membership);

    const org = orgById.get(idString(membership.orgUnitId));
    if (!org || !sameId(org.teamId, target.teamId)) {
      addAnomaly(
        collector,
        'MEMBERSHIP_ORG_UNIT_INVALID',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'orgUnitId',
        'Existing membership orgUnitId must resolve inside the target team',
        { referenceId: idString(membership.orgUnitId) }
      );
    }
    if (!Object.values(MEMBERSHIP_ROLES).includes(membership.role)) {
      addAnomaly(
        collector,
        'MEMBERSHIP_ROLE_INVALID',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'role',
        'Existing membership role is invalid'
      );
    }
    if (!Object.values(POSITION_KEYS).includes(membership.positionKey)) {
      addAnomaly(
        collector,
        'MEMBERSHIP_POSITION_INVALID',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'positionKey',
        'Existing membership positionKey is invalid'
      );
    } else if (membership.positionLevel !== POSITION_LEVEL_BY_KEY[membership.positionKey]) {
      addAnomaly(
        collector,
        'MEMBERSHIP_POSITION_LEVEL_INVALID',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'positionLevel',
        'Existing membership positionLevel does not match positionKey'
      );
    }
    if (!validMembershipPermissions(membership.permissionKeys)) {
      addAnomaly(
        collector,
        'MEMBERSHIP_PERMISSIONS_INVALID',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'permissionKeys',
        'Existing membership permissions contain invalid or duplicate keys'
      );
    }
    if (!MEMBERSHIP_STATUS_VALUES.includes(membership.status)) {
      addAnomaly(
        collector,
        'MEMBERSHIP_STATUS_INVALID',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'status',
        'Existing membership status is invalid'
      );
    }
    if (
      !Array.isArray(membership.functionalRoleKeys) ||
      new Set(membership.functionalRoleKeys).size !== membership.functionalRoleKeys.length ||
      membership.functionalRoleKeys.some(
        (roleKey) => !FUNCTIONAL_ROLE_KEY_VALUES.includes(roleKey)
      )
    ) {
      addAnomaly(
        collector,
        'MEMBERSHIP_FUNCTIONAL_ROLES_INVALID',
        'BLOCKER',
        COLLECTIONS.teammemberships,
        membership,
        'functionalRoleKeys',
        'Existing membership functional roles are invalid'
      );
    }
  }

  return {
    targetMemberships,
    total: snapshot.teammemberships.length,
    targetTeamId: targetMemberships.size,
    otherTeamId
  };
}

function desiredScopesForMembership(existing) {
  if (!existing) return defaultModuleDataScopes();
  return deriveModuleDataScopes({
    positionLevel: existing.positionLevel,
    functionalRoleKeys: Array.isArray(existing.functionalRoleKeys)
      ? existing.functionalRoleKeys
      : []
  });
}

function createMigrationPlan({
  snapshot,
  target,
  identity,
  membershipInspection,
  now
}) {
  const userUpdates = [];
  const membershipWrites = [];
  const taskUpdates = [];
  const childTeamUpdates = {
    taskreviews: [],
    extensionrequests: [],
    messages: [],
    fileassets: []
  };
  const selectedUserId = idString(identity.selectedUser?._id);

  for (const user of snapshot.users) {
    const userId = idString(user._id);
    const set = {};
    const canonical = identity.canonicalByUserId.get(userId);
    if (canonical && user.usernameNormalized !== canonical) {
      set.usernameNormalized = canonical;
    }
    const desiredSuperAdmin = user.isSystemAccount === true
      ? user.isSuperAdmin === true
      : selectedUserId
        ? userId === selectedUserId
        : user.isSuperAdmin === true;
    if (user.isSuperAdmin !== desiredSuperAdmin) {
      set.isSuperAdmin = desiredSuperAdmin;
    }
    if (isMissing(user.tokenVersion)) {
      set.tokenVersion = 0;
    }
    if (Object.keys(set).length > 0) {
      userUpdates.push({ _id: user._id, set });
    }

    if (user.isSystemAccount === true) {
      const existingSystemMembership = membershipInspection.targetMemberships.get(userId) || null;
      if (
        existingSystemMembership &&
        existingSystemMembership.status !== MEMBERSHIP_STATUSES.DISABLED
      ) {
        membershipWrites.push({
          existing: existingSystemMembership,
          _id: existingSystemMembership._id,
          teamId: target.teamId,
          userId: user._id,
          set: { status: MEMBERSHIP_STATUSES.DISABLED },
          joinedAt: existingSystemMembership.joinedAt || safeDate(user.createdAt, now)
        });
      }
      continue;
    }

    const existing = membershipInspection.targetMemberships.get(userId) || null;
    const mappedPermissions = permissionsForLegacyRoles(user.roles);
    const permissionKeys = uniqueSorted([
      ...(validMembershipPermissions(existing?.permissionKeys) ? existing.permissionKeys : []),
      ...mappedPermissions
    ]);
    const role = projectAdminRole(user.roles)
      ? MEMBERSHIP_ROLES.PROJECT_ADMIN
      : existing?.role || MEMBERSHIP_ROLES.MEMBER;
    const positionKey = existing?.positionKey || POSITION_KEYS.EMPLOYEE;
    const positionLevel = POSITION_LEVEL_BY_KEY[positionKey] ||
      POSITION_LEVEL_BY_KEY[POSITION_KEYS.EMPLOYEE];
    const functionalRoleKeys = Array.isArray(existing?.functionalRoleKeys)
      ? uniqueSorted(existing.functionalRoleKeys)
      : [];
    const moduleDataScopes = desiredScopesForMembership(existing);
    const status = existing?.status || MEMBERSHIP_STATUSES.ACTIVE;
    const orgUnitId = existing?.orgUnitId || target.rootOrgId;
    const setMembership = {
      orgUnitId,
      role,
      positionKey,
      positionLevel,
      functionalRoleKeys,
      permissionKeys,
      moduleDataScopes,
      status
    };
    const needsUpdate = !existing ||
      !sameId(existing.orgUnitId, setMembership.orgUnitId) ||
      existing.role !== role ||
      existing.positionKey !== positionKey ||
      existing.positionLevel !== positionLevel ||
      !arrayEquals(uniqueSorted(existing.functionalRoleKeys || []), functionalRoleKeys) ||
      !arrayEquals(uniqueSorted(existing.permissionKeys || []), permissionKeys) ||
      !jsonEquals(
        (existing.moduleDataScopes || []).map(({ moduleKey, scope }) => ({ moduleKey, scope })),
        moduleDataScopes
      ) ||
      existing.status !== status;

    if (needsUpdate) {
      membershipWrites.push({
        existing,
        _id: existing?._id || new mongoose.Types.ObjectId(),
        teamId: target.teamId,
        userId: user._id,
        set: setMembership,
        joinedAt: existing?.joinedAt || safeDate(user.createdAt, now)
      });
    }
  }

  for (const task of snapshot.tasks) {
    const set = {};
    if (isMissing(task.teamId)) set.teamId = target.teamId;
    if (isMissing(task.orgUnitId)) set.orgUnitId = target.rootOrgId;
    if (Object.keys(set).length > 0) taskUpdates.push({ _id: task._id, set });
  }
  for (const collection of Object.keys(childTeamUpdates)) {
    for (const document of snapshot[collection]) {
      if (isMissing(document.teamId)) {
        childTeamUpdates[collection].push({ _id: document._id, set: { teamId: target.teamId } });
      }
    }
  }

  const counts = {
    projectTeamsCreated: target.team ? 0 : 1,
    rootOrgUnitsCreated: target.rootOrg ? 0 : 1,
    usersUpdated: userUpdates.length,
    membershipsCreated: membershipWrites.filter((write) => !write.existing).length,
    membershipsUpdated: membershipWrites.filter((write) => write.existing).length,
    tasksTeamIdBackfilled: taskUpdates.filter((write) => write.set.teamId).length,
    tasksOrgUnitIdBackfilled: taskUpdates.filter((write) => write.set.orgUnitId).length,
    taskReviewsTeamIdBackfilled: childTeamUpdates.taskreviews.length,
    extensionRequestsTeamIdBackfilled: childTeamUpdates.extensionrequests.length,
    messagesTeamIdBackfilled: childTeamUpdates.messages.length,
    fileAssetsTeamIdBackfilled: childTeamUpdates.fileassets.length,
    embeddedAttachmentFilesMoved: 0,
    auditRecordsInserted: 1
  };

  return {
    target,
    userUpdates,
    membershipWrites,
    taskUpdates,
    childTeamUpdates,
    counts
  };
}

function collectionSummary(snapshot, collector, target, referenceInspection) {
  const result = {
    users: {
      total: snapshot.users.length,
      missingUsernameNormalized: snapshot.users.filter(
        (user) => isMissing(user.usernameNormalized)
      ).length,
      missingIsSuperAdmin: snapshot.users.filter(
        (user) => isMissing(user.isSuperAdmin)
      ).length,
      missingTokenVersion: snapshot.users.filter(
        (user) => isMissing(user.tokenVersion)
      ).length
    }
  };
  for (const collection of REQUIRED_BACKUP_COLLECTIONS.filter((name) => name !== 'users')) {
    result[collection] = inspectTeamField({
      collector,
      collection,
      documents: snapshot[collection],
      targetTeamId: target.teamId
    });
  }
  result.tasks.missingOrgUnitId = referenceInspection.missingTaskOrgUnitId;
  return result;
}

function publicTargetPlan(target) {
  return {
    team: {
      action: target.team ? 'REUSE' : 'CREATE',
      id: idString(target.teamId),
      code: TARGET_TEAM.code,
      name: TARGET_TEAM.name
    },
    rootOrgUnit: {
      action: target.rootOrg ? 'REUSE' : 'CREATE',
      id: idString(target.rootOrgId),
      code: TARGET_ROOT_ORG.code,
      name: TARGET_ROOT_ORG.name,
      type: TARGET_ROOT_ORG.type,
      level: TARGET_ROOT_ORG.level,
      path: TARGET_ROOT_ORG.path
    }
  };
}

function inspectBackupCounts(snapshot, backupManifest, collector) {
  if (!backupManifest) return null;
  const comparison = {};
  for (const collection of REQUIRED_BACKUP_COLLECTIONS) {
    const backupCount = backupManifest.collections[collection].documentCount;
    const currentCount = snapshot[collection].length;
    const matches = backupCount === currentCount;
    comparison[collection] = { backupCount, currentCount, matches };
    if (!matches) {
      collector.add('BACKUP_DOCUMENT_COUNT_MISMATCH', 'BLOCKER', {
        collection,
        field: 'documentCount',
        message: 'Current collection count differs from the verified backup manifest',
        expected: backupCount,
        actual: currentCount
      });
    }
  }
  return comparison;
}

function analyzeSnapshot({
  snapshot,
  requestedSuperAdminUsername,
  plannedTeamId,
  plannedRootOrgId,
  backupManifest = null,
  now = new Date()
}) {
  const collector = createAnomalyCollector();
  const target = resolveTarget(snapshot, collector, plannedTeamId, plannedRootOrgId);
  const identity = inspectUserIdentity(snapshot, collector, requestedSuperAdminUsername);
  const referenceInspection = inspectBusinessReferences(snapshot, collector, target, identity);
  const memberships = inspectMemberships(snapshot, collector, target, identity);
  const collections = collectionSummary(
    snapshot,
    collector,
    target,
    referenceInspection
  );
  const attachments = attachmentStats(snapshot);
  if (attachments.files > 0) {
    collector.add('LEGACY_EMBEDDED_ATTACHMENTS_PENDING', 'WARNING', {
      collection: `${COLLECTIONS.tasks},${COLLECTIONS.taskreviews}`,
      field: 'attachments',
      message: 'Embedded legacy attachment metadata is inventoried only; FileAsset migration remains pending',
      fileCount: attachments.files,
      declaredBytes: attachments.declaredBytes
    });
  }
  const backupComparison = inspectBackupCounts(snapshot, backupManifest, collector);
  const plan = createMigrationPlan({
    snapshot,
    target,
    identity,
    membershipInspection: memberships,
    now
  });
  const anomalies = collector.result();

  return {
    snapshot,
    target,
    identity,
    memberships,
    internalPlan: plan,
    before: {
      collections,
      memberships: {
        total: memberships.total,
        targetTeamId: memberships.targetTeamId,
        otherTeamId: memberships.otherTeamId
      },
      identity: {
        usernameNormalizedCollisionCount: identity.collisions.length,
        usernameNormalizedCollisions: identity.collisions,
        selectedSuperAdmin: identity.selectedUser
          ? {
            userId: idString(identity.selectedUser._id),
            username: identity.selectedUser.username,
            usernameNormalized: identity.normalizedRequested
          }
          : null
      },
      legacyEmbeddedAttachments: attachments,
      backupComparison,
      anomalies
    },
    publicPlan: {
      ...publicTargetPlan(target),
      selectedSuperAdmin: identity.selectedUser
        ? {
          userId: idString(identity.selectedUser._id),
          username: identity.selectedUser.username,
          usernameNormalized: identity.normalizedRequested
        }
        : null,
      changes: plan.counts,
      legacyRoleMapping: ROLE_PERMISSION_MAP,
      membershipDefaults: {
        positionKey: POSITION_KEYS.EMPLOYEE,
        positionLevel: POSITION_LEVEL_BY_KEY[POSITION_KEYS.EMPLOYEE],
        orgUnitId: idString(target.rootOrgId),
        moduleDataScopes: defaultModuleDataScopes()
      },
      embeddedAttachments: {
        action: 'REPORT_ONLY',
        fileAssetMigrationStatus: attachments.disposition,
        diskFilesTouched: false,
        fileCount: attachments.files
      }
    }
  };
}

async function bulkWriteIfNeeded(db, collection, operations, session) {
  if (operations.length === 0) {
    return { matchedCount: 0, modifiedCount: 0, insertedCount: 0, upsertedCount: 0 };
  }
  return db.collection(collection).bulkWrite(operations, {
    ordered: true,
    session
  });
}

function modifiedCount(result) {
  return Number(result?.modifiedCount || 0);
}

async function applyMigrationPlan({ db, analysis, session, now, runId }) {
  const { internalPlan: plan, target, identity } = analysis;
  const selectedUser = identity.selectedUser;
  if (!selectedUser) {
    migrationError(
      'SUPER_ADMIN_REQUIRED',
      'A unique super administrator is required before executing the migration'
    );
  }

  let projectTeamsCreated = 0;
  if (!target.team) {
    await db.collection(COLLECTIONS.projectteams).insertOne({
      _id: target.teamId,
      code: TARGET_TEAM.code,
      name: TARGET_TEAM.name,
      status: TEAM_STATUSES.ACTIVE,
      settings: { timeZone: 'Asia/Shanghai' },
      createdBy: selectedUser._id,
      createdAt: now,
      updatedAt: now,
      __v: 0
    }, { session });
    projectTeamsCreated = 1;
  }

  let rootOrgUnitsCreated = 0;
  if (!target.rootOrg) {
    await db.collection(COLLECTIONS.orgunits).insertOne({
      _id: target.rootOrgId,
      teamId: target.teamId,
      parentId: null,
      type: TARGET_ROOT_ORG.type,
      code: TARGET_ROOT_ORG.code,
      name: TARGET_ROOT_ORG.name,
      status: ORG_UNIT_STATUSES.ACTIVE,
      sortOrder: 0,
      level: TARGET_ROOT_ORG.level,
      path: TARGET_ROOT_ORG.path,
      createdAt: now,
      updatedAt: now,
      __v: 0
    }, { session });
    rootOrgUnitsCreated = 1;
  }

  const usernameNormalizationWrites = plan.userUpdates.filter(
    (write) => Object.prototype.hasOwnProperty.call(write.set, 'usernameNormalized')
  );
  // Free legacy normalized values first so swaps cannot trip the unique index
  // even though the final canonical usernames are conflict-free.
  await bulkWriteIfNeeded(
    db,
    COLLECTIONS.users,
    usernameNormalizationWrites.map((write) => ({
      updateOne: {
        filter: { _id: write._id },
        update: { $unset: { usernameNormalized: '' } }
      }
    })),
    session
  );

  const userResult = await bulkWriteIfNeeded(
    db,
    COLLECTIONS.users,
    plan.userUpdates.map((write) => ({
      updateOne: {
        filter: { _id: write._id },
        update: { $set: { ...write.set, updatedAt: now } }
      }
    })),
    session
  );

  const membershipResult = await bulkWriteIfNeeded(
    db,
    COLLECTIONS.teammemberships,
    plan.membershipWrites.map((write) => write.existing
      ? {
        updateOne: {
          filter: { _id: write._id, teamId: write.teamId, userId: write.userId },
          update: { $set: { ...write.set, updatedAt: now } }
        }
      }
      : {
        insertOne: {
          document: {
            _id: write._id,
            teamId: write.teamId,
            userId: write.userId,
            ...write.set,
            joinedAt: write.joinedAt,
            createdAt: now,
            updatedAt: now,
            __v: 0
          }
        }
      }),
    session
  );

  const taskResult = await bulkWriteIfNeeded(
    db,
    COLLECTIONS.tasks,
    plan.taskUpdates.map((write) => ({
      updateOne: {
        filter: { _id: write._id },
        update: { $set: { ...write.set, updatedAt: now } }
      }
    })),
    session
  );
  const childResults = {};
  for (const [collection, writes] of Object.entries(plan.childTeamUpdates)) {
    childResults[collection] = await bulkWriteIfNeeded(
      db,
      COLLECTIONS[collection],
      writes.map((write) => ({
        updateOne: {
          filter: { _id: write._id },
          update: { $set: { ...write.set, updatedAt: now } }
        }
      })),
      session
    );
  }

  return {
    projectTeamsCreated,
    rootOrgUnitsCreated,
    usersUpdated: modifiedCount(userResult),
    membershipsCreated: Number(membershipResult.insertedCount || 0),
    membershipsUpdated: modifiedCount(membershipResult),
    tasksUpdated: modifiedCount(taskResult),
    taskReviewsUpdated: modifiedCount(childResults.taskreviews),
    extensionRequestsUpdated: modifiedCount(childResults.extensionrequests),
    messagesUpdated: modifiedCount(childResults.messages),
    fileAssetsUpdated: modifiedCount(childResults.fileassets),
    embeddedAttachmentFilesMoved: 0,
    auditRecordsInserted: 0,
    runId
  };
}

function compactAuditSummary(analysis) {
  return {
    collections: Object.fromEntries(
      Object.entries(analysis.before.collections).map(([name, value]) => [name, {
        total: value.total,
        missingTeamId: value.missingTeamId,
        otherTeamId: value.otherTeamId,
        missingOrgUnitId: value.missingOrgUnitId
      }])
    ),
    memberships: analysis.before.memberships,
    selectedSuperAdminUserId: idString(analysis.identity.selectedUser?._id),
    anomalyCounts: analysis.before.anomalies.counts
  };
}

async function insertMigrationAudit({ db, session, now, runId, teamId, before, after }) {
  await db.collection(COLLECTIONS.auditlogs).insertOne({
    actorUserId: null,
    actorRole: AUDIT_ACTOR_ROLES.SYSTEM,
    actorMode: AUDIT_ACTOR_MODES.SYSTEM,
    activeTeamId: null,
    targetTeamId: teamId,
    action: AUDIT_ACTIONS.IMPORT,
    resourceType: AUDIT_RESOURCE_TYPES.SYSTEM,
    resourceId: runId,
    before: compactAuditSummary(before),
    after: compactAuditSummary(after),
    reason: 'Legacy single-team tenant migration to 变速箱物流部',
    requestId: runId,
    requestMethod: null,
    requestPath: null,
    ip: null,
    userAgent: 'legacy-tenant-migration/node',
    createdAt: now,
    updatedAt: now,
    __v: 0
  }, { session });
}

function assertMigrationDatabaseIsolation(databaseName) {
  if (typeof databaseName !== 'string' || !databaseName) {
    migrationError('DATABASE_NAME_REQUIRED', 'Connected database name is required');
  }
  const normalized = databaseName.toLowerCase();
  if (!SAFE_DATABASE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    migrationError(
      'DATABASE_NOT_ISOLATED',
      `Migration database must end with ${SAFE_DATABASE_SUFFIXES.join(', ')}`,
      { databaseName }
    );
  }
  return databaseName;
}

function assertTransactionSupport(connection) {
  const topologyType = connection?.client?.topology?.description?.type;
  if (!['ReplicaSetWithPrimary', 'Sharded'].includes(topologyType)) {
    migrationError(
      'TRANSACTION_TOPOLOGY_REQUIRED',
      'Execute mode requires a replica set or sharded MongoDB transaction topology',
      { topologyType: topologyType || null }
    );
  }
}

async function validateExecutionGuards({
  execute,
  databaseName,
  confirmDatabase,
  superAdminUsername,
  backupManifestPath,
  backupVerifier = verifyBackupManifest
}) {
  assertMigrationDatabaseIsolation(databaseName);
  if (execute !== true) return null;
  if (confirmDatabase !== databaseName) {
    migrationError(
      'DATABASE_CONFIRMATION_MISMATCH',
      '--confirm-database must exactly match the connected database name',
      { expected: databaseName, actual: confirmDatabase || null }
    );
  }
  const normalizedSuperAdmin = normalizeUsername(superAdminUsername);
  if (!normalizedSuperAdmin) {
    migrationError(
      'SUPER_ADMIN_USERNAME_REQUIRED',
      '--super-admin-username is required in execute mode'
    );
  }
  if (typeof backupManifestPath !== 'string' || !backupManifestPath.trim()) {
    migrationError(
      'BACKUP_MANIFEST_REQUIRED',
      '--backup-manifest is required in execute mode'
    );
  }
  return backupVerifier({
    manifestPath: backupManifestPath,
    databaseName
  });
}

function replayArguments({
  databaseName,
  superAdminUsername,
  backupManifestPath,
  plannedTeamId,
  plannedRootOrgId
}) {
  const args = [
    '--execute',
    '--confirm-database',
    databaseName,
    '--super-admin-username',
    superAdminUsername || '<required>',
    '--backup-manifest',
    backupManifestPath || '<required>',
    '--planned-team-id',
    idString(plannedTeamId),
    '--planned-root-org-id',
    idString(plannedRootOrgId)
  ];
  return {
    executable: 'node',
    script: 'script/migrateLegacyTenant.js',
    arguments: args,
    environment: ['MONGODB_URI'],
    secretsIncluded: false
  };
}

function buildBaseReport({
  runId,
  generatedAt,
  databaseName,
  execute,
  analysis,
  backupManifest,
  superAdminUsername,
  backupManifestPath,
  plannedTeamId,
  plannedRootOrgId
}) {
  const blocked = analysis.before.anomalies.blockerCount > 0;
  return {
    schemaVersion: 1,
    migration: 'legacy-single-team-to-v2-tenant',
    runId,
    generatedAt: generatedAt.toISOString(),
    databaseName,
    mode: execute ? 'EXECUTE' : 'DRY_RUN',
    status: execute
      ? (blocked ? 'BLOCKED' : 'READY')
      : (blocked ? 'DRY_RUN_BLOCKED' : 'DRY_RUN_READY'),
    writePerformed: false,
    target: {
      teamName: TARGET_TEAM.name,
      teamCode: TARGET_TEAM.code,
      rootOrgCode: TARGET_ROOT_ORG.code
    },
    backup: backupManifest
      ? {
        format: backupManifest.format,
        completedAt: backupManifest.completedAt,
        manifestPath: backupManifest.manifestPath,
        manifestSha256: backupManifest.manifestSha256,
        collections: backupManifest.collections
      }
      : null,
    before: analysis.before,
    plan: analysis.publicPlan,
    after: null,
    actualModifications: null,
    replay: replayArguments({
      databaseName,
      superAdminUsername,
      backupManifestPath,
      plannedTeamId,
      plannedRootOrgId
    })
  };
}

function createLegacyTenantMigrationService({
  connection = mongoose.connection,
  backupVerifier = verifyBackupManifest,
  clock = () => new Date(),
  uuid = randomUUID
} = {}) {
  if (!connection || !connection.db || typeof connection.startSession !== 'function') {
    throw new TypeError('A connected Mongoose connection with transaction support is required');
  }

  return Object.freeze({
    async run({
      execute = false,
      confirmDatabase = null,
      superAdminUsername = null,
      backupManifestPath = null,
      plannedTeamId: suppliedTeamId = null,
      plannedRootOrgId: suppliedRootOrgId = null
    } = {}) {
      const databaseName = connection.name || connection.db.databaseName;
      const backupManifest = await validateExecutionGuards({
        execute,
        databaseName,
        confirmDatabase,
        superAdminUsername,
        backupManifestPath,
        backupVerifier
      });
      const now = clock();
      const runId = uuid();
      const plannedTeamId = createObjectId(suppliedTeamId, 'plannedTeamId');
      const plannedRootOrgId = createObjectId(suppliedRootOrgId, 'plannedRootOrgId');
      const initialSnapshot = await loadSnapshot(connection.db);
      const initialAnalysis = analyzeSnapshot({
        snapshot: initialSnapshot,
        requestedSuperAdminUsername: superAdminUsername,
        plannedTeamId,
        plannedRootOrgId,
        backupManifest,
        now
      });
      const report = buildBaseReport({
        runId,
        generatedAt: now,
        databaseName,
        execute,
        analysis: initialAnalysis,
        backupManifest,
        superAdminUsername,
        backupManifestPath,
        plannedTeamId,
        plannedRootOrgId
      });

      if (!execute || initialAnalysis.before.anomalies.blockerCount > 0) {
        return report;
      }

      assertTransactionSupport(connection);
      const session = await connection.startSession();
      let transactionResult;
      try {
        await session.withTransaction(async () => {
          const transactionSnapshot = await loadSnapshot(connection.db, session);
          const before = analyzeSnapshot({
            snapshot: transactionSnapshot,
            requestedSuperAdminUsername: superAdminUsername,
            plannedTeamId,
            plannedRootOrgId,
            backupManifest,
            now
          });
          if (before.before.anomalies.blockerCount > 0) {
            migrationError(
              'MIGRATION_STATE_CHANGED_OR_BLOCKED',
              'Migration state became blocked before the transaction could write',
              { anomalies: before.before.anomalies }
            );
          }

          const actualModifications = await applyMigrationPlan({
            db: connection.db,
            analysis: before,
            session,
            now,
            runId
          });
          const afterSnapshot = await loadSnapshot(connection.db, session);
          const after = analyzeSnapshot({
            snapshot: afterSnapshot,
            requestedSuperAdminUsername: superAdminUsername,
            plannedTeamId,
            plannedRootOrgId,
            backupManifest,
            now
          });
          if (after.before.anomalies.blockerCount > 0) {
            migrationError(
              'MIGRATION_AFTER_RECONCILIATION_FAILED',
              'Post-migration reconciliation found blocking anomalies',
              { anomalies: after.before.anomalies }
            );
          }
          await insertMigrationAudit({
            db: connection.db,
            session,
            now,
            runId,
            teamId: before.target.teamId,
            before,
            after
          });
          actualModifications.auditRecordsInserted = 1;
          transactionResult = { before, after, actualModifications };
        }, {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' }
        });
      } finally {
        await session.endSession();
      }

      if (!transactionResult) {
        migrationError('MIGRATION_TRANSACTION_EMPTY', 'Migration transaction did not return a result');
      }
      report.status = 'EXECUTED';
      report.writePerformed = true;
      report.before = transactionResult.before.before;
      report.plan = transactionResult.before.publicPlan;
      report.after = transactionResult.after.before;
      report.actualModifications = transactionResult.actualModifications;
      return report;
    }
  });
}

module.exports = {
  COLLECTIONS,
  LegacyTenantMigrationError,
  ROLE_PERMISSION_MAP,
  SAFE_DATABASE_SUFFIXES,
  TARGET_ROOT_ORG,
  TARGET_TEAM,
  analyzeSnapshot,
  assertMigrationDatabaseIsolation,
  createLegacyTenantMigrationService,
  normalizeUsername,
  permissionsForLegacyRoles,
  validateExecutionGuards
};
