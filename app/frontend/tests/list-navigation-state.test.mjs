import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  KeepAlive,
  createRenderer,
  defineComponent,
  h,
  nextTick,
  onActivated,
  onDeactivated,
  onMounted,
  onUnmounted,
  reactive,
  watch
} from 'vue'
import {
  RouterView,
  createMemoryHistory,
  createRouter,
  useRoute
} from 'vue-router'

import {
  createListNavigationCoordinator,
  createListNavigationState,
  isListStateRoute,
  listRouteIdentity
} from '../src/utils/listNavigationState.js'

const layoutSource = readFileSync(
  new URL('../src/layouts/MainLayout.vue', import.meta.url),
  'utf8'
)

function createHostNode(type, text = '') {
  return {
    type,
    text,
    props: {},
    children: [],
    parent: null
  }
}

function insertNode(child, parent, anchor = null) {
  if (child.parent) {
    const oldIndex = child.parent.children.indexOf(child)
    if (oldIndex >= 0) child.parent.children.splice(oldIndex, 1)
  }
  child.parent = parent
  const index = anchor ? parent.children.indexOf(anchor) : -1
  if (index >= 0) parent.children.splice(index, 0, child)
  else parent.children.push(child)
}

const testRenderer = createRenderer({
  patchProp(element, key, _previous, next) {
    element.props[key] = next
  },
  insert: insertNode,
  remove(child) {
    if (!child.parent) return
    const index = child.parent.children.indexOf(child)
    if (index >= 0) child.parent.children.splice(index, 1)
    child.parent = null
  },
  createElement(type) {
    return createHostNode(type)
  },
  createText(text) {
    return createHostNode('#text', text)
  },
  createComment(text) {
    return createHostNode('#comment', text)
  },
  setText(node, text) {
    node.text = text
  },
  setElementText(element, text) {
    element.text = text
    element.children.length = 0
  },
  parentNode(node) {
    return node.parent
  },
  nextSibling(node) {
    if (!node.parent) return null
    const index = node.parent.children.indexOf(node)
    return node.parent.children[index + 1] || null
  },
  querySelector() {
    return null
  },
  setScopeId() {},
  cloneNode(node) {
    return { ...node, props: { ...node.props }, children: [...node.children], parent: null }
  },
  insertStaticContent(content, parent, anchor) {
    const node = createHostNode('#static', content)
    insertNode(node, parent, anchor)
    return [node, node]
  }
})

function createLifecycleCounter() {
  return {
    activated: 0,
    deactivated: 0,
    mounted: 0,
    unmounted: 0,
    queryValues: []
  }
}

function createTrackedComponent(label, counter) {
  return defineComponent({
    name: `${label}TestPage`,
    setup() {
      const route = useRoute()
      onMounted(() => { counter.mounted += 1 })
      onActivated(() => { counter.activated += 1 })
      onDeactivated(() => { counter.deactivated += 1 })
      onUnmounted(() => { counter.unmounted += 1 })
      watch(
        () => route.query.filter,
        (value) => counter.queryValues.push(value || ''),
        { immediate: true }
      )
      return () => h('section', `${label}:${route.query.filter || ''}`)
    }
  })
}

async function createRouterKeepAliveHarness(initialLocation = '/equipment?filter=initial') {
  const counters = {
    equipment: createLifecycleCounter(),
    contracts: createLifecycleCounter(),
    detail: createLifecycleCounter()
  }
  const Equipment = createTrackedComponent('equipment', counters.equipment)
  const Contracts = createTrackedComponent('contracts', counters.contracts)
  const Detail = createTrackedComponent('detail', counters.detail)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/equipment', name: 'Equipment', component: Equipment },
      { path: '/equipment/:id', name: 'EquipmentDetail', component: Detail },
      { path: '/contracts/suppliers', name: 'SupplierContracts', component: Contracts },
      { path: '/blocked', name: 'Messages', component: Contracts }
    ]
  })
  const state = reactive(createListNavigationState(3))
  const restored = []
  let scrollTop = 0
  const coordinator = createListNavigationCoordinator({
    router,
    state,
    restoreScroll: (top, expectedKey) => restored.push({ top, expectedKey }),
    scheduleRestore: (work) => nextTick(work)
  })
  const Harness = defineComponent({
    name: 'RouterKeepAliveHarness',
    setup() {
      return () => h(RouterView, null, {
        default: ({ Component, route }) => [
          h(
            KeepAlive,
            { key: state.cacheHostKey() },
            () => isListStateRoute(route)
              ? h(Component, { key: state.componentKey(route) })
              : null
          ),
          !isListStateRoute(route)
            ? h(Component, { key: `detail:${route.fullPath}` })
            : null
        ]
      })
    }
  })

  await router.push(initialLocation)
  await router.isReady()
  const app = testRenderer.createApp(Harness)
  app.use(router)
  app.mount(createHostNode('#root'))
  coordinator.install()
  await nextTick()

  return {
    app,
    coordinator,
    counters,
    restored,
    router,
    setScrollTop(value, { remember = true } = {}) {
      scrollTop = value
      if (remember) state.rememberScroll(router.currentRoute.value, value)
    },
    state,
    async settle() {
      await nextTick()
      await nextTick()
    }
  }
}

