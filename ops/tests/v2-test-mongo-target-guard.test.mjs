import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const {
  EXPECTED_V2_TEST_MONGO_TARGET,
  assertV2TestMongoTarget,
  readMongoUriFromEnvironmentFile
} = require('../lib/v2TestMongoTargetGuard.js')

const guardPath = fileURLToPath(new URL('../lib/v2TestMongoTargetGuard.js', import.meta.url))
const validUri = 'mongodb://127.0.0.1:27150/customer_acceptance_v2_test?retryWrites=true&replicaSet=customer_acceptance_v2_rs'

test('accepts only the exact isolated V2 test MongoDB target', () => {
  assert.deepEqual(
    assertV2TestMongoTarget(
      validUri
    ),
    EXPECTED_V2_TEST_MONGO_TARGET
  )
})

for (const [name, uri, expectedField] of [
  ['protocol', 'mongodb+srv://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs', 'protocol'],
  ['hostname', 'mongodb://localhost:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs', 'hostname'],
  ['port', 'mongodb://127.0.0.1:27017/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs', 'port'],
  ['missing port', 'mongodb://127.0.0.1/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs', 'port'],
  ['database', 'mongodb://127.0.0.1:27150/production?replicaSet=customer_acceptance_v2_rs', 'database'],
  ['replica set', 'mongodb://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=other', 'replicaSet'],
  ['missing replica set', 'mongodb://127.0.0.1:27150/customer_acceptance_v2_test', 'replicaSet'],
  ['duplicate replica set', 'mongodb://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs&replicaSet=customer_acceptance_v2_rs', 'replicaSet'],
  ['case-variant duplicate replica set', 'mongodb://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs&REPLICASET=other', 'replicaSet'],
  ['multiple hosts', 'mongodb://127.0.0.1:27150,127.0.0.1:27017/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs', 'uri'],
  ['fragment', 'mongodb://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs#other', 'hash']
]) {
  test(`rejects a MongoDB target with incorrect ${name}`, () => {
    assert.throws(
      () => assertV2TestMongoTarget(uri),
      (error) => error.code === 'V2_TEST_MONGODB_TARGET_INVALID' &&
        error.fields.includes(expectedField)
    )
  })
}

test('reads MONGODB_URI from an environment file without shell evaluation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-mongo-guard-'))
  try {
    const environmentFile = path.join(directory, 'app.env')
    fs.writeFileSync(environmentFile, `# isolated target\nMONGODB_URI="${validUri}"\n`, 'utf8')
    assert.equal(readMongoUriFromEnvironmentFile(environmentFile), validUri)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('reads legacy CR-only environment lines without merging adjacent settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-mongo-guard-'))
  try {
    const environmentFile = path.join(directory, 'app.env')
    fs.writeFileSync(
      environmentFile,
      `ENABLE_LEGACY_PUBLIC_UPLOADS=false\rMONGODB_URI=${validUri}\rEQUIPMENT_ROUTINE_WORKER_ENABLED=true\r`,
      'utf8'
    )
    assert.equal(readMongoUriFromEnvironmentFile(environmentFile), validUri)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the guard CLI accepts the exact target from app.env or operations.env', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-mongo-guard-'))
  try {
    for (const name of ['app.env', 'operations.env']) {
      const environmentFile = path.join(directory, name)
      fs.writeFileSync(environmentFile, `MONGODB_URI=${validUri}\n`, 'utf8')
      const result = spawnSync(process.execPath, [guardPath, '--env-file', environmentFile], {
        encoding: 'utf8'
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).status, 'V2_TEST_MONGODB_TARGET_OK')
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

for (const [name, uri, expectedField] of [
  ['protocol', 'mongodb+srv://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs', 'protocol'],
  ['hostname', 'mongodb://localhost:27150/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs', 'hostname'],
  ['port', 'mongodb://127.0.0.1:27017/customer_acceptance_v2_test?replicaSet=customer_acceptance_v2_rs', 'port'],
  ['database', 'mongodb://127.0.0.1:27150/task_distribution?replicaSet=customer_acceptance_v2_rs', 'database'],
  ['replicaSet', 'mongodb://127.0.0.1:27150/customer_acceptance_v2_test?replicaSet=production_rs', 'replicaSet']
]) {
  test(`the guard CLI rejects app.env and operations.env with incorrect ${name}`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-mongo-guard-'))
    try {
      for (const fileName of ['app.env', 'operations.env']) {
        const environmentFile = path.join(directory, fileName)
        fs.writeFileSync(environmentFile, `MONGODB_URI=${uri}\n`, 'utf8')
        const result = spawnSync(process.execPath, [guardPath, '--env-file', environmentFile], {
          encoding: 'utf8'
        })
        assert.equal(result.status, 1, result.stdout)
        const error = JSON.parse(result.stderr)
        assert.equal(error.code, 'V2_TEST_MONGODB_TARGET_INVALID')
        assert.ok(error.fields.includes(expectedField), result.stderr)
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}

test('release scripts route app.env and operations.env through the exact target guard', () => {
  const common = fs.readFileSync(
    fileURLToPath(new URL('../linux/v2-test-release-common.sh', import.meta.url)),
    'utf8'
  )
  const backup = fs.readFileSync(
    fileURLToPath(new URL('../linux/create-v2-test-release-backup.sh', import.meta.url)),
    'utf8'
  )
  assert.match(
    common,
    /v2_assert_mongo_environment_file "\$V2_APP_ENV" 'Application MONGODB_URI'/
  )
  assert.match(
    backup,
    /v2_assert_mongo_environment_file "\$operations_env" 'Operations MONGODB_URI'/
  )
})
