import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CopilotClient } from '@github/copilot-sdk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged
const execFileAsync = promisify(execFile)
const CLAUDE_AGENTS_DIRECTORY = path.join(app.getPath('home'), '.claude', 'agents')
const SHARED_SKILLS_DIRECTORY = path.join(app.getPath('home'), '.agents', 'skills')
const GLOBAL_INSTRUCTIONS_FILE = path.join(app.getPath('home'), '.copilot', 'copilot-instructions.md')
const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', path.join('.github', 'copilot-instructions.md')]
const SKILL_DIRECTORIES = [SHARED_SKILLS_DIRECTORY]
const AGENT_MODEL_IDS = {
  haiku: 'claude-haiku-4.5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
}

delete process.env.MallocStackLogging
delete process.env.MallocStackLoggingNoCompact

if (isDev) app.commandLine.appendSwitch('remote-debugging-port', '9223')
if (app.isPackaged) {
  process.env.COPILOT_CLI_PATH = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@github',
    'copilot-sdk-darwin-arm64',
    'prebuilds',
    'darwin-arm64',
    'copilot-runtime',
  )
}

let mainWindow
let creatingWindow
let client
let startingClient
let currentLogin
let saveBoundsTimer
let reloadedAfterCrash = false
const activeSessions = new Map()
const pendingPermissions = new Map()

const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window.json')
const LOG_FILE = path.join(app.getPath('userData'), 'app.log')
const LOG_MAX_BYTES = 1024 * 1024
const ATTACHMENTS_DIRECTORY = path.join(app.getPath('userData'), 'attachments')
const PASTED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const IMAGE_MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
const ATTACHMENT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
const PREVIEWS_DIRECTORY = path.join(app.getPath('temp'), 'hc-copilot-previews')
const DEFAULT_BOUNDS = { width: 1360, height: 880 }
const MIN_WINDOW_WIDTH = 940
const MIN_WINDOW_HEIGHT = 650
// How long a tidy shutdown gets before the app stops waiting and quits anyway.
const QUIT_TIMEOUT_MS = 4000

function appendLog(message) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) writeFileSync(LOG_FILE, '', 'utf8')
    } catch {
      // No log file yet, nothing to truncate.
    }
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // Logging must never take the app down.
  }
}

process.on('uncaughtException', (error) => {
  appendLog(`uncaughtException: ${error?.stack || error?.message || String(error)}`)
})

process.on('unhandledRejection', (reason) => {
  appendLog(`unhandledRejection: ${reason?.stack || reason?.message || String(reason)}`)
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  appendLog('another instance already owns the lock, quitting this one')
  app.quit()
}

function parseAgentDefinition(content, fallbackName) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const metadata = Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => {
        const separator = line.indexOf(':')
        if (separator < 0) return null
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
      })
      .filter(Boolean),
  )

  const name = metadata.name || fallbackName
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    description: metadata.description,
    prompt: match[2].trim(),
    model: AGENT_MODEL_IDS[metadata.model] || metadata.model,
    infer: true,
  }
}

async function loadClaudeAgents() {
  try {
    const entries = await readdir(CLAUDE_AGENTS_DIRECTORY, { withFileTypes: true })
    const agents = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map(async (entry) => {
          const content = await readFile(path.join(CLAUDE_AGENTS_DIRECTORY, entry.name), 'utf8')
          return parseAgentDefinition(content, path.basename(entry.name, '.md'))
        }),
    )
    return agents.filter(Boolean)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function collectInstructionFiles(workingDirectory) {
  const files = []
  if (existsSync(GLOBAL_INSTRUCTIONS_FILE)) {
    files.push({ label: '~/.copilot/copilot-instructions.md', path: GLOBAL_INSTRUCTIONS_FILE })
  }
  if (workingDirectory && typeof workingDirectory === 'string') {
    for (const relative of PROJECT_INSTRUCTION_FILES) {
      const absolute = path.join(workingDirectory, relative)
      if (existsSync(absolute)) {
        files.push({ label: relative, path: absolute })
      }
    }
  }
  return files
}

async function sharedSessionConfig() {
  return {
    customAgents: await loadClaudeAgents(),
    skillDirectories: SKILL_DIRECTORIES,
  }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }
}

