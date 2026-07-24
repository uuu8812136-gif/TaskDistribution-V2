'use strict';

const OrgUnit = require('../models/OrgUnit');
const { ORG_UNIT_STATUSES } = require('../config/permissions');

async function lockActiveOrgUnitReference({
  OrgUnitModel = OrgUnit,
  teamId,
  orgUnitId,
  session = null
} = {}) {
  if (!teamId || !orgUnitId) throw new TypeError('teamId and orgUnitId are required');

  const filter = {
    _id: orgUnitId,
    teamId,
    status: ORG_UNIT_STATUSES.ACTIVE
  };
  if (!session) return OrgUnitModel.findOne(filter);

  return OrgUnitModel.findOneAndUpdate(
    filter,
    { $inc: { referenceRevision: 1 } },
    { new: true, session }
  );
}

async function lockActiveOrgUnitReferences({
  OrgUnitModel = OrgUnit,
  teamId,
  orgUnitIds,
  session = null
} = {}) {
  const ids = [...new Map(
    (Array.isArray(orgUnitIds) ? orgUnitIds : [orgUnitIds])
      .filter(Boolean)
      .map((value) => [String(value), value])
  ).values()].sort((left, right) => String(left).localeCompare(String(right)));
  const documents = [];
  for (const orgUnitId of ids) {
    const document = await lockActiveOrgUnitReference({
      OrgUnitModel,
      teamId,
      orgUnitId,
      session
    });
    if (!document) return null;
    documents.push(document);
  }
  return documents;
}

module.exports = {
  lockActiveOrgUnitReference,
  lockActiveOrgUnitReferences
};
