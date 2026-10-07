import test from 'node:test'
import assert from 'node:assert/strict'
import { interruptTurn, prioritizeQueuedMessage } from '../src/turn-interruption.mjs'

test('send now prioritizes the chosen message and preserves other messages and attachments', () => {
  const items = ['a', 'b', 'c'].map((id) => ({ id, attachments: [{ path: id }] }))
  const next = prioritizeQueuedMessage(items, 'c')
  assert.deepEqual(next.map((item) => item.id), ['c', 'a', 'b'])
  assert.equal(next[0], items[2])
  assert.deepEqual(items.map((item) => item.id), ['a', 'b', 'c'])
  assert.equal(prioritizeQueuedMessage(items, 'deleted'), items)
})

test('idle during abort cannot drain the queue before the chosen message is prioritized', async () => {
  const pending = new Set()
  let queue = [{ id: 'a' }, { id: 'b' }]
  const sent = []
  const drain = () => {
    if (!pending.has('session') && queue.length) sent.push(queue.shift().id)
  }
  const ok = await interruptTurn({
    sessionId: 'session',
    pending,
    abort: async () => {
      drain()
      assert.deepEqual(sent, [])
      return { ok: true }
    },
    onStopped: () => {
      queue = prioritizeQueuedMessage(queue, 'b')
      drain()
    },
    onError: assert.fail,
  })
  assert.equal(ok, true)
  assert.deepEqual(sent, ['b'])
  assert.deepEqual(queue, [{ id: 'a' }])
})

test('failed or rejected stop leaves queued messages untouched and releases the lock', async () => {
  for (const abort of [
    async () => ({ ok: false, error: { message: 'failed' } }),
    async () => { throw new Error('offline') },
  ]) {
    const pending = new Set()
    let stopped = false
    const errors = []
    assert.equal(await interruptTurn({
      sessionId: 'session', pending, abort,
      onStopped: () => { stopped = true },
      onError: (error) => errors.push(error.message),
    }), false)
    assert.equal(stopped, false)
    assert.equal(pending.size, 0)
    assert.equal(errors.length, 1)
  }
})

test('repeated clicks share the pending stop instead of aborting twice', async () => {
  const pending = new Set()
  let resolve
  let calls = 0
  let stopped = 0
  const options = {
    sessionId: 'session', pending,
    abort: () => {
      calls++
      return new Promise((done) => { resolve = done })
    },
    onStopped: () => { stopped++ },
    onError: assert.fail,
  }
  const first = interruptTurn(options)
  assert.equal(await interruptTurn(options), false)
  resolve({ ok: true })
  assert.equal(await first, true)
  assert.equal(calls, 1)
  assert.equal(stopped, 1)
})
