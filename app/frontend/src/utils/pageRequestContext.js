function normalized(value) {
  return String(value || '')
}

export function pageRequestContextSnapshot({ route, session, teamId = '', pageActive = true } = {}) {
  return Object.freeze({
    routeName: normalized(route?.name),
    routeFullPath: normalized(route?.fullPath),
    contextEpoch: Number(session?.contextEpoch) || 0,
    teamId: normalized(session?.isGlobalReadOnly ? teamId : session?.activeTeamId),
    pageActive: pageActive === true
  })
}

export function isSamePageRequestContext(snapshot, current) {
  return Boolean(
    snapshot?.pageActive &&
    current?.pageActive &&
    snapshot.routeName === current.routeName &&
    snapshot.routeFullPath === current.routeFullPath &&
    snapshot.contextEpoch === current.contextEpoch &&
    snapshot.teamId === current.teamId
  )
}

export function createPageConfirmationGuard(currentContext) {
  if (typeof currentContext !== 'function') {
    throw new TypeError('currentContext must be a function')
  }

  let revision = 0

  function capture() {
    return Object.freeze({
      revision,
      context: currentContext()
    })
  }

  function isCurrent(snapshot) {
    return Boolean(
      snapshot?.revision === revision &&
      isSamePageRequestContext(snapshot.context, currentContext())
    )
  }

  return Object.freeze({
    capture,
    invalidate() {
      revision += 1
    },
    isCurrent,
    async run({ confirm, mutate }) {
      if (typeof confirm !== 'function' || typeof mutate !== 'function') {
        throw new TypeError('confirm and mutate must be functions')
      }
      const snapshot = capture()
      const stillCurrent = () => isCurrent(snapshot)
      await confirm()
      if (!stillCurrent()) {
        return Object.freeze({ executed: false, current: false, isCurrent: stillCurrent })
      }
      try {
        const value = await mutate()
        return Object.freeze({
          executed: true,
          current: stillCurrent(),
          isCurrent: stillCurrent,
          value
        })
      } catch (error) {
        return Object.freeze({
          executed: true,
          current: stillCurrent(),
          isCurrent: stillCurrent,
          error
        })
      }
    }
  })
}
