'use strict';

const OrgUnit = require('../models/OrgUnit');
const TeamMembership = require('../models/TeamMembership');
const User = require('../models/User');
const {
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES
} = require('../config/permissions');

const EMPTY_SOURCE_VALUES = new Set(['', '/', '-', '--', '无', '暂无', '不详']);

const EQUIPMENT_OWNERSHIP_EXCEPTION_CODES = Object.freeze({
  ORG_UNIT_NAME_MISSING: 'ORG_UNIT_NAME_MISSING',
  ORG_UNIT_NOT_FOUND: 'ORG_UNIT_NOT_FOUND',
  ORG_UNIT_AMBIGUOUS: 'ORG_UNIT_AMBIGUOUS',
  CUSTODIAN_NAME_MISSING: 'CUSTODIAN_NAME_MISSING',
  CUSTODIAN_ORG_UNRESOLVED: 'CUSTODIAN_ORG_UNRESOLVED',
  CUSTODIAN_NOT_FOUND: 'CUSTODIAN_NOT_FOUND',
  CUSTODIAN_OUTSIDE_ORG_UNIT: 'CUSTODIAN_OUTSIDE_ORG_UNIT',
  CUSTODIAN_AMBIGUOUS: 'CUSTODIAN_AMBIGUOUS'
});

function normalizeOwnershipLookupText(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function normalizedSourceValue(value) {
  const normalized = normalizeOwnershipLookupText(value);
  return EMPTY_SOURCE_VALUES.has(normalized) ? '' : normalized;
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value._id ?? value);
}

function sameId(left, right) {
  const leftId = normalizeId(left);
  const rightId = normalizeId(right);
  return leftId !== null && rightId !== null && leftId === rightId;
}

function addToIndex(index, key, value) {
  if (!key) return;
  const values = index.get(key) || [];
  values.push(value);
  index.set(key, values);
}

function exception(code, { field, originalValue, candidates = [], message }) {
  return {
    code,
    field,
    originalValue: originalValue || null,
    candidates,
    message
  };
}

function orgCandidate(orgUnit) {
  return {
    orgUnitId: normalizeId(orgUnit),
    code: orgUnit.code || null,
    name: orgUnit.name || null
  };
}

function custodianCandidate({ user, membership }) {
  return {
    userId: normalizeId(user),
    displayName: user.name || null,
    orgUnitId: normalizeId(membership.orgUnitId)
  };
}

