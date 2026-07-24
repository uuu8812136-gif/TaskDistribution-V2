'use strict';

const {
  createTeamManagementService
} = require('../../../app/services/teamManagementService');
const { MEMBERSHIP_STATUSES, SESSION_MODES } = require('../../../app/config/permissions');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function superAdminTeamContext(context) {
  return {
    ...context,
    authenticated: true,
    mode: SESSION_MODES.TEAM,
    isSuperAdmin: true,
    readOnly: false
  };
}

async function holdLeaderRestoration({ authContext, membershipId }) {
  const auditEntered = deferred();
  const releaseAudit = deferred();
  let blocked = false;
  const service = createTeamManagementService({
    auditService: {
      async record() {
        if (!blocked) {
          blocked = true;
          auditEntered.resolve();
          await releaseAudit.promise;
        }
        return null;
      }
    }
  });
  const restoration = service.updateMember({
    authContext: superAdminTeamContext(authContext),
    membershipId: String(membershipId),
    input: {
      status: MEMBERSHIP_STATUSES.ACTIVE,
      reason: 'Concurrent leadership restoration test'
    }
  });
  await auditEntered.promise;
  return {
    release() {
      releaseAudit.resolve();
    },
    restoration
  };
}

async function promiseStateAfterDelay(promise, delayMs = 75) {
  return Promise.race([
    promise.then(
      () => 'fulfilled',
      () => 'rejected'
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), delayMs))
  ]);
}

module.exports = {
  holdLeaderRestoration,
  promiseStateAfterDelay
};
