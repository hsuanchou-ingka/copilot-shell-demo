export function createQuotaRefresher({
  fetchQuota,
  onQuota,
  onError,
  onRefreshing = () => {},
  shouldRefresh = () => true,
  intervalMs = 5 * 60 * 1000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let stopped = false
  let inFlight = null
  let timer = null

  function schedule() {
    if (stopped) return
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void refresh()
    }, intervalMs)
  }

  function refresh() {
    if (stopped) return Promise.resolve()
    if (inFlight) return inFlight
    if (!shouldRefresh()) {
      schedule()
      return Promise.resolve()
    }
    onRefreshing(true)
    inFlight = Promise.resolve()
      .then(fetchQuota)
      .then((result) => {
        if (!result?.ok || !result.quota) {
          throw new Error(result?.error?.message || 'Could not update usage.')
        }
        if (!stopped) onQuota(result.quota)
      })
      .catch((error) => {
        if (!stopped) onError(error)
      })
      .finally(() => {
        inFlight = null
        if (!stopped) onRefreshing(false)
        schedule()
      })
    return inFlight
  }

  return {
    refresh,
    stop() {
      stopped = true
      if (timer !== null) clearTimer(timer)
    },
  }
}
