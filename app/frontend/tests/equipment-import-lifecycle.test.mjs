import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

import {
  createEquipmentImportAbortManager,
  createEquipmentImportLifecycleGate,
  equipmentImportPreviewStorageKey
} from '../src/utils/equipmentImportLifecycle.js'

const equipmentSource = readFileSync(
  new URL('../src/views/equipment/EquipmentList.vue', import.meta.url),
  'utf8'
)
const dialogSource = readFileSync(
  new URL('../src/views/equipment/components/EquipmentImportDialog.vue', import.meta.url),
  'utf8'
)

test('equipment import preview storage is scoped by user and team context', () => {
  assert.equal(
    equipmentImportPreviewStorageKey('user-1:team-A'),
    'equipmentImportPreviewJobId:user-1%3Ateam-A'
  )
  assert.notEqual(
    equipmentImportPreviewStorageKey('user-1:team-A'),
    equipmentImportPreviewStorageKey('user-1:team-B')
  )
  assert.equal(equipmentImportPreviewStorageKey(''), '')
})

test('equipment import lifecycle gate rejects superseded and old-context responses', () => {
  const gate = createEquipmentImportLifecycleGate('user-1:team-A:1')
  const firstRows = gate.begin('rows')
  const secondRows = gate.begin('rows')
  const preview = gate.begin('preview')

  assert.equal(gate.isCurrent(firstRows), false)
  assert.equal(gate.isCurrent(secondRows), true)
  assert.equal(gate.isCurrent(preview), true)

  gate.invalidate('user-1:team-B:2')
  assert.equal(gate.isCurrent(secondRows), false)
  assert.equal(gate.isCurrent(preview), false)
  assert.equal(gate.isCurrent(gate.begin('rows')), true)
})

test('equipment import preview API passes the caller AbortSignal to the request layer', async () => {
  const controller = new AbortController()
  const onUploadProgress = () => {}
  const file = new Blob(['workbook'], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  const frontendRoot = fileURLToPath(new URL('..', import.meta.url))
  const server = await createServer({
    root: frontendRoot,
    configFile: false,
    cacheDir: fileURLToPath(new URL('../../../work/tmp/release-chain-audit/vite-equipment-import', import.meta.url)),
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('../src', import.meta.url))
      }
    },
    plugins: [{
      name: 'capture-equipment-import-request',
      enforce: 'pre',
      resolveId(source) {
        const normalized = source.replaceAll('\\', '/')
        return source === '@/utils/request' || normalized.endsWith('/src/utils/request')
          ? '\0equipment-import-request'
          : null
      },
      load(id) {
        return id === '\0equipment-import-request'
          ? 'export default function request(config) { return config }'
          : null
      }
    }]
  })

  try {
    const equipmentApi = await server.ssrLoadModule('/src/api/equipment.js')
    const config = equipmentApi.createEquipmentImportPreview(file, {
      onUploadProgress,
      signal: controller.signal
    })

    assert.equal(config.url, '/equipment/imports')
    assert.equal(config.method, 'post')
    assert.equal(config.signal, controller.signal)
    assert.equal(config.onUploadProgress, onUploadProgress)
    assert.equal(config.data.get('file')?.size, file.size)
    assert.equal(config.data.get('file')?.type, file.type)
  } finally {
    await server.close()
  }
})

test('equipment import abort manager cancels superseded and explicitly invalidated previews', () => {
  const manager = createEquipmentImportAbortManager()
  const first = manager.begin()
  assert.equal(first.signal.aborted, false)

  const second = manager.begin()
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, false)
  assert.equal(manager.clear(first), false)

  assert.equal(manager.abort(), true)
  assert.equal(second.signal.aborted, true)
  assert.equal(manager.abort(), false)
})

test('equipment import dialog binds storage and requests to the live page context', () => {
  assert.match(equipmentSource, /:context-key="equipmentImportContextKey"/)
  assert.match(equipmentSource, /:context-revision="session\.contextEpoch"/)
  assert.match(equipmentSource, /String\(session\.user\?\._id \|\| ''\)[\s\S]*currentTeamContextId\(\)/)

  assert.match(dialogSource, /equipmentImportPreviewStorageKey\(props\.contextKey\)/)
  assert.match(dialogSource, /const lifecycleContextKey = computed\(\(\) => `\$\{props\.contextKey\}:\$\{props\.contextRevision\}`\)/)
  assert.match(dialogSource, /watch\(lifecycleContextKey,[\s\S]*invalidateLifecycle\(value\)[\s\S]*visible\.value = false/)
  assert.match(dialogSource, /watch\(\(\) => props\.modelValue,[\s\S]*if \(previousValue\) invalidateLifecycle/)
  assert.match(dialogSource, /const controller = previewAbortManager\.begin\(\)/)
  assert.match(dialogSource, /createEquipmentImportPreview\(selectedFile\.value, \{\s*signal: controller\.signal/)
  assert.match(dialogSource, /controller\.signal\.aborted \|\| error\?\.code === 'ERR_CANCELED'/)
  assert.match(dialogSource, /function invalidateLifecycle[\s\S]*?previewAbortManager\.abort\(\)[\s\S]*?lifecycleGate\.invalidate/)
  assert.match(dialogSource, /if \(previewing\.value\) \{\s*invalidateLifecycle\(lifecycleContextKey\.value\)\s*return true/)
  assert.match(dialogSource, /onBeforeUnmount\(\(\) => \{\s*invalidateLifecycle/)

  for (const operation of ['preview', 'rows', 'exceptions', 'refresh', 'publish', 'cancel', 'restore']) {
    assert.match(dialogSource, new RegExp(`currentTicket\\('${operation}'\\)`))
  }
  assert.match(dialogSource, /if \(!isCurrentTicket\(ticket\) \|\| importJob\.value\?\._id !== jobId\) return/)
  assert.match(dialogSource, /if \(!isCurrentTicket\(ticket\) \|\| keyAtStart !== storageKey\.value\) return/)
})
