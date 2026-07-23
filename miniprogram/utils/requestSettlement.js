export function createRequestSettlement({ finishLoading, resolve, reject }) {
  let loadingFinished = false
  let settled = false

  const finishOnce = () => {
    if (loadingFinished) return false
    loadingFinished = true
    finishLoading()
    return true
  }

  const resolveWith = (producer, mapError) => {
    if (settled) return
    finishOnce()
    try {
      const value = producer()
      settled = true
      resolve(value)
    } catch (error) {
      settled = true
      if (typeof mapError !== 'function') {
        reject(error)
        return
      }
      try {
        reject(mapError(error))
      } catch (mapErrorFailure) {
        reject(mapErrorFailure)
      }
    }
  }

  const rejectWith = (producer) => {
    if (settled) return
    finishOnce()
    try {
      const error = producer()
      settled = true
      reject(error)
    } catch (error) {
      settled = true
      reject(error)
    }
  }

  return {
    resolveWith,
    rejectWith,
    complete: finishOnce
  }
}
