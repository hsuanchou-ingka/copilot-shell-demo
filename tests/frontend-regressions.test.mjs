import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')

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
