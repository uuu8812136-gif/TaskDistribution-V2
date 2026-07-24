'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const appRequire = require('../helpers/appRequire');

const mongoose = appRequire('mongoose');
const modelsDirectory = path.resolve(__dirname, '../../../app/models');

for (const fileName of fs.readdirSync(modelsDirectory)) {
  if (fileName.endsWith('.js')) require(path.join(modelsDirectory, fileName));
}

const {
  DEFAULT_DEPENDENCY_SOURCES,
  findOrgUnitDependency
} = require('../../../app/services/orgUnitDependencyService');

function orgUnitReferencePaths(model) {
  return Object.entries(model.schema.paths)
    .filter(([, schemaType]) => [
      schemaType?.options?.ref,
      schemaType?.caster?.options?.ref,
      schemaType?.$embeddedSchemaType?.options?.ref
    ].includes('OrgUnit'))
    .map(([schemaPath]) => schemaPath)
    .sort();
}

test('organization dependency sources cover every team-scoped OrgUnit model reference', () => {
  const configured = new Map(DEFAULT_DEPENDENCY_SOURCES.map((source) => [
    source.model.modelName,
    new Set(source.fields)
  ]));

  for (const modelName of mongoose.modelNames()) {
    const model = mongoose.model(modelName);
    if (modelName === 'OrgUnit' || !model.schema.path('teamId')) continue;
    for (const schemaPath of orgUnitReferencePaths(model)) {
      assert.ok(
        configured.get(modelName)?.has(schemaPath),
        `${modelName}.${schemaPath} must block organization deletion`
      );
    }
  }

  assert.ok(
    configured.get('ImportJob')?.has('stagedRows.candidate.orgUnitId'),
    'staged import candidates must block organization deletion'
  );
})

test('organization dependency lookup keeps team scope and transaction session', async () => {
  const calls = [];
  const transactionSession = { id: 'transaction-session' };
  const createSource = (modelName, result) => ({
    model: {
      modelName,
      exists(filter) {
        const call = { filter, session: null };
        calls.push(call);
        return {
          session(session) {
            call.session = session;
            return this;
          },
          then(resolve, reject) {
            return Promise.resolve(result).then(resolve, reject);
          }
        };
      }
    },
    fields: ['orgUnitId']
  });

  const result = await findOrgUnitDependency({
    teamId: 'team-a',
    orgUnitId: 'org-a',
    session: transactionSession,
    sources: [
      createSource('FirstSource', null),
      createSource('MatchingSource', { _id: 'dependency' }),
      createSource('UnreachedSource', { _id: 'unused' })
    ]
  });

  assert.equal(result, 'MatchingSource');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].filter, { teamId: 'team-a', orgUnitId: 'org-a' });
  assert.equal(calls[0].session, transactionSession);
  assert.equal(calls[1].session, transactionSession);
})
