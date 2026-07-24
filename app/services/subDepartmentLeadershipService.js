'use strict';

const TeamMembership = require('../models/TeamMembership');
const OrgUnit = require('../models/OrgUnit');
const User = require('../models/User');
const {
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  ORG_UNIT_TYPES,
  POSITION_KEYS
} = require('../config/permissions');

const PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS = Object.freeze([
  POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
  POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER
]);

const ACTING_SUB_DEPARTMENT_LEADER_POSITION_KEYS = Object.freeze([
  ...PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS,
  POSITION_KEYS.SUPERVISOR
]);

function uniqueIds(values) {
  return [...new Map(
    (Array.isArray(values) ? values : [values])
      .filter(Boolean)
      .map((value) => [String(value), value])
  ).values()];
}

function organizationFilter(orgUnitIds) {
  const values = uniqueIds(orgUnitIds);
  if (values.length === 0) throw new TypeError('At least one organization unit is required');
  return values.length === 1 ? values[0] : { $in: values };
}

function modelQuery(query, session) {
  if (session && typeof query.session === 'function') query.session(session);
  return query;
}

async function leadershipOrgUnitIds({
  OrgUnitModel,
  teamId,
  orgUnitIds,
  session = null
}) {
  const subDepartmentIds = uniqueIds(orgUnitIds);
  if (subDepartmentIds.length === 0) return [];
  if (!OrgUnitModel || typeof OrgUnitModel.find !== 'function') return subDepartmentIds;
  const query = OrgUnitModel.find({
    teamId,
    $or: subDepartmentIds.flatMap((orgUnitId) => [
      { _id: orgUnitId },
      { path: { $regex: `/${String(orgUnitId)}/` } }
    ])
  }).select('_id').lean();
  const orgUnits = await modelQuery(query, session);
  return uniqueIds(orgUnits.map(({ _id }) => _id));
}

async function subDepartmentOrgUnitIds({
  OrgUnitModel = OrgUnit,
  teamId,
  orgUnitId,
  session = null
}) {
  const query = OrgUnitModel.findOne({ _id: orgUnitId, teamId })
    .select('_id type level path')
    .lean();
  const target = await modelQuery(query, session);
  if (!target) return [];
  if (target.level === 2 && target.type === ORG_UNIT_TYPES.SUB_DEPARTMENT) {
    return [target._id];
  }
  const ancestorIds = String(target.path || '/')
    .split('/')
    .filter(Boolean);
  if (ancestorIds.length === 0) return [];
  const subDepartmentQuery = OrgUnitModel.findOne({
    _id: { $in: ancestorIds },
    teamId,
    level: 2,
    type: ORG_UNIT_TYPES.SUB_DEPARTMENT
  }).select('_id').lean();
  const subDepartment = await modelQuery(subDepartmentQuery, session);
  return subDepartment ? [subDepartment._id] : [];
}

async function resolveSubDepartmentIds({
  OrgUnitModel = OrgUnit,
  teamId,
  orgUnitIds,
  session = null
}) {
  const resolved = [];
  for (const orgUnitId of uniqueIds(orgUnitIds)) {
    resolved.push(...await subDepartmentOrgUnitIds({
      OrgUnitModel,
      teamId,
      orgUnitId,
      session
    }));
  }
  return uniqueIds(resolved).sort((left, right) => String(left).localeCompare(String(right)));
}

async function orgUnitsShareSubDepartment({
  OrgUnitModel = OrgUnit,
  teamId,
  leftOrgUnitId,
  rightOrgUnitId,
  requireActiveOrgUnits = false,
  session = null
}) {
  if (requireActiveOrgUnits) {
    const [leftOrgUnit, rightOrgUnit] = await Promise.all([
      modelQuery(OrgUnitModel.findOne({
        _id: leftOrgUnitId,
        teamId,
        status: ORG_UNIT_STATUSES.ACTIVE
      }).select('_id').lean(), session),
      modelQuery(OrgUnitModel.findOne({
        _id: rightOrgUnitId,
        teamId,
        status: ORG_UNIT_STATUSES.ACTIVE
      }).select('_id').lean(), session)
    ]);
    if (!leftOrgUnit || !rightOrgUnit) return false;
  }
  if (String(leftOrgUnitId) === String(rightOrgUnitId)) return true;
  const [leftSubDepartmentIds, rightSubDepartmentIds] = await Promise.all([
    subDepartmentOrgUnitIds({
      OrgUnitModel,
      teamId,
      orgUnitId: leftOrgUnitId,
      session
    }),
    subDepartmentOrgUnitIds({
      OrgUnitModel,
      teamId,
      orgUnitId: rightOrgUnitId,
      session
    })
  ]);
  return leftSubDepartmentIds.some((leftId) => rightSubDepartmentIds.some(
    (rightId) => String(leftId) === String(rightId)
  ));
}

