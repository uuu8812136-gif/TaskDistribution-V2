export function routeComponentKey(route = {}, contextEpoch = 0) {
  const reusableKeys = new Set(
    Array.isArray(route.meta?.reuseQueryKeys) ? route.meta.reuseQueryKeys : []
  )
  if (!reusableKeys.size) return `${route.fullPath || route.path || ''}:${contextEpoch}`

  const retainedQuery = Object.keys(route.query || {})
    .filter((key) => !reusableKeys.has(key))
    .sort()
    .map((key) => [key, route.query[key]])
  return `${route.path || ''}:${JSON.stringify(retainedQuery)}:${route.hash || ''}:${contextEpoch}`
}