async function getGitHubToken() {
  const preferredLogin = 'hsuanchou-ingka'
  const candidates = [
    process.env.GH_PATH,
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    'gh',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue
    try {
      const { stdout } = await execFileAsync(
        candidate,
        ['auth', 'token', '--hostname', 'github.com', '--user', preferredLogin],
        { timeout: 10000 },
      )
      const token = stdout.trim()
      if (token) return { token, login: preferredLogin }
    } catch {
      // Try the next common GitHub CLI location.
    }
  }

  throw new Error('GitHub CLI is not logged in. Run gh auth login, then reopen HC Copilot.')
}

async function getClient() {
  if (client) return client
  if (!startingClient) {
    startingClient = (async () => {
      const { token: gitHubToken, login } = await getGitHubToken()
      currentLogin = login
      const nextClient = new CopilotClient({
        logLevel: 'error',
        gitHubToken,
        useLoggedInUser: false,
        enableRemoteSessions: true,
      })
      await nextClient.start()
      client = nextClient
      appendLog(`copilot client started for ${login}`)
      return nextClient
    })().catch((error) => {
      appendLog(`copilot client failed to start: ${error?.message || String(error)}`)
      throw error
    }).finally(() => {
      startingClient = undefined
    })
  }
  return startingClient
}

function requestPermission(request, invocation) {
  const sessionId = invocation?.sessionId || ''
  appendLog(`permission auto-approved for session, kind ${request?.kind || 'unknown'}, session ${sessionId}`)
  return Promise.resolve({ kind: 'approve-for-session' })
}

function rejectPendingPermissionsForSession(sessionId) {
  for (const [requestId, pending] of pendingPermissions) {
    if (pending.sessionId !== sessionId) continue
    pending.resolve({ kind: 'reject', feedback: 'Session deleted.' })
    pendingPermissions.delete(requestId)
  }
}

function rejectAllPendingPermissions(feedback) {
  if (!pendingPermissions.size) return
  appendLog(`rejecting ${pendingPermissions.size} pending permission request(s): ${feedback}`)
  for (const [requestId, pending] of pendingPermissions) {
    pending.resolve({ kind: 'reject', feedback })
    pendingPermissions.delete(requestId)
  }
}

function toSessionContext(context) {
  return {
    ...(context || {}),
    workingDirectory: context?.workingDirectory || '',
  }
}

function toSessionMetadata(session) {
  return {
    id: session.sessionId,
    title: session.summary || 'Untitled session',
    createdAt: session.startTime,
    updatedAt: session.modifiedTime,
    context: toSessionContext(session.context),
    remote: session.isRemote,
  }
}

async function refreshSessionMetadata(sessionId) {
  try {
    const copilot = await getClient()
    let metadata
    if (typeof copilot.getSessionMetadata === 'function') {
      metadata = await copilot.getSessionMetadata(sessionId)
    }
    if (!metadata) {
      const sessions = await copilot.listSessions()
      metadata = sessions.find((item) => item.sessionId === sessionId)
    }
    if (metadata) sendToRenderer('copilot:session-metadata', toSessionMetadata(metadata))
  } catch {
    // Metadata refresh is best effort and never blocks the session.
  }
}

function attachSession(session) {
  const existing = activeSessions.get(session.sessionId)
  // Same handle, already wired up.
  if (existing?.session === session) return session
  // A different handle for the same id means the runtime has just made this one authoritative
  // and stopped delivering events to the old one. Returning early here would leave us
  // subscribed to a handle that has gone quiet, so the old subscription is dropped instead.
  if (existing) existing.unsubscribe()

  const unsubscribe = session.on((event) => {
    sendToRenderer('copilot:event', {
      sessionId: session.sessionId,
      event,
    })
    if (event?.type === 'session.idle') {
      refreshSessionMetadata(session.sessionId)
    }
    if (event?.type === 'session.error') {
      appendLog(`session error ${session.sessionId}: ${event.data?.message || 'unknown error'}`)
    }
  })

  activeSessions.set(session.sessionId, { session, unsubscribe })
  return session
}

