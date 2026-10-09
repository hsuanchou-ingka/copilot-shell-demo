// A click on a link in a transcript, followed all the way from the renderer handler through a
// mocked IPC bridge into the real main process resolver and on to a stubbed shell. No browser and
// no window are opened: the renderer helpers are the real source taken out of App.jsx and run
// against a small fake window.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { defaultUrlTransform } from 'react-markdown'
import { openLinkTarget } from '../electron/open-link.mjs'

const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const helperSource = appSource.slice(
  appSource.indexOf('function reportLinkFailure'),
  appSource.indexOf("const RUNNABLE_LANGUAGES = new Set(['bash'"),
)

// The renderer helpers, loaded from the shipping source rather than copied into the test.
function loadRenderer({ openLink, openExternal } = {}) {
  const toasts = []
  const sandbox = {
    defaultUrlTransform,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    window: {
      copilot: { openLink, openExternal },
      dispatchEvent: (event) => { toasts.push(event.detail) },
    },
  }
  sandbox.window.CustomEvent = sandbox.CustomEvent
  vm.createContext(sandbox)
  vm.runInContext(`${helperSource}\nglobalThis.__api = { openLink, openLinkFromEvent, markdownUrlTransform }`, sandbox)
  return { api: sandbox.__api, toasts }
}

function clickEvent() {
  let prevented = false
  return { preventDefault: () => { prevented = true }, get prevented() { return prevented } }
}

// Stands in for the preload bridge and the ipcMain handler, so the click really does end up in
// the same resolver the packaged app runs.
function bridgeTo(shell) {
  const opened = []
  return {
    opened,
    openLink: (payload) => openLinkTarget(payload, {
      openPath: async (target) => { opened.push(['path', target]); return shell?.openPathError || '' },
      openExternal: async (url) => { opened.push(['external', url]) },
    }),
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('clicking the handover ZIP link opens the real file on disk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hc-click-'))
  const real = path.join(root, 'Customer Day Claude Design.zip')
  await writeFile(real, 'zip', 'utf8')

  const bridge = bridgeTo()
  const { api, toasts } = loadRenderer({ openLink: bridge.openLink })
  const event = clickEvent()
  api.openLinkFromEvent(event, `${root}/Customer%20Day%20Claude%20Design.zip`, '')
  await settle()

  assert.equal(event.prevented, true, 'the renderer must not navigate away from its own page')
  assert.deepEqual(bridge.opened, [['path', real]])
  assert.deepEqual(toasts, [], 'a link that worked must not raise an error toast')
})

test('clicking a handover markdown link inside the session folder opens it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hc-click-'))
  await mkdir(path.join(root, 'customer-day-review-design-handoff'), { recursive: true })
  const real = path.join(root, 'customer-day-review-design-handoff', 'Claude Prompt.md')
  await writeFile(real, '# prompt', 'utf8')

  const bridge = bridgeTo()
  const { api, toasts } = loadRenderer({ openLink: bridge.openLink })
  api.openLinkFromEvent(clickEvent(), 'customer-day-review-design-handoff/Claude%20Prompt.md', root)
  await settle()

  assert.deepEqual(bridge.opened, [['path', real]])
  assert.deepEqual(toasts, [])
})

test('clicking a link to a file that is not there explains which path was tried', async () => {
  const bridge = bridgeTo()
  const { api, toasts } = loadRenderer({ openLink: bridge.openLink })
  api.openLinkFromEvent(clickEvent(), '/Users/hsuan.chou/gone/Claude%20Prompt.md', '')
  await settle()

  assert.deepEqual(bridge.opened, [], 'nothing should reach the shell')
  assert.equal(toasts.length, 1)
  assert.match(toasts[0], /no file at \/Users\/hsuan\.chou\/gone\/Claude Prompt\.md/)
  assert.doesNotMatch(toasts[0], /Invalid URL/)
})

test('clicking a web link still reaches the browser untouched', async () => {
  const bridge = bridgeTo()
  const { api, toasts } = loadRenderer({ openLink: bridge.openLink })
  api.openLinkFromEvent(clickEvent(), 'https://github.com/hsuanchou-ingka', '')
  await settle()

  assert.deepEqual(bridge.opened, [['external', 'https://github.com/hsuanchou-ingka']])
  assert.deepEqual(toasts, [])
})

test('clicking an in-page anchor is left alone', async () => {
  const bridge = bridgeTo()
  const { api, toasts } = loadRenderer({ openLink: bridge.openLink })
  const event = clickEvent()
  api.openLinkFromEvent(event, '#summary', '')
  await settle()

  assert.equal(event.prevented, false, 'an anchor must keep its normal jump')
  assert.deepEqual(bridge.opened, [])
  assert.deepEqual(toasts, [])
})

test('a scheme that can run code never reaches the shell', async () => {
  const bridge = bridgeTo()
  const { api, toasts } = loadRenderer({ openLink: bridge.openLink })
  api.openLinkFromEvent(clickEvent(), 'javascript:alert(1)', '')
  await settle()

  assert.deepEqual(bridge.opened, [])
  assert.match(toasts[0], /not allowed/)
})

test('a shell that refuses to open the file says so on screen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hc-click-'))
  const real = path.join(root, 'a.md')
  await writeFile(real, 'x', 'utf8')
  const bridge = bridgeTo({ openPathError: 'No application is set to open this.' })
  const { api, toasts } = loadRenderer({ openLink: bridge.openLink })
  api.openLinkFromEvent(clickEvent(), real, '')
  await settle()

  assert.deepEqual(toasts, ['No application is set to open this.'])
})

test('the markdown transform keeps file links while still blocking script URLs', () => {
  const { api } = loadRenderer({})
  assert.equal(api.markdownUrlTransform('file:///Users/a/b.md'), 'file:///Users/a/b.md')
  assert.equal(api.markdownUrlTransform('javascript:alert(1)'), '')
  assert.equal(api.markdownUrlTransform('data:text/html,<script>'), '')
  assert.equal(api.markdownUrlTransform('https://example.com'), 'https://example.com')
  // The shapes the handover message actually used must survive the transform untouched.
  const local = '/Users/hsuan.chou/Documents/my-agent/100_Todo/projects/Customer%20Day%20Claude%20Design.zip'
  assert.equal(api.markdownUrlTransform(local), local)
})

test('an older bridge without the link channel still opens web links', async () => {
  const seen = []
  const { api } = loadRenderer({ openExternal: async (url) => { seen.push(url); return { ok: true } } })
  api.openLinkFromEvent(clickEvent(), 'https://example.com', '')
  await settle()
  assert.deepEqual(seen, ['https://example.com'])
})