test('current business list routes are cached while detail and form routes remain fresh', () => {
  assert.equal(isListStateRoute({ name: 'Equipment' }), true)
  assert.equal(isListStateRoute({ name: 'Organization' }), true)
  assert.equal(isListStateRoute({ name: 'SupplierContracts' }), true)
  assert.equal(isListStateRoute({ name: 'TransportRecords' }), true)
  assert.equal(isListStateRoute({ name: 'TaskDetail' }), false)
  assert.equal(isListStateRoute({ name: 'EditTask' }), false)
  assert.equal(isListStateRoute({ name: 'Profile' }), false)
})

test('a list has one stable key per context and ordinary query changes do not clone it', () => {
  const state = createListNavigationState(4)
  const equipment = {
    name: 'Equipment',
    path: '/equipment',
    fullPath: '/equipment?keyword=one',
    query: { keyword: 'one' }
  }
  const changedQuery = {
    ...equipment,
    fullPath: '/equipment?keyword=two&page=3',
    query: { keyword: 'two', page: '3' }
  }

  assert.equal(listRouteIdentity(equipment), 'Equipment')
  assert.equal(state.componentKey(equipment), state.componentKey(changedQuery))
  assert.equal(state.componentKey(equipment), 'list:Equipment:4')
  assert.notEqual(
    state.componentKey(equipment),
    state.componentKey({ name: 'SupplierContracts', path: '/contracts/suppliers' })
  )

  const oldHost = state.cacheHostKey()
  state.reset()
  assert.notEqual(state.cacheHostKey(), oldHost)
  assert.equal(state.componentKey(equipment), 'list:Equipment:4')
  state.synchronizeContext(5)
  assert.equal(state.componentKey(equipment), 'list:Equipment:5')
})

test('real RouterView and KeepAlive preserve a list on detail return and react to query changes', async (t) => {
  const harness = await createRouterKeepAliveHarness()
  t.after(() => {
    harness.coordinator.dispose()
    harness.app.unmount()
  })

  assert.equal(harness.counters.equipment.mounted, 1)
  assert.equal(harness.counters.equipment.activated, 1)
  harness.setScrollTop(171)

  await harness.router.push('/equipment/E-1')
  await harness.settle()
  assert.equal(harness.counters.equipment.deactivated, 1)
  assert.equal(harness.counters.equipment.unmounted, 0)

  await harness.router.push('/equipment?filter=returned')
  await harness.settle()
  assert.equal(harness.counters.equipment.mounted, 1)
  assert.equal(harness.counters.equipment.activated, 2)
  assert.equal(harness.counters.equipment.queryValues.at(-1), 'returned')
  assert.equal(harness.state.scrollTopFor(harness.router.currentRoute.value), 171)
  assert.equal(harness.restored.at(-1).top, 171)

  await harness.router.replace('/equipment?filter=changed-again&page=2')
  await harness.settle()
  assert.equal(harness.counters.equipment.mounted, 1)
  assert.equal(harness.counters.equipment.queryValues.at(-1), 'changed-again')
})

test('successful sidebar navigation from detail destroys every old cached list', async (t) => {
  const harness = await createRouterKeepAliveHarness()
  t.after(() => {
    harness.coordinator.dispose()
    harness.app.unmount()
  })

  await harness.router.push('/equipment/E-1')
  await harness.settle()
  const previousHost = harness.state.cacheHostKey()
  const result = await harness.coordinator.navigateFromMenu('/contracts/suppliers')
  await harness.settle()

  assert.equal(result.failure, null)
  assert.equal(result.reset, true)
  assert.notEqual(harness.state.cacheHostKey(), previousHost)
  assert.equal(harness.counters.equipment.unmounted, 1)
  assert.equal(harness.counters.contracts.mounted, 1)
  assert.equal(harness.state.scrollPositions.size, 0)
})

test('clicking the current sidebar item recreates the list with clean state', async (t) => {
  const harness = await createRouterKeepAliveHarness()
  t.after(() => {
    harness.coordinator.dispose()
    harness.app.unmount()
  })

  harness.setScrollTop(99)
  const previousHost = harness.state.cacheHostKey()
  const result = await harness.coordinator.navigateFromMenu('/equipment?filter=initial')
  await harness.settle()

  assert.equal(result.duplicate, true)
  assert.equal(result.reset, true)
  assert.notEqual(harness.state.cacheHostKey(), previousHost)
  assert.equal(harness.counters.equipment.mounted, 2)
  assert.equal(harness.counters.equipment.unmounted, 1)
  assert.equal(harness.state.scrollPositions.size, 0)
  assert.equal(harness.restored.at(-1).top, 0)
})

