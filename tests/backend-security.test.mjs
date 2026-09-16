import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { isOwnAppPage, isTrustedRendererEvent, registerIpcHandle } from '../electron/security.mjs'

const entry = path.resolve('/Applications/HC Copilot.app/Contents/Resources/app.asar/dist/index.html')

test('packaged navigation only accepts the app entry document', () => {
  const options = { isDev: false, devOrigin: 'http://127.0.0.1:5173', packagedEntryFile: entry }
  assert.equal(isOwnAppPage(`file://${entry}`, options), true)
  assert.equal(isOwnAppPage(`file://${entry}#route`, options), true)
  assert.equal(isOwnAppPage('file:///etc/passwd', options), false)
  assert.equal(isOwnAppPage('file:///tmp/attacker.html', options), false)
  assert.equal(isOwnAppPage('https://example.com', options), false)
  assert.equal(isOwnAppPage('not a URL', options), false)
})

test('development navigation stays on the Vite entry route', () => {
  const options = { isDev: true, devOrigin: 'http://127.0.0.1:5173', packagedEntryFile: entry }
  assert.equal(isOwnAppPage('http://127.0.0.1:5173/', options), true)
  assert.equal(isOwnAppPage('http://127.0.0.1:5173/index.html', options), true)
  assert.equal(isOwnAppPage('http://127.0.0.1:5173/src/App.jsx', options), false)
  assert.equal(isOwnAppPage('http://localhost:5173/', options), false)
})

test('IPC accepts only the main frame of the live window', () => {
  const mainFrame = { url: `file://${entry}` }
  const window = {
    webContents: { mainFrame },
    isDestroyed: () => false,
  }
  const event = {
    sender: window.webContents,
    senderFrame: mainFrame,
  }
  assert.equal(isTrustedRendererEvent(event, window), true)
  assert.equal(isTrustedRendererEvent(event, window, {
    isDev: false,
    devOrigin: 'http://127.0.0.1:5173',
    packagedEntryFile: entry,
  }), true)
  assert.equal(isTrustedRendererEvent({ ...event, sender: {} }, window), false)
  assert.equal(isTrustedRendererEvent({ ...event, senderFrame: {} }, window), false)
  mainFrame.url = 'file:///tmp/attacker.html'
  assert.equal(isTrustedRendererEvent(event, window, {
    isDev: false,
    devOrigin: 'http://127.0.0.1:5173',
    packagedEntryFile: entry,
  }), false)
  mainFrame.url = `file://${entry}`
  assert.equal(isTrustedRendererEvent(event, { ...window, isDestroyed: () => true }), false)
})

test('IPC wrapper refuses untrusted calls before invoking the handler', async () => {
  let registered
  let called = false
  const ipcMain = { handle: (_channel, handler) => { registered = handler } }
  const mainFrame = { url: 'http://127.0.0.1:5173/' }
  const mainWindow = {
    webContents: { mainFrame },
    isDestroyed: () => false,
  }
  const pageOptions = {
    isDev: true,
    devOrigin: 'http://127.0.0.1:5173',
    packagedEntryFile: entry,
  }
  registerIpcHandle(ipcMain, 'test', (_event, value) => {
    called = true
    return { ok: true, value }
  }, () => mainWindow, () => pageOptions)

  assert.deepEqual(await registered({ sender: {}, senderFrame: { ...mainFrame, url: 'http://127.0.0.1:5173/' } }, 'blocked'), {
    ok: false,
    error: { message: 'Unauthorized renderer.' },
  })
  assert.equal(called, false)
  mainFrame.url = 'http://127.0.0.1:5173/src/App.jsx'
  assert.deepEqual(await registered({
    sender: mainWindow.webContents,
    senderFrame: mainFrame,
  }, 'blocked-route'), {
    ok: false,
    error: { message: 'Unauthorized renderer.' },
  })
  assert.equal(called, false)
  mainFrame.url = 'http://127.0.0.1:5173/'
  assert.deepEqual(await registered({
    sender: mainWindow.webContents,
    senderFrame: mainFrame,
  }, 'allowed'), {
    ok: true,
    value: 'allowed',
  })
  assert.equal(called, true)
})
