export function createLatestRequestGate() {
  let latestRequestId = 0

  return Object.freeze({
    begin(snapshot = {}) {
      latestRequestId += 1
      return Object.freeze({ ...snapshot, requestId: latestRequestId })
    },

    isCurrent(request) {
      return request?.requestId === latestRequestId
    },

    invalidate() {
      latestRequestId += 1
      return latestRequestId
    }
  })
}
