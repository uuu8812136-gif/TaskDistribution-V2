const LIST_ROUTE_NAMES = new Set([
  'Users',
  'Organization',
  'TeamControl',
  'Equipment',
  'EquipmentCategories',
  'EquipmentRules',
  'EquipmentRoutineWorkbench',
  'EquipmentInventories',
  'EquipmentRepairs',
  'EquipmentStatusApplications',
  'TransportRecords',
  'SupplierContracts',
  'ContractExpiryAlerts',
  'SupplierSettlementFees',
  'ProductionSchedules',
  'AttendanceReports',
  'GeneratedDailyReports',
  'ImportTemplateLibrary',
  'Tasks',
  'MyTasks',
  'TaskBoard',
  'Extensions',
  'AuditLogs',
  'Messages'
])

function normalizeEpoch(value) {
  const epoch = Number(value)
  return Number.isFinite(epoch) && epoch >= 0 ? epoch : 0
}

function normalizeScrollTop(value) {
  const scrollTop = Number(value)
  return Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0
}

export function isListStateRoute(route = {}) {
  return LIST_ROUTE_NAMES.has(String(route.name || ''))
}

export function listRouteIdentity(route = {}) {
  const name = String(route.name || '')
  if (name) return name
  return String(route.path || '')
}

/**
 * Holds the in-memory state for one MainLayout instance.
 *
 * `cacheEpoch` belongs to the KeepAlive host, not an individual page. Changing
 * it unmounts every cached list so sidebar and team-context resets cannot leave
 * stale instances behind. A list component key deliberately ignores query and
 * hash changes; the mounted page observes those through Vue Router instead.
 */
export function createListNavigationState(initialContextEpoch = 0) {
  return {
    contextEpoch: normalizeEpoch(initialContextEpoch),
    cacheEpoch: 0,
    scrollPositions: new Map(),

    cacheHostKey() {
      return `list-cache:${this.contextEpoch}:${this.cacheEpoch}`
    },

    componentKey(route = {}) {
      const identity = listRouteIdentity(route)
      return identity ? `list:${identity}:${this.contextEpoch}` : ''
    },

    renderKey(route = {}) {
      return `${this.cacheHostKey()}:${this.componentKey(route)}`
    },

    rememberScroll(route = {}, scrollTop = 0) {
      if (!isListStateRoute(route)) return false
      const key = this.componentKey(route)
      if (!key) return false
      this.scrollPositions.set(key, normalizeScrollTop(scrollTop))
      return true
    },

    scrollTopFor(route = {}) {
      if (!isListStateRoute(route)) return 0
      return normalizeScrollTop(this.scrollPositions.get(this.componentKey(route)))
    },

    reset(nextContextEpoch = this.contextEpoch) {
      this.contextEpoch = normalizeEpoch(nextContextEpoch)
      this.cacheEpoch += 1
      this.scrollPositions.clear()
      return this.cacheHostKey()
    },

    synchronizeContext(nextContextEpoch) {
      const normalized = normalizeEpoch(nextContextEpoch)
      if (normalized === this.contextEpoch) return false
      this.reset(normalized)
      return true
    }
  }
}

/**
 * Coordinates real router navigation with the list cache state. A sidebar
 * reset is committed from `afterEach`, so an aborted/cancelled guard leaves the
 * current cache untouched. Navigating to the exact current menu is an explicit
 * refresh and therefore resets immediately without asking Vue Router to run a
 * duplicate navigation.
 */
export function createListNavigationCoordinator({
  router,
  state,
  restoreScroll = () => {},
  scheduleRestore = (work) => work()
} = {}) {
  if (!router || !state) {
    throw new TypeError('router and state are required')
  }

  let installed = false
  let removeAfterHook = null
  let navigationSequence = 0
  const pendingMenuNavigations = []

  const currentRoute = () => router.currentRoute?.value || {}
  const navigationIncludesTarget = (route, targetFullPath) => {
    let candidate = route
    while (candidate) {
      if (candidate.fullPath === targetFullPath) return true
      candidate = candidate.redirectedFrom
    }
    return false
  }

  const scheduleRouteRestore = (route = currentRoute()) => {
    const expectedRenderKey = state.renderKey(route)
    const scrollTop = state.scrollTopFor(route)
    scheduleRestore(() => restoreScroll(scrollTop, expectedRenderKey))
  }

  const resetAll = (nextContextEpoch = state.contextEpoch, route = currentRoute()) => {
    state.reset(nextContextEpoch)
    scheduleRouteRestore(route)
  }

  const install = () => {
    if (installed) return
    installed = true

    removeAfterHook = router.afterEach((to, _from, failure) => {
      const pendingIndex = pendingMenuNavigations.findIndex((navigation) => (
        navigationIncludesTarget(to, navigation.targetFullPath)
      ))
      const pending = pendingIndex >= 0
        ? pendingMenuNavigations.splice(pendingIndex, 1)[0]
        : null

      if (failure) return
      if (pending) {
        state.reset(state.contextEpoch)
        pending.reset = true
      }
      scheduleRouteRestore(to)
    })
  }

  const navigateFromMenu = async (location) => {
    const target = router.resolve(location)
    const source = router.resolve(currentRoute().fullPath || currentRoute())

    if (target.fullPath === source.fullPath) {
      resetAll(state.contextEpoch, source)
      return { reset: true, failure: null, duplicate: true }
    }

    const pending = {
      id: ++navigationSequence,
      targetFullPath: target.fullPath,
      reset: false
    }
    pendingMenuNavigations.push(pending)
    try {
      const failure = await router.push(target)
      return {
        reset: pending.reset,
        failure: failure || null,
        duplicate: false
      }
    } finally {
      const pendingIndex = pendingMenuNavigations.indexOf(pending)
      if (pendingIndex >= 0) pendingMenuNavigations.splice(pendingIndex, 1)
    }
  }

  const synchronizeContext = (contextEpoch) => {
    if (!state.synchronizeContext(contextEpoch)) return false
    scheduleRouteRestore(currentRoute())
    return true
  }

  const dispose = () => {
    pendingMenuNavigations.length = 0
    removeAfterHook?.()
    removeAfterHook = null
    installed = false
  }

  return {
    dispose,
    install,
    navigateFromMenu,
    resetAll,
    scheduleRouteRestore,
    synchronizeContext
  }
}