async function lockSubDepartmentLeadership({
  OrgUnitModel = OrgUnit,
  teamId,
  orgUnitIds,
  session
}) {
  if (!session) throw new TypeError('A transaction session is required for leadership locking');
  const subDepartmentIds = await resolveSubDepartmentIds({
    OrgUnitModel,
    teamId,
    orgUnitIds,
    session
  });
  for (const subDepartmentId of subDepartmentIds) {
    const result = await OrgUnitModel.updateOne({
      _id: subDepartmentId,
      teamId,
      type: ORG_UNIT_TYPES.SUB_DEPARTMENT,
      level: 2
    }, {
      $inc: { leadershipRevision: 1 }
    }, { session });
    if (result.matchedCount !== 1) {
      const error = new Error('Sub-department leadership state is unavailable');
      error.code = 'SUB_DEPARTMENT_LEADERSHIP_UNAVAILABLE';
      throw error;
    }
  }
  return subDepartmentIds;
}

async function activePrimaryLeaderExists({
  TeamMembershipModel = TeamMembership,
  OrgUnitModel = null,
  UserModel = User,
  teamId,
  orgUnitIds,
  session = null
}) {
  if (uniqueIds(orgUnitIds).length === 0) return false;
  const scopedOrgUnitIds = await leadershipOrgUnitIds({
    OrgUnitModel,
    teamId,
    orgUnitIds,
    session
  });
  const membershipQuery = TeamMembershipModel.find({
    teamId,
    orgUnitId: organizationFilter(scopedOrgUnitIds),
    status: MEMBERSHIP_STATUSES.ACTIVE,
    positionKey: { $in: PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS }
  }).select('userId').lean();
  const memberships = await modelQuery(membershipQuery, session);
  const userIds = uniqueIds(memberships.map(({ userId }) => userId));
  if (userIds.length === 0) return false;
  const activeUserQuery = UserModel.exists({
    _id: organizationFilter(userIds),
    status: 'active'
  });
  return Boolean(await modelQuery(activeUserQuery, session));
}

async function actingSubDepartmentLeaderPositionKeys(options) {
  if (uniqueIds(options?.orgUnitIds).length === 0) return [];
  return await activePrimaryLeaderExists(options)
    ? PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS
    : Object.freeze([POSITION_KEYS.SUPERVISOR]);
}

async function canMembershipActAsSubDepartmentLeader({
  membership,
  teamId,
  orgUnitIds,
  TeamMembershipModel = TeamMembership,
  OrgUnitModel = null,
  UserModel = User,
  session = null
}) {
  if (
    !membership ||
    membership.status !== MEMBERSHIP_STATUSES.ACTIVE ||
    String(membership.teamId) !== String(teamId)
  ) {
    return false;
  }

  const scopedOrgUnitIds = uniqueIds(orgUnitIds);
  const directMatch = scopedOrgUnitIds.some(
    (value) => String(value) === String(membership.orgUnitId)
  );
  const membershipSubDepartmentIds = directMatch || !OrgUnitModel
    ? []
    : await subDepartmentOrgUnitIds({
        OrgUnitModel,
        teamId,
        orgUnitId: membership.orgUnitId,
        session
      });
  const belongsToScope = directMatch || membershipSubDepartmentIds.some(
    (membershipSubDepartmentId) => scopedOrgUnitIds.some(
      (value) => String(value) === String(membershipSubDepartmentId)
    )
  );
  if (!belongsToScope) {
    return false;
  }

  if (PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS.includes(membership.positionKey)) {
    return true;
  }
  if (membership.positionKey !== POSITION_KEYS.SUPERVISOR) return false;

  return !(await activePrimaryLeaderExists({
    TeamMembershipModel,
    OrgUnitModel,
    UserModel,
    teamId,
    orgUnitIds: scopedOrgUnitIds,
    session
  }));
}

module.exports = {
  ACTING_SUB_DEPARTMENT_LEADER_POSITION_KEYS,
  PRIMARY_SUB_DEPARTMENT_LEADER_POSITION_KEYS,
  actingSubDepartmentLeaderPositionKeys,
  activePrimaryLeaderExists,
  canMembershipActAsSubDepartmentLeader,
  leadershipOrgUnitIds,
  lockSubDepartmentLeadership,
  orgUnitsShareSubDepartment,
  resolveSubDepartmentIds,
  subDepartmentOrgUnitIds,
  uniqueIds
};
