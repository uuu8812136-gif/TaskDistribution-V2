'use strict';

const {
  AUDIT_ACTOR_ROLES,
  DATA_SCOPES,
  DATA_SCOPE_VALUES,
  DATA_SCOPE_MODULE_VALUES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_ROLE_VALUES,
  MEMBERSHIP_STATUSES,
  ORG_UNIT_STATUSES,
  PERMISSION_KEYS,
  SESSION_MODES,
  TEAM_STATUSES
} = require('../config/permissions');
const { SYSTEM_ACCOUNT_DISPLAY_NAME } = require('../config/systemAccount');
const { executeQuery, normalizeId } = require('./authSessionService');
const {
  AUTH_ERROR_CODES,
  AuthContextError
} = require('./authContextError');

const GLOBAL_READ_ONLY_SCOPE = 'GLOBAL_READ_ONLY';
const permissionKeySet = new Set(PERMISSION_KEYS);
const dataScopeModuleSet = new Set(DATA_SCOPE_MODULE_VALUES);
const dataScopeSet = new Set(DATA_SCOPE_VALUES);
const membershipRoleSet = new Set(MEMBERSHIP_ROLE_VALUES);
const allPermissionKeys = Object.freeze([...PERMISSION_KEYS]);
const allTeamDataScopes = Object.freeze(Object.fromEntries(
  DATA_SCOPE_MODULE_VALUES.map((moduleKey) => [moduleKey, DATA_SCOPES.TEAM])
));
const defaultGlobalReadPermissionKeys = Object.freeze(
  PERMISSION_KEYS.filter((permissionKey) => (
    permissionKey.endsWith('.view') || permissionKey === 'equipment.inventory'
  ))
);

function contextError(status, code, message) {
  return new AuthContextError(status, code, message);
}

function sameId(left, right) {
  const normalizedLeft = normalizeId(left);
  const normalizedRight = normalizeId(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
  );
}

function freezeArray(values) {
  return Object.freeze([...values]);
}

function safeUser(user) {
  const identity = user.isSystemAccount === true
    ? { name: SYSTEM_ACCOUNT_DISPLAY_NAME }
    : {
        username: user.username,
        name: user.name,
        phone: user.phone,
        email: user.email,
        avatar: user.avatar
      };
  return Object.freeze({
    _id: normalizeId(user._id),
    ...identity,
    roles: freezeArray(Array.isArray(user.roles) ? user.roles : []),
    status: user.status,
    isSuperAdmin: user.isSuperAdmin === true,
    tokenVersion: user.tokenVersion
  });
}

function safeTeam(team) {
  if (!team) return null;
  return Object.freeze({
    _id: normalizeId(team._id),
    code: team.code,
    name: team.name,
    status: team.status,
    settings: team.settings
      ? Object.freeze({ timeZone: team.settings.timeZone })
      : null
  });
}

function safeOrgUnit(orgUnit) {
  if (!orgUnit) return null;
  return Object.freeze({
    _id: normalizeId(orgUnit._id),
    teamId: normalizeId(orgUnit.teamId),
    parentId: normalizeId(orgUnit.parentId),
    type: orgUnit.type,
    code: orgUnit.code,
    name: orgUnit.name,
    status: orgUnit.status,
    level: orgUnit.level,
    path: orgUnit.path
  });
}

function validatePermissionKeys(permissionKeys) {
  if (!Array.isArray(permissionKeys)) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.MEMBERSHIP_INVALID,
      'Membership permissions are invalid'
    );
  }

  const uniqueKeys = new Set(permissionKeys);
  if (
    uniqueKeys.size !== permissionKeys.length ||
    permissionKeys.some((permissionKey) => !permissionKeySet.has(permissionKey))
  ) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.MEMBERSHIP_INVALID,
      'Membership permissions are invalid'
    );
  }
  return freezeArray(permissionKeys);
}