// Resuming a session more than once is not harmless: the runtime only delivers events to the
// most recently resumed handle, and every earlier one goes silent while still accepting sends.
// Selecting a chat fires several IPC calls at once, all of which need a session, so without a
// lock they each resume their own handle. The one we subscribed to is then usually not the one
// receiving events, and the chat looks frozen mid-turn: no reply, no tool activity, and a
// spinner that never stops because the event that ends the turn is delivered to a handle nobody
// is listening to. So a resume already in flight is shared rather than repeated.
const resumingSessions = new Map()

async function resumeSession(sessionId) {
  const active = activeSessions.get(sessionId)
  if (active) return active.session

  const pending = resumingSessions.get(sessionId)
  if (pending) return pending

  const attempt = (async () => {
    const copilot = await getClient()
    const session = await copilot.resumeSession(sessionId, {
      ...await sharedSessionConfig(),
      streaming: true,
      onPermissionRequest: requestPermission,
    })
    return attachSession(session)
  })().finally(() => {
    resumingSessions.delete(sessionId)
  })

  resumingSessions.set(sessionId, attempt)
  return attempt
}

async function getQuota(copilot) {
  try {
    const result = await copilot.rpc.account.getQuota({})
    return result.quotaSnapshots
  } catch (error) {
    return { error: serializeError(error) }
  }
}

ipcMain.handle('copilot:initialize', async () => {
  try {
    const copilot = await getClient()
    const [auth, models, sessions, quota, skills, mcp, customAgents] = await Promise.all([
      copilot.getAuthStatus(),
      copilot.listModels(),
      copilot.listSessions(),
      getQuota(copilot),
      copilot.rpc.skills.discover({ skillDirectories: SKILL_DIRECTORIES }),
      copilot.rpc.mcp.discover({ workingDirectory: app.getPath('home') }),
      loadClaudeAgents(),
    ])
    return {
      ok: true,
      auth: { ...auth, login: currentLogin },
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        billing: model.billing || null,
        supportedReasoningEfforts: model.supportedReasoningEfforts || [],
      })),
      sessions: sessions.map(toSessionMetadata),
      quota,
      capabilities: {
        knowledge: collectInstructionFiles().map((file) => file.label),
        skills: (skills.skills || []).map((skill) => skill.name).filter(Boolean).sort(),
        agents: customAgents.map((agent) => agent.displayName),
        mcp: mcp.servers?.map((server) => server.name) || [],
        warnings: skills.errors?.length || 0,
      },
    }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:instruction-files', async (_event, workingDirectory) => {
  try {
    return { ok: true, files: collectInstructionFiles(workingDirectory) }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

// Detached shells write three sibling files into the temp dir: a .log of their output,
// a .pid, and a .exit that only appears once the command is over. The .exit file is the
// only trustworthy "is it done" signal, so we check for it before parsing anything.
const DETACHED_PREFIX = 'copilot-detached-'

// tqdm renders "83%|####  | 25/30 [03:36<00:44,  5.9s/it]", which carries both the
// percentage and the estimated time left. Progress bars repaint with carriage returns,
// so the tail has to be split on \r as well as \n.
const TQDM_RE = /(\d{1,3})%\|[^|]*\|\s*(\d+)\/(\d+)\s*\[([\d:]+)<([\d:]+)/
// Rich (PyTorch Lightning) renders "Epoch 39/39 ---- 40/40 0:01:07 • 0:00:00", where the
// value after the bullet is the time remaining.
const RICH_RE = /(?:epoch|step)\s+(\d+)\/(\d+).*?\s(\d+:\d{2}(?::\d{2})?)\s*•\s*(\d+:\d{2}(?::\d{2})?)/i
const FRACTION_RE = /(?:epoch|step|iter|iteration)\s*[:\s]?\s*(\d+)\s*\/\s*(\d+)/i
const PERCENT_RE = /(\d{1,3}(?:\.\d+)?)\s*%/

function parseProgress(tail) {
  const lines = tail.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]

    const tqdm = line.match(TQDM_RE)
    if (tqdm) {
      return { percent: Number(tqdm[1]), done: Number(tqdm[2]), total: Number(tqdm[3]), eta: tqdm[5], line }
    }

    const rich = line.match(RICH_RE)
    if (rich) {
      const done = Number(rich[1])
      const total = Number(rich[2])
      if (total > 0 && done <= total) {
        return { percent: Math.round((done / total) * 100), done, total, eta: rich[4], line }
      }
    }

    const fraction = line.match(FRACTION_RE)
    if (fraction) {
      const done = Number(fraction[1])
      const total = Number(fraction[2])
      if (total > 0 && done <= total) {
        return { percent: Math.round((done / total) * 100), done, total, eta: '', line }
      }
    }

    const percent = line.match(PERCENT_RE)
    if (percent) {
      const value = Number(percent[1])
      if (value >= 0 && value <= 100) return { percent: Math.round(value), eta: '', line }
    }
  }
  return { percent: null, eta: '', line: lines[lines.length - 1] || '' }
}

