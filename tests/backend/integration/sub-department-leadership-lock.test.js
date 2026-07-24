'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { randomUUID } = require('node:crypto');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const { MongoMemoryReplSet } = appRequire('mongodb-memory-server');
const OrgUnit = require('../../../app/models/OrgUnit');
const ProjectTeam = require('../../../app/models/ProjectTeam');
const TeamMembership = require('../../../app/models/TeamMembership');
const User = require('../../../app/models/User');
const permissions = require('../../../app/config/permissions');
const {
  createTeamManagementService
} = require('../../../app/services/teamManagementService');

const DATABASE_NAME = `leadership_lock_${randomUUID().replaceAll('-', '')}_v2_test`;
let replicaSet;

function revision(orgUnitId) {
  return OrgUnit.findById(orgUnitId).select('leadershipRevision').lean()
    .then((orgUnit) => orgUnit.leadershipRevision);
}

before(async () => {
  assert.match(DATABASE_NAME, /_v2_test$/);
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbName: DATABASE_NAME }]
  });
  await mongoose.connect(replicaSet.getUri(DATABASE_NAME), { dbName: DATABASE_NAME });
  await Promise.all([OrgUnit, ProjectTeam, TeamMembership, User].map((model) => model.syncIndexes()));
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test('every membership mutation entry locks the old and new sub-department leadership state', async () => {
  const administrator = await User.create({
    username: 'leadership-lock-admin',
    password: 'test-password-123',
    name: 'Leadership lock admin',
    isSuperAdmin: true,
    roles: ['admin']
  });
  const member = await User.create({
    username: 'leadership-lock-member',
    password: 'test-password-123',
    name: 'Leadership lock member',
    roles: ['executor']
  });
  const team = await ProjectTeam.create({
    code: 'LEADERSHIP_LOCK',
    name: 'Leadership lock team',
    createdBy: administrator._id
  });
  const root = await OrgUnit.create({
    teamId: team._id,
    type: permissions.ORG_UNIT_TYPES.DEPARTMENT,
    code: 'ROOT',
    name: 'Root',
    level: 1,
    path: '/'
  });
  const [branchA, branchB] = await OrgUnit.create([
    {
      teamId: team._id,
      parentId: root._id,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'BRANCH_A',
      name: 'Branch A',
      level: 2,
      path: `/${root._id}/`
    },
    {
      teamId: team._id,
      parentId: root._id,
      type: permissions.ORG_UNIT_TYPES.SUB_DEPARTMENT,
      code: 'BRANCH_B',
      name: 'Branch B',
      level: 2,
      path: `/${root._id}/`
    }
  ]);
  const [groupA, groupB] = await OrgUnit.create([
    {
      teamId: team._id,
      parentId: branchA._id,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'GROUP_A',
      name: 'Group A',
      level: 3,
      path: `/${root._id}/${branchA._id}/`
    },
    {
      teamId: team._id,
      parentId: branchB._id,
      type: permissions.ORG_UNIT_TYPES.TEAM_GROUP,
      code: 'GROUP_B',
      name: 'Group B',
      level: 3,
      path: `/${root._id}/${branchB._id}/`
    }
  ]);
  const authContext = {
    authenticated: true,
    mode: permissions.SESSION_MODES.TEAM,
    activeTeamId: String(team._id),
    userId: String(administrator._id),
    isSuperAdmin: true,
    readOnly: false
  };
  const service = createTeamManagementService({
    connection: mongoose.connection,
    auditService: { record: async () => null }
  });

  const created = await service.createMember({
    authContext,
    input: {
      existingUserId: String(member._id),
      orgUnitId: String(groupA._id),
      positionKey: permissions.POSITION_KEYS.EMPLOYEE
    }
  });
  assert.equal(await revision(branchA._id), 1);
  assert.equal(await revision(branchB._id), 0);

  await service.updateMember({
    authContext,
    membershipId: created.member._id,
    input: { positionKey: permissions.POSITION_KEYS.SUPERVISOR }
  });
  assert.equal(await revision(branchA._id), 2);

  await service.updateMember({
    authContext,
    membershipId: created.member._id,
    input: { status: permissions.MEMBERSHIP_STATUSES.DISABLED }
  });
  assert.equal(await revision(branchA._id), 3);

  await service.updateMember({
    authContext,
    membershipId: created.member._id,
    input: {
      orgUnitId: String(groupB._id),
      status: permissions.MEMBERSHIP_STATUSES.ACTIVE
    }
  });
  assert.equal(await revision(branchA._id), 4);
  assert.equal(await revision(branchB._id), 1);

  await service.disableMember({
    authContext,
    membershipId: created.member._id,
    reason: 'Leadership lock disable entry'
  });
  assert.equal(await revision(branchA._id), 4);
  assert.equal(await revision(branchB._id), 2);
});
