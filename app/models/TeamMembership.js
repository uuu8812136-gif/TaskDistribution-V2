'use strict';

const mongoose = require('mongoose');
const {
  FUNCTIONAL_ROLE_KEYS,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_ROLE_VALUES,
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_STATUS_VALUES,
  POSITION_LEVEL_VALUES,
  POSITION_KEYS,
  POSITION_KEY_VALUES,
  POSITION_LEVEL_BY_KEY,
  FUNCTIONAL_ROLE_KEY_VALUES,
  PERMISSION_KEYS,
  DATA_SCOPE_MODULE_VALUES,
  DATA_SCOPE_VALUES,
  deriveModuleDataScopes
} = require('../config/permissions');

const hasUniqueValues = (values) => (
  !values || new Set(values.map(String)).size === values.length
);

const moduleDataScopeSchema = new mongoose.Schema({
  moduleKey: {
    type: String,
    enum: DATA_SCOPE_MODULE_VALUES,
    required: true
  },
  scope: {
    type: String,
    enum: DATA_SCOPE_VALUES,
    required: true
  }
}, {
  _id: false,
  strict: 'throw'
});

const teamMembershipSchema = new mongoose.Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectTeam',
    required: true,
    immutable: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  orgUnitId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'OrgUnit',
    required: true
  },
  role: {
    type: String,
    enum: MEMBERSHIP_ROLE_VALUES,
    required: true,
    default: MEMBERSHIP_ROLES.MEMBER
  },
  positionLevel: {
    type: Number,
    enum: POSITION_LEVEL_VALUES,
    required: true,
    default: POSITION_LEVEL_BY_KEY[POSITION_KEYS.EMPLOYEE]
  },
  positionKey: {
    type: String,
    enum: POSITION_KEY_VALUES,
    required: true,
    default: POSITION_KEYS.EMPLOYEE
  },
  functionalRoleKeys: {
    type: [{
      type: String,
      enum: FUNCTIONAL_ROLE_KEY_VALUES
    }],
    default: [],
    validate: {
      validator: hasUniqueValues,
      message: 'functionalRoleKeys must not contain duplicates'
    }
  },
  permissionKeys: {
    type: [{
      type: String,
      enum: PERMISSION_KEYS
    }],
    default: [],
    validate: {
      validator: hasUniqueValues,
      message: 'permissionKeys must not contain duplicates'
    }
  },
  moduleDataScopes: {
    type: [moduleDataScopeSchema],
    default: undefined,
    validate: {
      validator: (scopes) => !scopes || hasUniqueValues(scopes.map(({ moduleKey }) => moduleKey)),
      message: 'moduleDataScopes must contain each module once'
    }
  },
  status: {
    type: String,
    enum: MEMBERSHIP_STATUS_VALUES,
    required: true,
    default: MEMBERSHIP_STATUSES.ACTIVE
  },
  joinedAt: {
    type: Date,
    required: true,
    default: Date.now,
    immutable: true
  }
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true
});

teamMembershipSchema.pre('validate', function enforceFixedPositionAndScopes(next) {
  const expectedLevel = POSITION_LEVEL_BY_KEY[this.positionKey];
  if (expectedLevel !== this.positionLevel) {
    this.invalidate(
      'positionLevel',
      `positionLevel must be ${expectedLevel} for positionKey ${this.positionKey}`
    );
  }

  const expectedScopes = deriveModuleDataScopes({
    positionLevel: this.positionLevel,
    functionalRoleKeys: this.functionalRoleKeys
  });
  const expectedScopeMap = new Map(
    expectedScopes.map(({ moduleKey, scope }) => [moduleKey, scope])
  );
  const suppliedScopes = this.moduleDataScopes;

  if (!suppliedScopes || suppliedScopes.length === 0) {
    this.moduleDataScopes = expectedScopes;
  } else {
    const suppliedScopeMap = new Map(
      suppliedScopes.map(({ moduleKey, scope }) => [moduleKey, scope])
    );
    const isExactDerivedScope = (
      suppliedScopeMap.size === expectedScopeMap.size &&
      [...expectedScopeMap].every(
        ([moduleKey, scope]) => suppliedScopeMap.get(moduleKey) === scope
      )
    );

    if (!isExactDerivedScope) {
      this.invalidate(
        'moduleDataScopes',
        'moduleDataScopes must be derived from the fixed position and functional-role rules'
      );
    }
  }

  next();
});

teamMembershipSchema.index(
  { teamId: 1, userId: 1 },
  { unique: true, name: 'uq_team_membership_team_user' }
);
teamMembershipSchema.index(
  { userId: 1, status: 1 },
  { name: 'ix_team_membership_user_status' }
);
teamMembershipSchema.index(
  { teamId: 1, orgUnitId: 1, status: 1 },
  { name: 'ix_team_membership_team_org_status' }
);
teamMembershipSchema.index(
  { teamId: 1, orgUnitId: 1 },
  {
    unique: true,
    name: 'uq_team_membership_active_attendance_reporter_per_org',
    partialFilterExpression: {
      status: MEMBERSHIP_STATUSES.ACTIVE,
      functionalRoleKeys: FUNCTIONAL_ROLE_KEYS.ATTENDANCE_REPORTER
    }
  }
);
teamMembershipSchema.index(
  { teamId: 1, role: 1, status: 1 },
  { name: 'ix_team_membership_team_role_status' }
);

module.exports = mongoose.model('TeamMembership', teamMembershipSchema);
