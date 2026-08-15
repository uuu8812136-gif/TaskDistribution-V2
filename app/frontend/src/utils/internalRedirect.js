const INTERNAL_ORIGIN = 'https://internal.horselink.invalid'

export function safeInternalRedirect(value) {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return ''

  try {
    const parsed = new URL(candidate, INTERNAL_ORIGIN)
    if (parsed.origin !== INTERNAL_ORIGIN) return ''
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return ''
  }
}

export function teamSelectionLocation(redirect) {
  const target = safeInternalRedirect(redirect)
  return {
    name: 'TeamSelect',
    ...(target ? { query: { redirect: target } } : {})
  }
}
