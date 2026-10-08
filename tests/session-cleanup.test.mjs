import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, open, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  EMPTY_GRACE_MS,
  REASON_LABELS,
  cleanupReasons,
  isAutoDeletable,
} from '../src/session-cleanup.mjs'
import { countUserMessages, createSessionStatsReader } from '../electron/session-stats.mjs'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

function session(overrides = {}) {
  return {
    id: 'chat-1',
    title: 'A chat',
    createdAt: new Date(NOW - 2 * DAY).toISOString(),
    updatedAt: new Date(NOW - DAY).toISOString(),
    ...overrides,
  }
}

function ctx(overrides = {}) {
  return { stats: { userMessages: 2, bytes: 100 }, now: NOW, pinned: [], selectedId: null, owned: true, working: false, ...overrides }
}

test('a chat started elsewhere is external, whatever its usage', () => {
  assert.deepEqual(cleanupReasons(session(), ctx({ owned: false })), ['external'])
  assert.deepEqual(cleanupReasons(session(), ctx({ owned: false, stats: undefined })), ['external'])
})

test('an owned chat is empty, one message, or neither, by its user message count', () => {
  assert.deepEqual(cleanupReasons(session(), ctx({ stats: { userMessages: 0, bytes: 0 } })), ['empty'])
  assert.deepEqual(cleanupReasons(session(), ctx({ stats: { userMessages: 1, bytes: 10 } })), ['one-message'])
  assert.deepEqual(cleanupReasons(session(), ctx()), [])
})

test('a count that could not be read or has not arrived says nothing', () => {
  assert.deepEqual(cleanupReasons(session(), ctx({ stats: { userMessages: null, bytes: 0 } })), [])
  assert.deepEqual(cleanupReasons(session(), ctx({ stats: undefined })), [])
  assert.equal(isAutoDeletable(session(), ctx({ stats: undefined, justLeft: true })), false)
})

test('an owned chat untouched for more than 30 days is idle, alongside any other reason', () => {
  const old = session({ updatedAt: new Date(NOW - 31 * DAY).toISOString() })
  assert.deepEqual(cleanupReasons(old, ctx()), ['idle-30d'])
  assert.deepEqual(cleanupReasons(old, ctx({ stats: { userMessages: 1, bytes: 10 } })), ['one-message', 'idle-30d'])
  const recent = session({ updatedAt: new Date(NOW - 29 * DAY).toISOString() })
  assert.deepEqual(cleanupReasons(recent, ctx()), [])
})

test('the open chat, a pinned chat and a working chat never get a reason', () => {
  const empty = { userMessages: 0, bytes: 0 }
  const old = session({ updatedAt: new Date(NOW - 90 * DAY).toISOString() })
  for (const extra of [
    { selectedId: 'chat-1' },
    { pinned: ['chat-1'] },
    { pinned: new Set(['chat-1']) },
    { working: true },
  ]) {
    assert.deepEqual(cleanupReasons(old, ctx({ stats: empty, ...extra })), [])
    assert.deepEqual(cleanupReasons(old, ctx({ owned: false, ...extra })), [])
    assert.equal(isAutoDeletable(old, ctx({ stats: empty, justLeft: true, ...extra })), false)
  }
})

test('only an empty owned chat is removed without asking', () => {
  const empty = { userMessages: 0, bytes: 0 }
  assert.equal(isAutoDeletable(session(), ctx({ stats: empty })), true)
  assert.equal(isAutoDeletable(session(), ctx({ stats: { userMessages: 1, bytes: 10 } })), false)
  assert.equal(isAutoDeletable(session(), ctx({ stats: empty, owned: false })), false)
  const old = session({ updatedAt: new Date(NOW - 90 * DAY).toISOString() })
  assert.equal(isAutoDeletable(old, ctx()), false)
})

test('an empty chat gets ten minutes before it goes, unless it was just left', () => {
  const empty = { userMessages: 0, bytes: 0 }
  const fresh = session({ createdAt: new Date(NOW - 9 * MINUTE).toISOString() })
  const settled = session({ createdAt: new Date(NOW - EMPTY_GRACE_MS - MINUTE).toISOString() })
  assert.equal(isAutoDeletable(fresh, ctx({ stats: empty })), false)
  assert.equal(isAutoDeletable(fresh, ctx({ stats: empty, justLeft: true })), true)
  assert.equal(isAutoDeletable(settled, ctx({ stats: empty })), true)
  assert.equal(isAutoDeletable(session({ createdAt: 'not a date' }), ctx({ stats: empty })), false)
})

test('every reason has a short plain label', () => {
  assert.deepEqual(REASON_LABELS, {
    external: 'External',
    empty: 'Empty',
    'one-message': 'One message',
    'idle-30d': 'Idle 30 days',
  })
})

function line(event) {
  return `${JSON.stringify(event)}\n`
}

test('user messages are counted from the transcript, delegated prompts skipped, capped at two', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'session-stats-'))
  try {
    const file = path.join(directory, 'events.jsonl')
    await writeFile(file, [
      line({ type: 'session.start', data: {} }),
      line({ type: 'user.message', agentId: 'child-1', data: { content: 'briefing' } }),
      line({ type: 'assistant.message', data: { content: 'mentions "user.message" in text' } }),
      line({ type: 'user.message', data: { content: 'first' } }),
    ].join(''))
    assert.equal(await countUserMessages(file), 1)
    await writeFile(file, [
      line({ type: 'user.message', data: { content: 'first' } }),
      line({ type: 'user.message', data: { content: 'second' } }),
      line({ type: 'user.message', data: { content: 'third' } }),
    ].join(''))
    assert.equal(await countUserMessages(file), 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the reader stops at the second message instead of reading on to the end', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'session-stats-'))
  let writer
  try {
    // A pipe that is never closed has no end, so the count only comes back if reading stops
    // as soon as the second message is seen.
    const fifo = path.join(directory, 'events.jsonl')
    execFileSync('mkfifo', [fifo])
    const counting = countUserMessages(fifo)
    writer = await open(fifo, 'w')
    await writer.write(line({ type: 'user.message', data: { content: 'one' } })
      + line({ type: 'user.message', data: { content: 'two' } }))
    const timeout = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('kept reading')), 2000).unref())
    assert.equal(await Promise.race([counting, timeout]), 2)
  } finally {
    await writer?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test('stats per session: missing transcript is zero, bad ids are unknown, results are cached by mtime', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'session-state-'))
  try {
    await mkdir(path.join(root, 'used'))
    const file = path.join(root, 'used', 'events.jsonl')
    await writeFile(file, line({ type: 'user.message', data: { content: 'hi' } }))
    const read = createSessionStatsReader(root)
    const first = await read(['used', 'missing', '../escape'])
    assert.equal(first.used.userMessages, 1)
    assert.equal(first.used.bytes, (await readFile(file)).length)
    assert.deepEqual(first.missing, { userMessages: 0, bytes: 0 })
    assert.equal(first['../escape'].userMessages, null)

    // Same size and mtime: the cached answer comes back without reading the file again.
    const contents = await readFile(file, 'utf8')
    const stamp = new Date(NOW)
    await utimes(file, stamp, stamp)
    const cached = await read(['used'])
    await writeFile(file, contents.replace('hi', 'yo'))
    await utimes(file, stamp, stamp)
    assert.deepEqual(await read(['used']), cached)

    // A new message changes the file, so it is read again.
    await writeFile(file, contents + line({ type: 'user.message', data: { content: 'again' } }))
    assert.equal((await read(['used'])).used.userMessages, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
