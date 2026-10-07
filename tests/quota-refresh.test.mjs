import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuotaRefresher } from '../src/quota-refresh.mjs'

function setup(fetchQuota) {
  const timers = new Map()
  const quotas = []
  const errors = []
  let id = 0
  let visible = true
  const refresher = createQuotaRefresher({
    fetchQuota,
    onQuota: (quota) => quotas.push(quota),
    onError: (error) => errors.push(error.message),
    shouldRefresh: () => visible,
    setTimer: (callback, delay) => {
      timers.set(++id, { callback, delay })
      return id
    },
    clearTimer: (key) => timers.delete(key),
  })
  return {
    refresher, timers, quotas, errors,
    hide: () => { visible = false },
    show: () => { visible = true },
    async tick() {
      const [key, timer] = timers.entries().next().value
      timers.delete(key)
      timer.callback()
      await refresher.refresh()
    },
  }
}

test('quota refreshes every five minutes without waiting for a turn to finish', async () => {
  let count = 0
  const s = setup(async () => ({ ok: true, quota: { used: ++count } }))
  await s.refresher.refresh()
  assert.equal([...s.timers.values()][0].delay, 300000)
  await s.tick()
  assert.deepEqual(s.quotas, [{ used: 1 }, { used: 2 }])
  s.refresher.stop()
})

test('focus and turn completion refresh immediately and share an in-flight request', async () => {
  let resolve
  let count = 0
  const s = setup(() => {
    count++
    return new Promise((done) => { resolve = done })
  })
  const first = s.refresher.refresh()
  assert.equal(s.refresher.refresh(), first)
  await Promise.resolve()
  assert.equal(count, 1)
  resolve({ ok: true, quota: { used: 2 } })
  await first
  assert.equal(s.timers.size, 1)
  s.refresher.stop()
})

test('failed reads retain the last quota, surface failure and retry', async () => {
  const replies = [
    { ok: true, quota: { used: 1 } },
    { ok: true, quota: null },
    { ok: true, quota: { used: 3 } },
  ]
  const s = setup(async () => replies.shift())
  await s.refresher.refresh()
  await s.tick()
  assert.deepEqual(s.quotas, [{ used: 1 }])
  assert.deepEqual(s.errors, ['Could not update usage.'])
  await s.tick()
  assert.deepEqual(s.quotas, [{ used: 1 }, { used: 3 }])
  s.refresher.stop()
})

test('hidden windows skip reads and returning to the app refreshes immediately', async () => {
  let count = 0
  const s = setup(async () => ({ ok: true, quota: { used: ++count } }))
  s.hide()
  await s.refresher.refresh()
  assert.equal(count, 0)
  s.show()
  await s.refresher.refresh()
  assert.equal(count, 1)
  s.refresher.stop()
})

test('cleanup ignores late results and clears polling', async () => {
  let resolve
  const s = setup(() => new Promise((done) => { resolve = done }))
  const pending = s.refresher.refresh()
  await Promise.resolve()
  s.refresher.stop()
  resolve({ ok: true, quota: { used: 5 } })
  await pending
  assert.deepEqual(s.quotas, [])
  assert.equal(s.timers.size, 0)
})
