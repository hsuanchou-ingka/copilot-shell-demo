import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function isTrustedRendererEvent(event, mainWindow, pageOptions) {
  const sameMainFrame = Boolean(
    mainWindow
    && !mainWindow.isDestroyed()
    && event?.sender === mainWindow.webContents
    && event?.senderFrame === mainWindow.webContents.mainFrame,
  )
  if (!sameMainFrame) return false
  if (!pageOptions) return true
  return isOwnAppPage(event.senderFrame.url, pageOptions)
}

export function isOwnAppPage(target, { isDev, devOrigin, packagedEntryFile }) {
  try {
    const url = new URL(target)
    if (isDev) {
      return url.origin === devOrigin
        && (url.pathname === '/' || url.pathname === '/index.html')
    }
    return url.protocol === 'file:'
      && path.resolve(fileURLToPath(url)) === path.resolve(packagedEntryFile)
  } catch {
    return false
  }
}

export function registerIpcHandle(ipcMain, channel, handler, getMainWindow, getPageOptions) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedRendererEvent(event, getMainWindow(), getPageOptions?.())) {
      return { ok: false, error: { message: 'Unauthorized renderer.' } }
    }
    return handler(event, ...args)
  })
}
