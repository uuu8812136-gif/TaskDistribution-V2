#!/usr/bin/env node
'use strict';

const { collectHealth, formatHealth } = require('./lib/healthCore');
const {
  healthConfigFromEnv,
  loadOperationsEnvironment,
  parseArgs
} = require('./lib/operationsConfig');

function usage() {
  return [
    'Display API, Web, MongoDB, backup freshness, disk, memory, and log health.',
    '',
    'Usage:',
    '  node ops/health-terminal.js --env-file <absolute path> --once [--json]',
    '  node ops/health-terminal.js --env-file <absolute path> --watch [--json]'
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { values: ['env-file'], flags: ['help', 'once', 'watch', 'json'] });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (args.once && args.watch) throw new Error('--once and --watch are mutually exclusive');
  const env = await loadOperationsEnvironment({ envFile: args['env-file'] });
  const config = healthConfigFromEnv(env);
  const once = args.once || !args.watch;
  let lastReport = null;
  do {
    lastReport = await collectHealth(config);
    if (!args.json && !once && process.stdout.isTTY) process.stdout.write('\u001b[2J\u001b[H');
    process.stdout.write(args.json
      ? `${JSON.stringify(lastReport)}\n`
      : formatHealth(lastReport));
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, config.intervalSeconds * 1000));
  } while (true);
  if (once && lastReport.status !== 'HEALTHY') process.exitCode = 2;
  return lastReport;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'HEALTH_CHECK_FAILED',
      code: error.code || 'UNEXPECTED_ERROR',
      message: error.message
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, usage };
