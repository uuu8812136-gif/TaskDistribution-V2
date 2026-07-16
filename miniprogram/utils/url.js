export function joinHttpUrl(baseUrl, path) {
  if (!baseUrl || !path) return ''
  if (/^https?:\/\//i.test(path)) return path
  const normalizedBase = String(baseUrl).replace(/\/+$/, '')
  const normalizedPath = String(path).replace(/\\/g, '/').replace(/^\/+/, '')
  return `${normalizedBase}/${normalizedPath}`
}