function validateModuleDataScopes(moduleDataScopes) {
  if (!Array.isArray(moduleDataScopes)) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.DATA_SCOPE_INVALID,
      'Membership data scopes are invalid'
    );
  }

  const scopeMap = {};
  for (const item of moduleDataScopes) {
    if (
      !item ||
      !dataScopeModuleSet.has(item.moduleKey) ||
      !dataScopeSet.has(item.scope) ||
      Object.prototype.hasOwnProperty.call(scopeMap, item.moduleKey)
    ) {
      throw contextError(
        403,
        AUTH_ERROR_CODES.DATA_SCOPE_INVALID,
        'Membership data scopes are invalid'
      );
    }
    scopeMap[item.moduleKey] = item.scope;
  }

  if (
    Object.keys(scopeMap).length !== DATA_SCOPE_MODULE_VALUES.length ||
    DATA_SCOPE_MODULE_VALUES.some(
      (moduleKey) => !Object.prototype.hasOwnProperty.call(scopeMap, moduleKey)
    )
  ) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.DATA_SCOPE_INVALID,
      'Membership data scopes are incomplete'
    );
  }

  return Object.freeze(scopeMap);
}

function validateMembership(membership, claims, userId) {
  if (!membership) {
    throw contextError(
      401,
      AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
      'An active membership is required for this team'
    );
  }
  if (membership.status !== MEMBERSHIP_STATUSES.ACTIVE) {
    throw contextError(
      401,
      AUTH_ERROR_CODES.MEMBERSHIP_DISABLED,
      'The team membership is disabled'
    );
  }
  if (
    !sameId(membership.teamId, claims.activeTeamId) ||
    !sameId(membership.userId, userId) ||
    !membershipRoleSet.has(membership.role) ||
    !normalizeId(membership.orgUnitId)
  ) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.MEMBERSHIP_INVALID,
      'The team membership is invalid'
    );
  }

  const permissionKeys = validatePermissionKeys(membership.permissionKeys);
  const moduleDataScopes = validateModuleDataScopes(membership.moduleDataScopes);
  return { permissionKeys, moduleDataScopes };
}

function buildContext({
  claims,
  session,
  user,
  isSuperAdmin,
  team = null,
  membership = null,
  orgUnit = null,
  globalReadPermissionKeys = defaultGlobalReadPermissionKeys
}) {
  const userId = normalizeId(user._id);
  const base = {
    authenticated: true,
    sessionId: normalizeId(session._id),
    mode: claims.mode,
    tokenVersion: claims.tokenVersion,
    userId,
    user: safeUser(user),
    isSuperAdmin,
    activeTeamId: claims.activeTeamId,
    team: safeTeam(team),
    membership: null,
    orgUnit: null,
    actorRole: isSuperAdmin
      ? AUDIT_ACTOR_ROLES.SUPER_ADMIN
      : AUDIT_ACTOR_ROLES.MEMBER,
    permissionKeys: Object.freeze([]),
    moduleDataScopes: Object.freeze({}),
    readOnly: claims.mode !== SESSION_MODES.TEAM,
    canAccessBusiness: claims.mode !== SESSION_MODES.TEAM_SELECTION
  };

  if (claims.mode === SESSION_MODES.GLOBAL_READ_ONLY) {
    base.permissionKeys = globalReadPermissionKeys;
  }

  if (claims.mode === SESSION_MODES.TEAM) {
    if (isSuperAdmin) {
      base.permissionKeys = allPermissionKeys;
      base.moduleDataScopes = allTeamDataScopes;
      base.readOnly = false;
      return Object.freeze(base);
    }

    const authorization = validateMembership(membership, claims, userId);
    base.membership = Object.freeze({
      _id: normalizeId(membership._id),
      teamId: normalizeId(membership.teamId),
      userId: normalizeId(membership.userId),
      orgUnitId: normalizeId(membership.orgUnitId),
      role: membership.role,
      positionLevel: membership.positionLevel,
      positionKey: membership.positionKey,
      functionalRoleKeys: freezeArray(
        Array.isArray(membership.functionalRoleKeys)
          ? membership.functionalRoleKeys
          : []
      ),
      status: membership.status
    });
    base.orgUnit = safeOrgUnit(orgUnit);
    base.actorRole = isSuperAdmin
      ? AUDIT_ACTOR_ROLES.SUPER_ADMIN
      : membership.role === MEMBERSHIP_ROLES.PROJECT_ADMIN
        ? AUDIT_ACTOR_ROLES.PROJECT_ADMIN
        : AUDIT_ACTOR_ROLES.MEMBER;
    base.permissionKeys = authorization.permissionKeys;
    base.moduleDataScopes = authorization.moduleDataScopes;
    base.readOnly = false;
  }

  return Object.freeze(base);
}

