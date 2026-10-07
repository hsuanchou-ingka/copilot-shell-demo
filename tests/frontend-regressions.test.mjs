import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { interruptTurn, prioritizeQueuedMessage } from '../src/turn-interruption.mjs'

const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')

test('Send now stops the current turn and sends the selected queued message once', async () => {
  const source = sectionBetween('  const stopSession = async', '\n  const forkSession')
  const queuesRef = { current: { session: [
    { id: 'first', prompt: 'first', attachments: [] },
    { id: 'chosen', prompt: 'chosen', attachments: [{ path: 'file.txt' }] },
  ] } }
  const stoppingRef = { current: new Set() }
  const sent = []
  const errors = []
  const drainQueueRef = { current: (id) => {
    if (stoppingRef.current.has(id)) return false
    const next = queuesRef.current[id].shift()
    if (next) sent.push(next)
    return Boolean(next)
  } }
  const run = new Function(
    'selectedId', 'working', 'planTurnIdsRef', 'stoppingRef', 'setStoppingSessions',
    'interruptTurn', 'api', 'showError', 'turnEndedAtRef', 'finishPlanTurnForSession',
    'patchSessionState', 'queuesRef', 'writeQueue', 'prioritizeQueuedMessage', 'drainQueueRef',
    source + '\nreturn stopSession("chosen")',
  )
  await run(
    'session', true, { current: {} }, stoppingRef, () => {},
    interruptTurn, { abortSession: async (id) => {
      drainQueueRef.current(id)
      return { ok: true }
    } },
    (message) => errors.push(message), { current: {} }, () => {}, () => {},
    queuesRef, (id, items) => { queuesRef.current[id] = items },
    prioritizeQueuedMessage, drainQueueRef,
  )
  assert.deepEqual(sent.map((item) => item.id), ['chosen'])
  assert.deepEqual(sent[0].attachments, [{ path: 'file.txt' }])
  assert.deepEqual(queuesRef.current.session.map((item) => item.id), ['first'])
  assert.deepEqual(errors, [])
  assert.match(appSource, /onClick=\{\(\) => sendQueuedNow\(item.id\)\}/)
  assert.match(appSource, /onClick=\{\(\) => \{ void stopSession\(\) \}\}/)
})

function sectionBetween(start, end) {
  const from = appSource.indexOf(start)
  const to = appSource.indexOf(end, from + start.length)
  assert.notEqual(from, -1, 'missing source section: ' + start)
  assert.notEqual(to, -1, 'missing source section end: ' + end)
  return appSource.slice(from, to)
}

test('session command loading clears stale commands before the fetch resolves', () => {
  const body = sectionBetween(
    '    if (!api?.listCommands || !selectedId) return undefined',
    '\n  }, [api, selectedId])',
  )
  const cleared = []
  const api = { listCommands: () => Promise.resolve({ ok: true, commands: ['new'] }) }
  new Function('api', 'selectedId', 'setCommands', body)(api, 'new-session', (value) => cleared.push(value))
  assert.deepEqual(cleared, [[]])
})

test('collectResources preserves bare and quoted Unicode local paths', () => {
  const helpers = sectionBetween('function folderLabel', 'const SHELL_STARTED_RE')
  const context = { URL, Map, Set, RegExp }
  vm.runInNewContext(helpers, context)
  const resources = context.collectResources([{
    content: 'Open "/Users/hsuan/Library/Mobile Documents/研究 專案/設計稿.txt" and /Users/hsuan/研究專案/摘要.md。',
  }], '')
  assert.deepEqual(
    [...resources].map((resource) => resource.value),
    ['/Users/hsuan/研究專案/摘要.md', '/Users/hsuan/Library/Mobile Documents/研究 專案/設計稿.txt'],
  )
})

test('external open failures are dispatched to the existing error banner', async () => {
  const opener = sectionBetween('function openExternalLink', 'const RUNNABLE_LANGUAGES')
  const dispatched = []
  const window = {
    copilot: { openExternal: async () => ({ ok: false, error: { message: 'blocked' } }) },
    dispatchEvent: (event) => dispatched.push(event),
  }
  const CustomEvent = class {
    constructor(type, init) {
      this.type = type
      this.detail = init.detail
    }
  }
  const openExternalLink = new Function('window', 'CustomEvent', opener + '; return openExternalLink')(window, CustomEvent)
  const event = { preventDefault() {} }
  openExternalLink(event, 'https://example.com')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(dispatched.map((item) => [item.type, item.detail]), [['copilot:external-error', 'blocked']])
})
