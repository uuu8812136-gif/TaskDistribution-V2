'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const permissions = require('../../../app/config/permissions');
const {
  actingSubDepartmentLeaderPositionKeys,
  canMembershipActAsSubDepartmentLeader,
  orgUnitsShareSubDepartment,
  subDepartmentOrgUnitIds
} = require('../../../app/services/subDepartmentLeadershipService');

function queryOf(value) {
  const query = {
    select() { return query; },
    lean() { return Promise.resolve(value); },
    session() { return query; }
  };
  return query;
}

function membershipModel(primaryMembership = null) {
  return {
    find(filter) {
      assert.equal(filter.status, permissions.MEMBERSHIP_STATUSES.ACTIVE);
      assert.deepEqual(filter.positionKey.$in, [
        permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
        permissions.POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER
      ]);
      return queryOf(primaryMembership ? [{ userId: primaryMembership.userId }] : []);
    }
  };
}

function userModel(active = true) {
  return {
    exists(filter) {
      assert.equal(filter.status, 'active');
      return Promise.resolve(active ? { _id: 'active-user' } : null);
    }
  };
}

function contextMembership(positionKey, orgUnitId = 'sub-1') {
  return {
    teamId: 'team-1',
    orgUnitId,
    positionKey,
    status: permissions.MEMBERSHIP_STATUSES.ACTIVE
  };
}

function hierarchyOrgUnitModel() {
  const rows = new Map([
    ['sub-1', {
      _id: 'sub-1',
      teamId: 'team-1',
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      level: 2,
      path: '/department-1/'
    }],
    ['group-1', {
      _id: 'group-1',
      teamId: 'team-1',
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      level: 3,
      path: '/department-1/sub-1/'
    }],
    ['group-2', {
      _id: 'group-2',
      teamId: 'team-1',
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      level: 3,
      path: '/department-1/sub-2/'
    }]
  ]);
  return {
    findOne(filter) {
      if (filter._id && typeof filter._id === 'object' && filter._id.$in) {
        const found = [...filter._id.$in].map((value) => rows.get(String(value)))
          .find((value) => value?.level === filter.level && value?.type === filter.type);
        return queryOf(found ? { _id: found._id } : null);
      }
      const row = rows.get(String(filter._id));
      return queryOf(row && row.teamId === filter.teamId ? row : null);
    },
    find(filter) {
      const matches = [...rows.values()].filter((row) => {
        if (String(row.teamId) !== String(filter.teamId)) return false;
        return (filter.$or || []).some((clause) => (
          (clause._id && String(clause._id) === String(row._id)) ||
          (clause.path?.$regex && new RegExp(clause.path.$regex).test(row.path))
        ));
      });
      return queryOf(matches.map(({ _id }) => ({ _id })));
    }
  };
}

test('manager and deputy are primary leaders while supervisor is the no-primary fallback', async () => {
  const primaryKeys = await actingSubDepartmentLeaderPositionKeys({
    TeamMembershipModel: membershipModel({ userId: 'manager-1' }),
    UserModel: userModel(),
    teamId: 'team-1',
    orgUnitIds: ['department-1', 'sub-1']
  });
  assert.deepEqual(primaryKeys, [
    permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
    permissions.POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER
  ]);

  const fallbackKeys = await actingSubDepartmentLeaderPositionKeys({
    TeamMembershipModel: membershipModel(null),
    teamId: 'team-1',
    orgUnitIds: ['department-1', 'sub-1']
  });
  assert.deepEqual(fallbackKeys, [permissions.POSITION_KEYS.SUPERVISOR]);
});

test('supervisor cannot act when any primary leader is active in the same organization scope', async () => {
  const common = {
    membership: contextMembership(permissions.POSITION_KEYS.SUPERVISOR),
    teamId: 'team-1',
    orgUnitIds: ['department-1', 'sub-1']
  };
  assert.equal(await canMembershipActAsSubDepartmentLeader({
    ...common,
    TeamMembershipModel: membershipModel({ userId: 'deputy-1' }),
    UserModel: userModel()
  }), false);
  assert.equal(await canMembershipActAsSubDepartmentLeader({
    ...common,
    TeamMembershipModel: membershipModel(null)
  }), true);
});

test('manager and deputy may act only inside their team and ancestor scope', async () => {
  for (const positionKey of [
    permissions.POSITION_KEYS.SUB_DEPARTMENT_MANAGER,
    permissions.POSITION_KEYS.SUB_DEPARTMENT_DEPUTY_MANAGER
  ]) {
    assert.equal(await canMembershipActAsSubDepartmentLeader({
      TeamMembershipModel: membershipModel(null),
      membership: contextMembership(positionKey),
      teamId: 'team-1',
      orgUnitIds: ['department-1', 'sub-1']
    }), true);
    assert.equal(await canMembershipActAsSubDepartmentLeader({
      TeamMembershipModel: membershipModel(null),
      membership: contextMembership(positionKey, 'other-sub'),
      teamId: 'team-1',
      orgUnitIds: ['department-1', 'sub-1']
    }), false);
  }
});

