const path = require('node:path');
const { createRequire } = require('node:module');

module.exports = createRequire(path.resolve(__dirname, '../../../app/package.json'));
