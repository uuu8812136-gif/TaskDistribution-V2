'use strict';

const mongoose = require('mongoose');

const TRANSACTION_TOPOLOGIES = new Set([
  'ReplicaSetWithPrimary',
  'ReplicaSetNoPrimary',
  'Sharded'
]);

function supportsTransactions(connection) {
  const topologyType = connection?.client?.topology?.description?.type;
  return TRANSACTION_TOPOLOGIES.has(topologyType);
}

async function runWithOptionalTransaction(work, connection = mongoose.connection) {
  if (typeof work !== 'function') throw new TypeError('work must be a function');
  if (!supportsTransactions(connection)) return work(null);

  const session = await connection.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  runWithOptionalTransaction,
  supportsTransactions
};
