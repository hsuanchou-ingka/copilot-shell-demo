import assert from 'node:assert/strict'
import test from 'node:test'
import { dropDisconnectedClient, getReusableSession } from '../electron/client-cache.mjs'

test('a disconnected SDK client drops stale session handles before reconnecting', () => {
  let unsubscribeCount = 0
  const activeSessions = new Map([
    ['session-1', { session: { sessionId: 'session-1' }, unsubscribe: () => { unsubscribeCount += 1 } }],
    ['session-2', { session: { sessionId: 'session-2' }, unsubscribe: () => { unsubscribeCount += 1 } }],
  ])

  assert.equal(dropDisconnectedClient({ state: 'disconnected' }, activeSessions), true)
  assert.equal(unsubscribeCount, 2)
  assert.equal(activeSessions.size, 0)
})

test('a connected SDK client keeps its active session cache', () => {
  let unsubscribed = false
  const activeSessions = new Map([
    ['session-1', { unsubscribe: () => { unsubscribed = true } }],
  ])

  assert.equal(dropDisconnectedClient({ state: 'connected' }, activeSessions), false)
  assert.equal(unsubscribed, false)
  assert.equal(activeSessions.size, 1)
})

test('resume lookup does not reuse a session after the SDK transport closes', () => {
  const staleSession = { sessionId: 'session-1' }
  const activeSessions = new Map([['session-1', { session: staleSession }]])

  assert.equal(getReusableSession({ state: 'disconnected' }, activeSessions, 'session-1'), undefined)
  assert.equal(getReusableSession({ state: 'connected' }, activeSessions, 'session-1'), staleSession)
})

test('next concurrent resumes create one fresh client and never return a dead handle', async () => {
  const { readFile } = await import('node:fs/promises')
  const { default: vm } = await import('node:vm')
  const source = await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8')
  const clientCode = source.slice(source.indexOf('function discardDisconnectedClient'), source.indexOf('function requestPermission'))
  const resumeCode = source.slice(source.indexOf('async function resumeSession'), source.indexOf('// Returns null when the read fails'))
  let starts = 0
  let resumes = 0
  let unsubscribes = 0
  const freshSession = { sessionId: 'test-session' }
  const activeSessions = new Map([['test-session', { session: { dead: true }, unsubscribe: () => { unsubscribes++ } }]])
  const context = {
    client: { state: 'disconnected' }, startingClient: undefined, activeSessions,
    resumingSessions: new Map(), dropDisconnectedClient, getReusableSession,
    appendLog() {}, getGitHubToken: async () => ({ token: 'test-only', login: 'test' }),
    refuseIfDeleting() {}, sharedSessionConfig: async () => ({}), requestPermission() {},
    attachSession: (session) => { activeSessions.set(session.sessionId, { session }); return session },
    CopilotClient: class {
      async start() { starts++; this.state = 'connected' }
      async resumeSession() { resumes++; return freshSession }
    },
  }
  vm.createContext(context)
  vm.runInContext(clientCode + resumeCode, context)
  const results = await Promise.all([context.resumeSession('test-session'), context.resumeSession('test-session')])
  assert.ok(results.every((session) => session === freshSession))
  assert.equal(starts, 1)
  assert.equal(resumes, 1)
  assert.equal(unsubscribes, 1)
  assert.equal(await context.resumeSession('test-session'), freshSession)
  assert.equal(resumes, 1)
})