test('a rejected sidebar navigation keeps the current KeepAlive host and scroll memory', async (t) => {
  const harness = await createRouterKeepAliveHarness()
  t.after(() => {
    harness.coordinator.dispose()
    harness.app.unmount()
  })
  harness.router.beforeEach((to) => to.path === '/blocked' ? false : true)
  harness.setScrollTop(88)
  const previousHost = harness.state.cacheHostKey()

  const result = await harness.coordinator.navigateFromMenu('/blocked')
  await harness.settle()

  assert.ok(result.failure)
  assert.equal(result.reset, false)
  assert.equal(harness.router.currentRoute.value.name, 'Equipment')
  assert.equal(harness.state.cacheHostKey(), previousHost)
  assert.equal(harness.counters.equipment.mounted, 1)
  assert.equal(harness.counters.equipment.unmounted, 0)
  assert.equal(harness.state.scrollTopFor(harness.router.currentRoute.value), 88)
})

test('a rejected sidebar navigation during pending scroll restore does not erase the saved position', async (t) => {
  const harness = await createRouterKeepAliveHarness()
  t.after(() => {
    harness.coordinator.dispose()
    harness.app.unmount()
  })
  harness.router.beforeEach((to) => to.path === '/blocked' ? false : true)
  harness.setScrollTop(171)

  await harness.router.push('/equipment/E-1')
  await harness.settle()
  harness.setScrollTop(0, { remember: false })
  await harness.router.push('/equipment?filter=returned')

  const result = await harness.coordinator.navigateFromMenu('/blocked')
  await harness.settle()

  assert.ok(result.failure)
  assert.equal(result.reset, false)
  assert.equal(harness.state.scrollTopFor(harness.router.currentRoute.value), 171)
  assert.equal(harness.restored.at(-1).top, 171)
})

test('concurrent sidebar navigations report reset only for the navigation that actually succeeds', async (t) => {
  const harness = await createRouterKeepAliveHarness()
  t.after(() => {
    harness.coordinator.dispose()
    harness.app.unmount()
  })
  let releaseFirst
  harness.router.beforeEach((to) => {
    if (to.path !== '/blocked') return true
    return new Promise((resolve) => { releaseFirst = resolve })
  })

  const first = harness.coordinator.navigateFromMenu('/blocked')
  while (!releaseFirst) await Promise.resolve()
  const second = harness.coordinator.navigateFromMenu('/contracts/suppliers')
  releaseFirst(true)
  const [firstResult, secondResult] = await Promise.all([first, second])
  await harness.settle()

  assert.ok(firstResult.failure)
  assert.equal(firstResult.reset, false)
  assert.equal(secondResult.failure, null)
  assert.equal(secondResult.reset, true)
  assert.equal(harness.router.currentRoute.value.name, 'SupplierContracts')
})

test('team context changes destroy cached components and switch their stable context key', async (t) => {
  const harness = await createRouterKeepAliveHarness()
  t.after(() => {
    harness.coordinator.dispose()
    harness.app.unmount()
  })

  const previousKey = harness.state.componentKey(harness.router.currentRoute.value)
  harness.setScrollTop(55)
  harness.state.rememberScroll(harness.router.currentRoute.value, 55)
  assert.equal(harness.coordinator.synchronizeContext(9), true)
  await harness.settle()

  assert.notEqual(harness.state.componentKey(harness.router.currentRoute.value), previousKey)
  assert.equal(harness.state.componentKey(harness.router.currentRoute.value), 'list:Equipment:9')
  assert.equal(harness.state.scrollPositions.size, 0)
  assert.equal(harness.counters.equipment.mounted, 2)
  assert.equal(harness.counters.equipment.unmounted, 1)
  assert.equal(harness.coordinator.synchronizeContext(9), false)
})

test('the shared layout wires the runtime coordinator without browser persistence or a bounded LRU', () => {
  assert.match(layoutSource, /<keep-alive :key="listNavigationState\.cacheHostKey\(\)">/)
  assert.match(layoutSource, /:key="listNavigationState\.componentKey\(route\)"/)
  assert.match(layoutSource, /@select="handleMenuSelect"/)
  assert.match(layoutSource, /@scroll\.passive="handleLayoutMainScroll"/)
  assert.doesNotMatch(layoutSource, /:router="true"/)
  assert.match(layoutSource, /createListNavigationCoordinator\(\{/)
  assert.match(layoutSource, /listNavigationCoordinator\.navigateFromMenu\(index\)/)
  assert.match(layoutSource, /listNavigationCoordinator\.synchronizeContext\(contextEpoch\)/)
  assert.match(layoutSource, /listNavigationCoordinator\.dispose\(\)/)
  assert.doesNotMatch(layoutSource, /<keep-alive[^>]*:max=/)
  assert.doesNotMatch(layoutSource, /localStorage|sessionStorage/)
})