// The listing is passed in rather than read here. Polling happens every few seconds for every
// running command at once, and the shared temp directory holds hundreds of unrelated files, so
// reading it once per command turned a routine poll into two dozen full directory scans.
async function probeDetachedShell(shellId, entries) {
  const directory = app.getPath('temp')

  // Names look like copilot-detached-<shellId>-<epochMs>-<uuid>.log. Matching on the plain
  // prefix would let "training" swallow "training-resume", so the timestamp anchors the id.
  const escaped = shellId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const namePattern = new RegExp(`^${DETACHED_PREFIX}${escaped}-\\d{10,}-[^-]`)
  const logs = entries.filter((name) => name.endsWith('.log') && namePattern.test(name))
  // No log at all means the temp files were already cleaned up, so the command is long gone.
  // Callers use this to clear ghosts left behind when a completion notice was never recorded.
  if (!logs.length) return { shellId, missing: true, finished: true, percent: null, eta: '' }

  let newest = null
  for (const name of logs) {
    const full = path.join(directory, name)
    try {
      const stats = statSync(full)
      if (!newest || stats.mtimeMs > newest.mtimeMs) newest = { full, name, mtimeMs: stats.mtimeMs }
    } catch { /* the file may vanish between listing and stat */ }
  }
  if (!newest) return null

  const finished = existsSync(newest.full.replace(/\.log$/, '.exit'))

  let tail = ''
  try {
    const handle = await open(newest.full, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, 16 * 1024)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      tail = buffer.toString('utf8')
      // Reading a fixed number of bytes from the end can land mid-character, which decodes to a
      // replacement character. Everything before the first newline is a partial line anyway, so
      // dropping it removes the damage and costs nothing.
      if (length < size) {
        const firstBreak = tail.indexOf('\n')
        tail = firstBreak === -1 ? '' : tail.slice(firstBreak + 1)
      }
    } finally {
      await handle.close()
    }
  } catch {
    return { shellId, finished, percent: null, eta: '', line: '' }
  }

  const progress = parseProgress(tail)
  return { shellId, finished, updatedAt: newest.mtimeMs, ...progress }
}