function assertAuthContext(context) {
  if (!context || context.authenticated !== true) {
    throw contextError(
      401,
      AUTH_ERROR_CODES.CONTEXT_REQUIRED,
      'Authentication context is required'
    );
  }
  return context;
}

function assertBusinessContext(context) {
  assertAuthContext(context);
  if (context.mode === SESSION_MODES.TEAM_SELECTION) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.BUSINESS_CONTEXT_REQUIRED,
      'Select a team before accessing business data'
    );
  }
  return context;
}

function assertTeamContext(context) {
  assertAuthContext(context);
  if (context.mode !== SESSION_MODES.TEAM || !context.activeTeamId) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.TEAM_CONTEXT_REQUIRED,
      'An active team context is required'
    );
  }
  return context;
}

function assertPermission(context, permissionKey) {
  assertBusinessContext(context);
  if (!permissionKeySet.has(permissionKey)) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.PERMISSION_KEY_UNKNOWN,
      'The requested permission is not configured'
    );
  }
  if (!context.permissionKeys.includes(permissionKey)) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.PERMISSION_DENIED,
      'Permission denied'
    );
  }
  return context;
}

function resolveModuleDataScope(context, moduleKey) {
  assertBusinessContext(context);
  if (!dataScopeModuleSet.has(moduleKey)) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.DATA_SCOPE_MODULE_UNKNOWN,
      'The requested data-scope module is not configured'
    );
  }

  if (context.mode === SESSION_MODES.GLOBAL_READ_ONLY) {
    return Object.freeze({
      moduleKey,
      scope: GLOBAL_READ_ONLY_SCOPE,
      teamId: null,
      orgUnitId: null
    });
  }

  assertTeamContext(context);
  const scope = context.moduleDataScopes[moduleKey];
  if (!dataScopeSet.has(scope)) {
    throw contextError(
      403,
      AUTH_ERROR_CODES.DATA_SCOPE_INVALID,
      'No valid data scope is configured for this module'
    );
  }

  return Object.freeze({
    moduleKey,
    scope,
    teamId: context.activeTeamId,
    orgUnitId: scope === DATA_SCOPES.ORG_UNIT
      ? context.membership.orgUnitId
      : null
  });
}

