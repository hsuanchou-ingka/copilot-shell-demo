const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('copilot', {
  initialize: () => ipcRenderer.invoke('copilot:initialize'),
  refreshQuota: () => ipcRenderer.invoke('copilot:refresh-quota'),
  createSession: (options) => ipcRenderer.invoke('copilot:create-session', options),
  forkSession: (options) => ipcRenderer.invoke('copilot:fork-session', options),
  openSession: (sessionId) => ipcRenderer.invoke('copilot:open-session', sessionId),
  sendMessage: (options) => ipcRenderer.invoke('copilot:send-message', options),
  abortSession: (sessionId) => ipcRenderer.invoke('copilot:abort-session', sessionId),
  pickAttachments: () => ipcRenderer.invoke('copilot:pick-attachments'),
  savePastedImage: (data, extension) => ipcRenderer.invoke('copilot:save-pasted-image', { data, extension }),
  readAttachmentPreview: (filePath) => ipcRenderer.invoke('copilot:read-attachment-preview', filePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  instructionFiles: (workingDirectory) => ipcRenderer.invoke('copilot:instruction-files', workingDirectory),
  setModel: (options) => ipcRenderer.invoke('copilot:set-model', options),
  deleteSession: (sessionId) => ipcRenderer.invoke('copilot:delete-session', sessionId),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  openPath: (targetPath) => ipcRenderer.invoke('app:open-path', targetPath),
  revealPath: (targetPath) => ipcRenderer.invoke('app:reveal-path', targetPath),
  openGitHub: () => ipcRenderer.invoke('app:open-external', 'https://github.com/hsuanchou-ingka'),
  answerPermission: (answer) => ipcRenderer.send('copilot:permission-answer', answer),
  onEvent: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('copilot:event', listener)
    return () => ipcRenderer.removeListener('copilot:event', listener)
  },
  onPermission: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('copilot:permission', listener)
    return () => ipcRenderer.removeListener('copilot:permission', listener)
  },
  onSessionMetadata: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('copilot:session-metadata', listener)
    return () => ipcRenderer.removeListener('copilot:session-metadata', listener)
  },
  onCommand: (handler) => {
    const listener = (_event, command) => handler(command)
    ipcRenderer.on('app:command', listener)
    return () => ipcRenderer.removeListener('app:command', listener)
  },
})