function createEquipmentOwnershipResolver({
  teamId,
  orgUnits = [],
  memberships = [],
  users = []
} = {}) {
  const targetTeamId = normalizeId(teamId);
  if (!targetTeamId) throw new TypeError('teamId is required');

  const activeOrgUnits = orgUnits.filter((orgUnit) => (
    sameId(orgUnit.teamId, targetTeamId) &&
    orgUnit.status === ORG_UNIT_STATUSES.ACTIVE
  ));
  const orgById = new Map(activeOrgUnits.map((orgUnit) => [normalizeId(orgUnit), orgUnit]));
  const subDepartmentsByName = new Map();
  for (const orgUnit of activeOrgUnits) {
    if (
      orgUnit.type === ORG_UNIT_TYPES.SUB_DEPARTMENT &&
      Number(orgUnit.level) === 2
    ) {
      addToIndex(
        subDepartmentsByName,
        normalizeOwnershipLookupText(orgUnit.name),
        orgUnit
      );
    }
  }

  const activeMembershipsByUser = new Map();
  for (const membership of memberships) {
    if (
      !sameId(membership.teamId, targetTeamId) ||
      membership.status !== MEMBERSHIP_STATUSES.ACTIVE ||
      !orgById.has(normalizeId(membership.orgUnitId))
    ) continue;
    addToIndex(activeMembershipsByUser, normalizeId(membership.userId), membership);
  }

  const activeUsersByName = new Map();
  for (const user of users) {
    if (user.status !== 'active' || user.isSystemAccount === true) continue;
    addToIndex(activeUsersByName, normalizeOwnershipLookupText(user.name), user);
  }

  function isInsideOrgUnit(orgUnitId, ancestorOrgUnitId) {
    const ancestorId = normalizeId(ancestorOrgUnitId);
    let currentId = normalizeId(orgUnitId);
    const visited = new Set();
    while (currentId && !visited.has(currentId)) {
      if (currentId === ancestorId) return true;
      visited.add(currentId);
      currentId = normalizeId(orgById.get(currentId)?.parentId);
    }
    return false;
  }

  function resolve({ orgUnitNameSnapshot, custodianDisplayName } = {}) {
    const exceptions = [];
    const orgName = normalizedSourceValue(orgUnitNameSnapshot);
    const orgMatches = orgName ? (subDepartmentsByName.get(orgName) || []) : [];
    let orgUnit = null;
    if (!orgName) {
      exceptions.push(exception(EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.ORG_UNIT_NAME_MISSING, {
        field: 'orgUnitId',
        originalValue: orgUnitNameSnapshot,
        message: 'The source organization name is empty or a placeholder'
      }));
    } else if (orgMatches.length === 1) {
      [orgUnit] = orgMatches;
    } else {
      exceptions.push(exception(
        orgMatches.length > 1
          ? EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.ORG_UNIT_AMBIGUOUS
          : EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.ORG_UNIT_NOT_FOUND,
        {
          field: 'orgUnitId',
          originalValue: orgUnitNameSnapshot,
          candidates: orgMatches.map(orgCandidate),
          message: orgMatches.length > 1
            ? 'More than one active level-2 sub-department has this exact name'
            : 'No active level-2 sub-department has this exact name'
        }
      ));
    }

    const custodianName = normalizedSourceValue(custodianDisplayName);
    let custodian = null;
    let custodianMembership = null;
    if (!custodianName) {
      exceptions.push(exception(EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_NAME_MISSING, {
        field: 'custodianUserId',
        originalValue: custodianDisplayName,
        message: 'The source custodian name is empty or a placeholder'
      }));
    } else if (!orgUnit) {
      exceptions.push(exception(EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_ORG_UNRESOLVED, {
        field: 'custodianUserId',
        originalValue: custodianDisplayName,
        message: 'Custodian matching is deferred until the source organization is resolved'
      }));
    } else {
      const activeMemberCandidates = [];
      for (const user of activeUsersByName.get(custodianName) || []) {
        for (const membership of activeMembershipsByUser.get(normalizeId(user)) || []) {
          activeMemberCandidates.push({ user, membership });
        }
      }
      const inOrgCandidates = activeMemberCandidates.filter(({ membership }) => (
        isInsideOrgUnit(membership.orgUnitId, orgUnit._id)
      ));
      if (inOrgCandidates.length === 1) {
        [{ user: custodian, membership: custodianMembership }] = inOrgCandidates;
      } else {
        let code;
        let message;
        if (inOrgCandidates.length > 1) {
          code = EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_AMBIGUOUS;
          message = 'More than one active team member in this sub-department has this exact name';
        } else if (activeMemberCandidates.length > 0) {
          code = EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_OUTSIDE_ORG_UNIT;
          message = 'The exact-name active team member belongs outside the resolved sub-department';
        } else {
          code = EQUIPMENT_OWNERSHIP_EXCEPTION_CODES.CUSTODIAN_NOT_FOUND;
          message = 'No active team member has this exact name';
        }
        exceptions.push(exception(code, {
          field: 'custodianUserId',
          originalValue: custodianDisplayName,
          candidates: (inOrgCandidates.length > 0
            ? inOrgCandidates
            : activeMemberCandidates).map(custodianCandidate),
          message
        }));
      }
    }

    return {
      orgUnit,
      custodian,
      custodianMembership,
      exceptions
    };
  }

  const rootOrgUnitIds = new Set(activeOrgUnits.filter((orgUnit) => (
    orgUnit.type === ORG_UNIT_TYPES.DEPARTMENT && Number(orgUnit.level) === 1
  )).map(normalizeId));

  return Object.freeze({
    resolve,
    isInsideOrgUnit,
    rootOrgUnitIds
  });
}

async function loadEquipmentOwnershipResolver({
  teamId,
  OrgUnitModel = OrgUnit,
  TeamMembershipModel = TeamMembership,
  UserModel = User,
  session = null
} = {}) {
  const execute = (query) => (session ? query.session(session) : query);
  const [orgUnits, memberships, users] = await Promise.all([
    execute(OrgUnitModel.find({ teamId, status: ORG_UNIT_STATUSES.ACTIVE }).lean()),
    execute(TeamMembershipModel.find({
      teamId,
      status: MEMBERSHIP_STATUSES.ACTIVE
    }).lean()),
    execute(UserModel.find({ status: 'active', isSystemAccount: { $ne: true } }).lean())
  ]);
  return createEquipmentOwnershipResolver({ teamId, orgUnits, memberships, users });
}

module.exports = {
  EQUIPMENT_OWNERSHIP_EXCEPTION_CODES,
  createEquipmentOwnershipResolver,
  loadEquipmentOwnershipResolver,
  normalizeOwnershipLookupText
};