function createTeamContextService({
  User,
  ProjectTeam,
  TeamMembership,
  OrgUnit,
  findUserById,
  findTeamById,
  findMembership,
  findOrgUnitById,
  isSuperAdmin,
  allowLegacyAdminAsSuperAdmin = false,
  globalReadPermissionKeys = defaultGlobalReadPermissionKeys
} = {}) {
  const userFinder = findUserById || (User
    ? (userId) => executeQuery(
      User.findById(userId),
      { select: '_id username name phone email avatar roles status isSuperAdmin isSystemAccount tokenVersion' }
    )
    : null);
  const teamFinder = findTeamById || (ProjectTeam
    ? (teamId) => executeQuery(ProjectTeam.findById(teamId))
    : null);
  const membershipFinder = findMembership || (TeamMembership
    ? ({ teamId, userId }) => executeQuery(
      TeamMembership.findOne({ teamId, userId })
    )
    : null);
  const orgUnitFinder = findOrgUnitById || (OrgUnit
    ? (orgUnitId) => executeQuery(OrgUnit.findById(orgUnitId))
    : null);

  if (
    typeof userFinder !== 'function' ||
    typeof teamFinder !== 'function' ||
    typeof membershipFinder !== 'function' ||
    typeof orgUnitFinder !== 'function'
  ) {
    throw new TypeError('User, ProjectTeam, TeamMembership and OrgUnit finders are required');
  }

  const normalizedGlobalReadPermissions = validatePermissionKeys(globalReadPermissionKeys);
  const superAdminEvaluator = isSuperAdmin || ((user) => (
    user.isSuperAdmin === true ||
    (
      allowLegacyAdminAsSuperAdmin === true &&
      Array.isArray(user.roles) &&
      user.roles.includes('admin')
    )
  ));

  return Object.freeze({
    async resolveContext({ claims, session }) {
      const user = await userFinder(claims.sub);
      if (!user) {
        throw contextError(
          401,
          AUTH_ERROR_CODES.USER_NOT_FOUND,
          'Authenticated user does not exist'
        );
      }
      if (!sameId(user._id, claims.sub)) {
        throw contextError(
          401,
          AUTH_ERROR_CODES.SESSION_MISMATCH,
          'Authenticated user does not match the session'
        );
      }
      if (user.status !== 'active') {
        throw contextError(
          401,
          AUTH_ERROR_CODES.USER_DISABLED,
          'The user account is disabled'
        );
      }
      if (
        !Number.isInteger(user.tokenVersion) ||
        user.tokenVersion !== claims.tokenVersion
      ) {
        throw contextError(
          401,
          AUTH_ERROR_CODES.TOKEN_VERSION_MISMATCH,
          'The authentication token version is no longer valid'
        );
      }

      const superAdmin = superAdminEvaluator(user) === true;
      if (claims.mode === SESSION_MODES.GLOBAL_READ_ONLY && !superAdmin) {
        throw contextError(
          403,
          AUTH_ERROR_CODES.SUPER_ADMIN_REQUIRED,
          'Global read-only access requires a super administrator'
        );
      }

      if (claims.mode !== SESSION_MODES.TEAM) {
        return buildContext({
          claims,
          session,
          user,
          isSuperAdmin: superAdmin,
          globalReadPermissionKeys: normalizedGlobalReadPermissions
        });
      }

      const team = await teamFinder(claims.activeTeamId);
      if (!team) {
        throw contextError(401, AUTH_ERROR_CODES.TEAM_NOT_FOUND, 'The team does not exist');
      }
      if (!sameId(team._id, claims.activeTeamId)) {
        throw contextError(
          401,
          AUTH_ERROR_CODES.SESSION_MISMATCH,
          'Active team does not match the session'
        );
      }
      if (team.status !== TEAM_STATUSES.ACTIVE) {
        throw contextError(401, AUTH_ERROR_CODES.TEAM_DISABLED, 'The team is disabled');
      }

      if (superAdmin) {
        return buildContext({
          claims,
          session,
          user,
          isSuperAdmin: true,
          team,
          globalReadPermissionKeys: normalizedGlobalReadPermissions
        });
      }

      const membership = await membershipFinder({
        teamId: claims.activeTeamId,
        userId: claims.sub
      });
      const authorization = validateMembership(membership, claims, claims.sub);
      const orgUnit = await orgUnitFinder(membership.orgUnitId);
      if (
        !orgUnit ||
        orgUnit.status !== ORG_UNIT_STATUSES.ACTIVE ||
        !sameId(orgUnit.teamId, claims.activeTeamId)
      ) {
        throw contextError(
          401,
          AUTH_ERROR_CODES.ORG_UNIT_INVALID,
          'The membership organization unit is invalid'
        );
      }

      return buildContext({
        claims,
        session,
        user,
        isSuperAdmin: superAdmin,
        team,
        membership: {
          ...membership,
          permissionKeys: authorization.permissionKeys,
          moduleDataScopes: DATA_SCOPE_MODULE_VALUES.map((moduleKey) => ({
            moduleKey,
            scope: authorization.moduleDataScopes[moduleKey]
          }))
        },
        orgUnit,
        globalReadPermissionKeys: normalizedGlobalReadPermissions
      });
    }
  });
}

module.exports = {
  GLOBAL_READ_ONLY_SCOPE,
  assertAuthContext,
  assertBusinessContext,
  assertPermission,
  assertTeamContext,
  buildContext,
  createTeamContextService,
  defaultGlobalReadPermissionKeys,
  resolveModuleDataScope,
  sameId,
  validateModuleDataScopes,
  validatePermissionKeys
};
