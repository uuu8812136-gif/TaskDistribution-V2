const DEFAULT_EMPTY_MESSAGE = '暂无可复制内容'
const DEFAULT_SUCCESS_MESSAGE = '已复制'
const DEFAULT_FAILURE_MESSAGE = '复制失败，请重试'

function runtimeUni() {
  return typeof uni === 'undefined' ? null : uni
}

function runtimeWx() {
  return typeof wx === 'undefined' ? null : wx
}

function showToast(title) {
  const uniRuntime = runtimeUni()
  const wxRuntime = runtimeWx()
  const runtime = uniRuntime && typeof uniRuntime.showToast === 'function'
    ? uniRuntime
    : wxRuntime && typeof wxRuntime.showToast === 'function'
      ? wxRuntime
      : null
  if (!runtime) return
  try {
    runtime.showToast({
      title,
      icon: 'none',
      duration: 1800
    })
  } catch {
    // A toast is only feedback; clipboard handling must not fail because it.
  }
}

function normalizeText(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * Copy text through the native uni-app API and provide feedback for every
 * outcome. The original text is kept intact; trim is used only for emptiness.
 */
export function copyTextToClipboard(value, options = {}) {
  const text = normalizeText(value)
  const emptyMessage = options.emptyMessage || DEFAULT_EMPTY_MESSAGE
  const successMessage = options.successMessage || DEFAULT_SUCCESS_MESSAGE
  const failureMessage = options.failureMessage || DEFAULT_FAILURE_MESSAGE

  if (!text.trim()) {
    showToast(emptyMessage)
    return Promise.resolve({ ok: false, reason: 'empty' })
  }

  const wxRuntime = runtimeWx()
  const uniRuntime = runtimeUni()
  const runtime = wxRuntime && typeof wxRuntime.setClipboardData === 'function'
    ? wxRuntime
    : uniRuntime && typeof uniRuntime.setClipboardData === 'function'
      ? uniRuntime
      : null

  let settled = false
  let resolveResult
  const result = new Promise((resolve) => {
    resolveResult = resolve
  })
  const settle = (ok, error, reason) => {
    if (settled) return
    settled = true
    if (ok) showToast(successMessage)
    else showToast(failureMessage)
    resolveResult({ ok, ...(reason ? { reason } : {}), ...(error ? { error } : {}) })
  }

  if (runtime) {
    try {
      const returned = runtime.setClipboardData({
        data: text,
        success: () => settle(true),
        fail: (error) => settle(false, error)
      })
      // Some uni runtimes expose the callback API as a Promise as well.
      if (returned && typeof returned.then === 'function') {
        returned.then(() => settle(true), (error) => settle(false, error))
      }
    } catch (error) {
      settle(false, error)
    }
    return result
  }

  // H5 fallback: use the browser API when the native mini-program APIs are absent.
  try {
    const browserNavigator = typeof navigator === 'undefined' ? null : navigator
    if (browserNavigator?.clipboard && typeof browserNavigator.clipboard.writeText === 'function') {
      Promise.resolve(browserNavigator.clipboard.writeText(text)).then(
        () => settle(true),
        (error) => settle(false, error)
      )
      return result
    }
    const browserDocument = typeof document === 'undefined' ? null : document
    if (browserDocument && typeof browserDocument.createElement === 'function' &&
      typeof browserDocument.execCommand === 'function' && browserDocument.body) {
      const input = browserDocument.createElement('textarea')
      input.value = text
      input.setAttribute('readonly', '')
      input.style.position = 'fixed'
      input.style.opacity = '0'
      browserDocument.body.appendChild(input)
      input.select()
      const copied = browserDocument.execCommand('copy')
      browserDocument.body.removeChild(input)
      settle(copied)
      return result
    }
  } catch (error) {
    settle(false, error)
    return result
  }
  settle(false, null, 'unavailable')
  return result
}

export { DEFAULT_EMPTY_MESSAGE, DEFAULT_FAILURE_MESSAGE, DEFAULT_SUCCESS_MESSAGE }