test('an inactive primary-leader user does not suppress the supervisor fallback', async () => {
  const options = {
    membership: contextMembership(permissions.POSITION_KEYS.SUPERVISOR),
    teamId: 'team-1',
    orgUnitIds: ['sub-1'],
    TeamMembershipModel: membershipModel({ userId: 'inactive-manager' }),
    UserModel: userModel(false)
  };
  assert.equal(await canMembershipActAsSubDepartmentLeader(options), true);
  assert.deepEqual(await actingSubDepartmentLeaderPositionKeys(options), [
    permissions.POSITION_KEYS.SUPERVISOR
  ]);
});

test('organization resolution selects only the unique level-2 sub-department', async () => {
  const OrgUnitModel = {
    findOne(filter) {
      if (filter._id === 'group-1') {
        return queryOf({
          _id: 'group-1',
          type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
          level: 3,
          path: '/department-1/sub-1/'
        });
      }
      assert.deepEqual(filter, {
        _id: { $in: ['department-1', 'sub-1'] },
        teamId: 'team-1',
        level: 2,
        type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT
      });
      return queryOf({ _id: 'sub-1' });
    }
  };
  assert.deepEqual(await subDepartmentOrgUnitIds({
    OrgUnitModel,
    teamId: 'team-1',
    orgUnitId: 'group-1'
  }), ['sub-1']);
});

test('equipment organization and custodian group match across one second-level branch only', async () => {
  const OrgUnitModel = hierarchyOrgUnitModel();
  assert.equal(await orgUnitsShareSubDepartment({
    OrgUnitModel,
    teamId: 'team-1',
    leftOrgUnitId: 'sub-1',
    rightOrgUnitId: 'group-1'
  }), true);
  assert.equal(await orgUnitsShareSubDepartment({
    OrgUnitModel,
    teamId: 'team-1',
    leftOrgUnitId: 'group-1',
    rightOrgUnitId: 'group-2'
  }), false);
  assert.equal(await orgUnitsShareSubDepartment({
    OrgUnitModel,
    teamId: 'team-1',
    leftOrgUnitId: 'department-1',
    rightOrgUnitId: 'department-1'
  }), true);
});

test('root department and another sub-department cannot influence or receive scoped leadership', async () => {
  const supervisor = contextMembership(permissions.POSITION_KEYS.SUPERVISOR, 'sub-1');
  assert.equal(await canMembershipActAsSubDepartmentLeader({
    TeamMembershipModel: membershipModel(null),
    membership: { ...supervisor, orgUnitId: 'department-1' },
    teamId: 'team-1',
    orgUnitIds: ['sub-1']
  }), false);
  assert.equal(await canMembershipActAsSubDepartmentLeader({
    TeamMembershipModel: membershipModel(null),
    membership: { ...supervisor, orgUnitId: 'sub-2' },
    teamId: 'team-1',
    orgUnitIds: ['sub-1']
  }), false);

  const rootOnlyModel = {
    findOne() {
      return queryOf({
        _id: 'department-1',
        type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
        level: 1,
        path: '/'
      });
    }
  };
  assert.deepEqual(await subDepartmentOrgUnitIds({
    OrgUnitModel: rootOnlyModel,
    teamId: 'team-1',
    orgUnitId: 'department-1'
  }), []);
});

test('a supervisor attached to a level-3 group acts for its level-2 sub-department only', async () => {
  const OrgUnitModel = hierarchyOrgUnitModel();
  const supervisor = contextMembership(permissions.POSITION_KEYS.SUPERVISOR, 'group-1');
  const noPrimaryMembershipModel = membershipModel(null);
  assert.equal(await canMembershipActAsSubDepartmentLeader({
    TeamMembershipModel: noPrimaryMembershipModel,
    OrgUnitModel,
    membership: supervisor,
    teamId: 'team-1',
    orgUnitIds: ['sub-1']
  }), true);
  assert.equal(await canMembershipActAsSubDepartmentLeader({
    TeamMembershipModel: noPrimaryMembershipModel,
    OrgUnitModel,
    membership: { ...supervisor, orgUnitId: 'group-2' },
    teamId: 'team-1',
    orgUnitIds: ['sub-1']
  }), false);
});

test('a primary leader in a level-3 group suppresses supervisor fallback in the same sub-department', async () => {
  const OrgUnitModel = hierarchyOrgUnitModel();
  const TeamMembershipModel = membershipModel({ userId: 'manager-in-group' });
  assert.equal(await canMembershipActAsSubDepartmentLeader({
    TeamMembershipModel,
    UserModel: userModel(),
    OrgUnitModel,
    membership: contextMembership(permissions.POSITION_KEYS.SUPERVISOR, 'group-1'),
    teamId: 'team-1',
    orgUnitIds: ['sub-1']
  }), false);
  const scoped = await require('../../../app/services/subDepartmentLeadershipService')
    .leadershipOrgUnitIds({ OrgUnitModel, teamId: 'team-1', orgUnitIds: ['sub-1'] });
  assert.deepEqual(scoped.sort(), ['group-1', 'sub-1']);
});