ipcMain.handle('copilot:probe-background', async (_event, shellIds) => {
  try {
    const list = Array.isArray(shellIds) ? shellIds.filter(Boolean).slice(0, 24) : []
    if (!list.length) return { ok: true, report: {} }

    let entries = []
    try {
      entries = await readdir(app.getPath('temp'))
    } catch {
      return { ok: true, report: {} }
    }

    const probes = await Promise.all(list.map((id) => probeDetachedShell(id, entries).catch(() => null)))
    const report = {}
    probes.forEach((probe, index) => {
      if (probe) report[list[index]] = probe
    })
    return { ok: true, report }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:refresh-quota', async () => {
  try {
    const copilot = await getClient()
    return { ok: true, quota: await getQuota(copilot) }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:create-session', async (_event, options = {}) => {
  try {
    let workingDirectory = typeof options.workingDirectory === 'string' ? options.workingDirectory : ''
    if (options.chooseFolder) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose a working folder',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
      workingDirectory = result.filePaths[0]
    }
    if (!workingDirectory || !existsSync(workingDirectory)) {
      workingDirectory = app.getPath('home')
    }

    const copilot = await getClient()
    const sessionId = randomUUID()
    const session = await copilot.createSession({
      ...await sharedSessionConfig(),
      sessionId,
      model: options.model || 'auto',
      reasoningEffort: options.reasoningEffort,
      workingDirectory,
      streaming: true,
      enableSessionStore: true,
      onPermissionRequest: requestPermission,
    })
    attachSession(session)
    return {
      ok: true,
      session: {
        id: session.sessionId,
        title: 'New session',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        context: { workingDirectory },
        remote: false,
      },
    }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:fork-session', async (_event, { sessionId, name }) => {
  try {
    const copilot = await getClient()
    const sessions = await copilot.listSessions()
    const source = sessions.find((item) => item.sessionId === sessionId)
    if (!source) return { ok: false, error: { message: 'The source session could not be found.' } }

    const forkName = typeof name === 'string' && name.trim()
      ? name.trim()
      : `${source.summary || 'Untitled session'} copy`
    const fork = await copilot.rpc.sessions.fork({ sessionId, name: forkName })
    const now = new Date().toISOString()

    return {
      ok: true,
      session: {
        id: fork.sessionId,
        title: fork.name || forkName,
        createdAt: now,
        updatedAt: now,
        context: toSessionContext(source.context),
        remote: false,
      },
    }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:open-session', async (_event, sessionId) => {
  try {
    const session = await resumeSession(sessionId)
    const events = await session.getEvents()
    const currentModel = await session.rpc.model.getCurrent()
    return { ok: true, events, currentModel }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:send-message', async (_event, { sessionId, prompt, attachments }) => {
  try {
    const session = await resumeSession(sessionId)
    const safeAttachments = Array.isArray(attachments)
      ? attachments
        .filter((item) => item && item.type === 'file' && typeof item.path === 'string')
        .map((item) => ({
          type: 'file',
          path: item.path,
          ...(item.displayName ? { displayName: item.displayName } : {}),
        }))
      : []
    const messageId = await session.send({
      prompt,
      ...(safeAttachments.length ? { attachments: safeAttachments } : {}),
    })
    return { ok: true, messageId }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:read-todos', async (_event, sessionId) => {
  try {
    const session = await resumeSession(sessionId)
    // The plain read, not the one that also returns dependency edges. The panel answers
    // "how many are left and which one is live", and a dependency graph does not help with that.
    const result = await session.rpc.plan.readSqlTodos()
    // Every column is best effort, so anything without a title is not worth a row.
    const todos = (result?.rows || [])
      .filter((row) => row?.title)
      .map((row) => ({
        id: row.id || row.title,
        title: row.title,
        status: (row.status || 'pending').toLowerCase(),
      }))
    return { ok: true, todos }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

// The runtime keeps its own registry of background agents with a real status field, so ask it
// rather than inferring liveness from the event log. Event history cannot tell a finished
// agent from one whose completion notice was never written.
//
// Agents only. The registry also lists shell tasks, but those are already tracked from the
// event log, where each one carries the shell id that the log probe needs to report progress.
// Taking them from here as well would list every background command twice and strip the copy
// that can show a percentage.
ipcMain.handle('copilot:list-tasks', async (_event, sessionId) => {
  try {
    const session = await resumeSession(sessionId)
    const list = await session.rpc.tasks.list()
    const running = (list.tasks || []).filter((task) => task.type === 'agent' && task.status === 'running')
    const tasks = await Promise.all(running.map(async (task) => {
      let intent = ''
      try {
        // Agent progress reports no percentage, so the honest answer to "how is it going" is
        // what it is doing right now. latestIntent is only set for some agent types, and
        // recentActivity is always present, so its last line is the fallback.
        const result = await session.rpc.tasks.getProgress({ taskId: task.id })
        const progress = result?.progress || {}
        const activity = progress.recentActivity || []
        const latest = activity[activity.length - 1]
        intent = progress.latestIntent || latest?.message || ''
      } catch {
        // Progress is best effort. A task can finish between the list and this call.
      }
      return {
        id: task.id,
        type: task.type,
        name: task.displayName || task.description || 'Background agent',
        intent,
        startedAt: Date.parse(task.startedAt) || Date.now(),
      }
    }))
    return { ok: true, tasks }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

// Slash commands come straight from the runtime, so the palette lists exactly what this
// session can run: built-ins plus every discovered skill.
ipcMain.handle('copilot:list-commands', async (_event, sessionId) => {
  try {
    const session = await resumeSession(sessionId)
    const list = await session.rpc.commands.list({
      includeBuiltins: true,
      includeSkills: true,
      includeClientCommands: true,
    })
    return {
      ok: true,
      commands: (list.commands || []).map((command) => ({
        name: command.name,
        kind: command.kind,
        description: command.description || '',
        aliases: command.aliases || [],
        hint: command.input?.hint || '',
        requiresInput: Boolean(command.input?.required),
        allowDuringAgentExecution: Boolean(command.allowDuringAgentExecution),
      })),
    }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

// Invoking returns one of several shapes. Only two matter to this UI: text to print, or a
// prompt to hand to the agent. Everything else is reported as handled with no output.
ipcMain.handle('copilot:invoke-command', async (_event, { sessionId, name, input }) => {
  try {
    const session = await resumeSession(sessionId)
    const result = await session.rpc.commands.invoke({ name, input: input || '' })
    if (result?.kind === 'text') {
      return { ok: true, outcome: 'text', text: result.text || '' }
    }
    if (result?.kind === 'agent-prompt') {
      const messageId = await session.send({ prompt: result.prompt })
      return {
        ok: true,
        outcome: 'prompt',
        messageId,
        displayPrompt: result.displayPrompt || '',
        notice: result.notice || '',
      }
    }
    if (result?.kind === 'set-model') {
      return { ok: true, outcome: 'text', text: `Model set to ${result.model}.` }
    }
    if (result?.kind === 'select-subcommand') {
      const options = (result.options || []).map((option) => `/${result.command} ${option.name || option}`)
      return {
        ok: true,
        outcome: 'text',
        text: `${result.title || 'Pick one'}\n\n${options.join('\n')}`,
      }
    }
    return { ok: true, outcome: 'done' }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:abort-session', async (_event, sessionId) => {  try {
    const active = activeSessions.get(sessionId)
    if (!active) return { ok: false, error: { message: 'Session is not running.' } }
    await active.session.abort()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:pick-attachments', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true }
    return {
      ok: true,
      attachments: result.filePaths.map((filePath) => ({
        type: 'file',
        path: filePath,
        displayName: path.basename(filePath),
      })),
    }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:save-pasted-image', async (_event, payload = {}) => {
  try {
    const data = payload?.data
    if (!data) return { ok: false, error: { message: 'The clipboard did not contain an image.' } }
    const buffer = Buffer.from(data)
    if (!buffer.length) return { ok: false, error: { message: 'The pasted image was empty.' } }

    const requested = String(payload.extension || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')
    const extension = PASTED_IMAGE_EXTENSIONS.has(requested) ? requested : 'png'
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = path.join(ATTACHMENTS_DIRECTORY, `pasted-${timestamp}.${extension}`)

    await mkdir(ATTACHMENTS_DIRECTORY, { recursive: true })
    await writeFile(filePath, buffer)
    return {
      ok: true,
      attachment: {
        type: 'file',
        path: filePath,
        displayName: path.basename(filePath),
      },
    }
  } catch (error) {
    appendLog(`could not save a pasted image: ${error?.message || String(error)}`)
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:read-attachment-preview', async (_event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath) {
      return { ok: false, error: { message: 'No attachment path was provided.' } }
    }
    const extension = path.extname(filePath).slice(1).toLowerCase()
    const mimeType = IMAGE_MIME_TYPES[extension]
    if (!mimeType) return { ok: false, error: { message: 'That attachment is not a previewable image.' } }
    const stats = statSync(filePath)
    if (stats.size > ATTACHMENT_PREVIEW_MAX_BYTES) {
      return { ok: false, error: { message: 'That image is too large to preview.' } }
    }
    const buffer = await readFile(filePath)
    return { ok: true, dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:set-model', async (_event, { sessionId, model }) => {  try {
    const session = await resumeSession(sessionId)
    await session.setModel(model)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('copilot:delete-session', async (_event, sessionId) => {
  try {
    const active = activeSessions.get(sessionId)
    if (active) {
      // Drop it from the map before tearing it down. A disconnect that throws used to leave an
      // unsubscribed entry behind, which both stopped forwarding events and made the map claim
      // the session was still live, so the delete could never succeed on a retry either.
      activeSessions.delete(sessionId)
      active.unsubscribe()
      await active.session.disconnect().catch((error) => {
        appendLog(`disconnect failed while deleting ${sessionId}: ${error?.message || String(error)}`)
      })
    }
    rejectPendingPermissionsForSession(sessionId)
    const copilot = await getClient()
    await copilot.deleteSession(sessionId)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('app:open-external', async (_event, url) => {
  try {
    if (typeof url !== 'string') return { ok: false }
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false }
    await shell.openExternal(parsed.toString())
    return { ok: true }
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('preview:open-in-browser', async (_event, html) => {
  try {
    if (typeof html !== 'string' || !html.trim()) {
      return { ok: false, error: { message: 'There is nothing to preview.' } }
    }
    await mkdir(PREVIEWS_DIRECTORY, { recursive: true })
    const filePath = path.join(PREVIEWS_DIRECTORY, `preview-${randomUUID()}.html`)
    await writeFile(filePath, html, 'utf8')
    const error = await shell.openPath(filePath)
    if (error) return { ok: false, error: { message: error } }
    return { ok: true, path: filePath }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('preview:save-html', async (_event, { html, suggestedName } = {}) => {
  try {
    if (typeof html !== 'string' || !html.trim()) {
      return { ok: false, error: { message: 'There is nothing to save.' } }
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save preview',
      defaultPath: suggestedName || 'preview.html',
      filters: [{ name: 'HTML', extensions: ['html'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    await writeFile(result.filePath, html, 'utf8')
    return { ok: true, path: result.filePath }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('app:open-path', async (_event, targetPath) => {
  try {
    if (typeof targetPath !== 'string' || !targetPath.startsWith('/')) return { ok: false }
    const error = await shell.openPath(targetPath)
    if (error) return { ok: false, error: { message: error } }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.handle('app:reveal-path', async (_event, targetPath) => {
  try {
    if (typeof targetPath !== 'string' || !targetPath.startsWith('/')) return { ok: false }
    shell.showItemInFolder(targetPath)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: serializeError(error) }
  }
})

ipcMain.on('copilot:permission-answer', (_event, { requestId, approved, forSession }) => {
  const pending = pendingPermissions.get(requestId)
  if (!pending) return
  pendingPermissions.delete(requestId)
  if (!approved) {
    pending.resolve({ kind: 'reject', feedback: 'User rejected this action.' })
    return
  }
  pending.resolve(forSession
    ? { kind: 'approve-for-session' }
    : { kind: 'approve-once', approvedInteractively: true })
})

async function loadWindowBounds() {
  try {
    const raw = await readFile(WINDOW_STATE_FILE, 'utf8')
    const saved = JSON.parse(raw)
    const { x, y, width, height } = saved || {}
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null
    if (width < MIN_WINDOW_WIDTH || height < MIN_WINDOW_HEIGHT) return null
    if (width > 12000 || height > 12000) return null

    const bounds = { width: Math.round(width), height: Math.round(height) }
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const visible = screen.getAllDisplays().some((display) => {
        const area = display.workArea
        return (
          x + width > area.x + 60
          && x < area.x + area.width - 60
          && y + height > area.y
          && y < area.y + area.height - 40
        )
      })
      if (visible) {
        bounds.x = Math.round(x)
        bounds.y = Math.round(y)
      }
    }
    return bounds
  } catch {
    return null
  }
}

function currentWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  return mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds()
}

async function saveWindowBounds() {
  const bounds = currentWindowBounds()
  if (!bounds) return
  try {
    await writeFile(WINDOW_STATE_FILE, JSON.stringify(bounds), 'utf8')
  } catch {
    // Window geometry is a convenience, never a failure path.
  }
}

function saveWindowBoundsSync() {
  const bounds = currentWindowBounds()
  if (!bounds) return
  try {
    writeFileSync(WINDOW_STATE_FILE, JSON.stringify(bounds), 'utf8')
  } catch {
    // Window geometry is a convenience, never a failure path.
  }
}

function queueSaveWindowBounds() {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer)
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = undefined
    saveWindowBounds()
  }, 500)
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return true
}

async function createWindow() {
  if (focusMainWindow()) return mainWindow
  if (creatingWindow) return creatingWindow
  creatingWindow = buildWindow().finally(() => {
    creatingWindow = undefined
  })
  return creatingWindow
}

async function buildWindow() {
  nativeTheme.themeSource = 'light'
  const restored = await loadWindowBounds()
  mainWindow = new BrowserWindow({
    ...DEFAULT_BOUNDS,
    ...(restored || {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#f8f7f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendLog(`render process gone: ${details?.reason || 'unknown'} (exit ${details?.exitCode ?? 'n/a'})`)
    rejectAllPendingPermissions('The window reloaded before anyone could answer.')
    if (reloadedAfterCrash) {
      appendLog('render process crashed again, leaving the window as is')
      return
    }
    reloadedAfterCrash = true
    if (mainWindow && !mainWindow.isDestroyed()) {
      appendLog('reloading the window once after the crash')
      mainWindow.reload()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = undefined
    rejectAllPendingPermissions('The window closed before anyone could answer.')
  })

  mainWindow.on('resize', queueSaveWindowBounds)
  mainWindow.on('move', queueSaveWindowBounds)
  mainWindow.on('close', () => {
    if (saveBoundsTimer) {
      clearTimeout(saveBoundsTimer)
      saveBoundsTimer = undefined
    }
    saveWindowBoundsSync()
  })

  if (isDev) {
    await mainWindow.loadURL('http://127.0.0.1:5173')
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  return mainWindow
}

function createMenu() {
  const template = [
    {
      label: 'HC Copilot',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Task',
          accelerator: 'CommandOrControl+N',
          click: () => sendToRenderer('app:command', 'new-session'),
        },
        {
          label: 'New Task in Another Folder',
          accelerator: 'CommandOrControl+Shift+N',
          click: () => sendToRenderer('app:command', 'new-session-folder'),
        },
        {
          label: 'Search Sessions',
          accelerator: 'CommandOrControl+K',
          click: () => sendToRenderer('app:command', 'focus-search'),
        },
        {
          label: 'Go to My Last Message',
          accelerator: 'CommandOrControl+J',
          click: () => sendToRenderer('app:command', 'jump-to-my-turn'),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!focusMainWindow()) {
      createWindow().catch((e) => appendLog(`second instance could not open a window: ${e?.message || String(e)}`))
    }
  })

  app.whenReady().then(() => {
    appendLog('app ready')
    createMenu()
    createWindow().catch((e) => {
      appendLog(`could not create the window: ${e?.message || String(e)}`)
      dialog.showErrorBox('HC Copilot', e?.message || String(e))
    })
  })
}

app.on('activate', () => {
  if (creatingWindow) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow()
    return
  }
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((e) => appendLog(`activate could not open a window: ${e?.message || String(e)}`))
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  if (saveBoundsTimer) {
    clearTimeout(saveBoundsTimer)
    saveBoundsTimer = undefined
  }
  saveWindowBoundsSync()
  if (!client) return
  event.preventDefault()
  const currentClient = client
  client = undefined

  // Quitting must not depend on the runtime answering. Sessions were being disconnected one
  // after another with nothing to stop a single hung one from holding the whole app open, so
  // Cmd+Q looked like it had been ignored. Shutdown is tidy when it can be and prompt regardless.
  const forceExit = setTimeout(() => {
    appendLog('shutdown took too long, quitting anyway')
    app.exit(0)
  }, QUIT_TIMEOUT_MS)
  forceExit.unref?.()

  const sessions = [...activeSessions.values()]
  activeSessions.clear()
  await Promise.all(sessions.map(({ session, unsubscribe }) => {
    unsubscribe()
    return session.disconnect().catch(() => {})
  }))
  await currentClient.stop().catch((e) => appendLog(`copilot client stop failed: ${e?.message || String(e)}`))
  clearTimeout(forceExit)
  appendLog('copilot client stopped, quitting')
  app.exit(0)
})
