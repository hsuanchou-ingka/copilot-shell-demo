import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  ArrowDown,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Folder,
  FolderPlus,
  GitFork,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Pin,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Smartphone,
  Sparkles,
  Square,
  Tablet,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react'
import './App.css'

const EMPTY_SESSION_STATE = {
  working: false,
  liveText: '',
  toolActivity: [],
  backgroundAgents: [],
  pendingTools: {},
}
const EMPTY_QUEUE = []
const EMPTY_EDITS = Object.freeze({ hidden: [], manual: [], labels: {} })
const PROJECT_PREVIEW_COUNT = 8
const ERROR_DISMISS_MS = 8000

const ALIASES_KEY = 'copilot-workbench-aliases'
const PINS_KEY = 'copilot-workbench-pins'
const PINNED_SESSIONS_KEY = 'copilot-workbench-pinned-sessions'
const SELECTED_PROJECT_KEY = 'copilot-workbench-selected-project'
const SELECTED_SESSION_KEY = 'copilot-workbench-selected-session'
const SIDEBAR_WIDTH_KEY = 'copilot-workbench-sidebar-width'
const PROJECTS_HEIGHT_KEY = 'copilot-workbench-projects-height'
const PROJECTS_COLLAPSED_KEY = 'copilot-workbench-projects-collapsed'
const ARTIFACT_WIDTH_KEY = 'copilot-workbench-artifact-width'

const ARTIFACT_MIN_WIDTH = 320
const ARTIFACT_MAX_WIDTH = 1100
const ARTIFACT_DEFAULT_WIDTH = 520
const RESOURCES_KEY = 'copilot-workbench-resources'

const SIDEBAR_MIN_WIDTH = 240
const SIDEBAR_MAX_WIDTH = 520
const SIDEBAR_DEFAULT_WIDTH = 310
const PROJECTS_MIN_HEIGHT = 120
const PROJECTS_DEFAULT_HEIGHT = 330
const PROJECTS_MAX_HEIGHT_RATIO = 0.6
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function maxProjectsHeight() {
  return Math.max(PROJECTS_MIN_HEIGHT, Math.round(window.innerHeight * PROJECTS_MAX_HEIGHT_RATIO))
}

function maxArtifactWidth() {
  return clamp(Math.round(window.innerWidth - 640), ARTIFACT_MIN_WIDTH, ARTIFACT_MAX_WIDTH)
}

function isImageName(value) {
  const extension = String(value || '').split('.').pop().toLowerCase()
  return IMAGE_EXTENSIONS.includes(extension)
}

function readImageThumbnail(file) {
  return new Promise((resolve) => {
    if (!file || !String(file.type || '').startsWith('image/')) {
      resolve(null)
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

function loadValue(key, fallback) {
  try {
    const value = window.localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function saveValue(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value))
}

function workingDirectoryOf(session) {
  return session?.context?.workingDirectory || ''
}

function projectKeyOf(session) {
  return workingDirectoryOf(session)
}

function isFolderKey(key) {
  return typeof key === 'string' && key.startsWith('/')
}

function folderLabel(directory) {
  if (!directory) return ''
  return directory.split('/').filter(Boolean).at(-1) || directory
}

function projectName(session) {
  const directory = workingDirectoryOf(session)
  if (!directory) return session?.remote ? 'Cloud session' : 'General'
  return folderLabel(directory)
}

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`*]+/g
const PATH_PATTERN = /(?:^|[\s(`'"])(\/(?:Users|Volumes|opt|srv|Applications)\/[^\s`'")\]*]+)/g
const FILE_EXTENSION_PATTERN = /\.([a-z0-9]{1,6})$/i
const KNOWN_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'sh', 'zsh', 'yml', 'yaml',
  'md', 'mdx', 'txt', 'pdf', 'csv', 'xlsx', 'docx', 'pptx', 'key',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'icns', 'ico', 'mp3', 'mp4', 'm4a',
  'wav', 'mov', 'zip', 'dmg', 'log', 'env', 'lock', 'toml', 'sql', 'db',
])
const NOTION_HASH_PATTERN = /-?[0-9a-f]{32}$/i
// URLs pasted mid-sentence pick up trailing punctuation, in either script.
const TRAILING_NOISE_PATTERN = /[.,;:!?)\]}'"`*。，、；：！？）】」』…]+$/
const CJK_PATTERN = /[^\u0020-\u007e]/
const NOISE_HOSTS = [
  'stackoverflow.com',
  'developer.mozilla.org',
  'npmjs.com',
  'google.com',
  'wikipedia.org',
]

function trimTrailingPunctuation(value) {
  let result = value
  let previous
  do {
    previous = result
    result = result.replace(TRAILING_NOISE_PATTERN, '')
  } while (result !== previous)
  return result
}

function decodeSlug(slug) {
  try {
    return decodeURIComponent(slug)
  } catch {
    return slug
  }
}

// A path or URL that runs straight into CJK text was never really part of it.
function cutAtNonAscii(value) {
  const match = CJK_PATTERN.exec(value)
  return match ? value.slice(0, match.index) : value
}

function cleanReference(value) {
  return trimTrailingPunctuation(cutAtNonAscii(decodeSlug(value)))
}

// Notion puts the page title in the URL slug, so a readable label needs no network call.
function notionLabel(url) {
  const slug = url.pathname.split('/').filter(Boolean).at(-1) || ''
  const title = decodeSlug(slug).replace(NOTION_HASH_PATTERN, '').replace(/-/g, ' ').trim()
  return title || 'Notion page'
}

function githubLabel(url) {
  const parts = url.pathname.split('/').filter(Boolean)
  if (!parts.length) return { label: 'GitHub', source: 'GitHub' }
  if (parts.length === 1) return { label: parts[0], source: 'GitHub profile' }
  const repo = parts[1]
  if (parts[2] === 'pull' && parts[3]) return { label: `${repo} #${parts[3]}`, source: 'Pull request' }
  if (parts[2] === 'issues' && parts[3]) return { label: `${repo} #${parts[3]}`, source: 'Issue' }
  if (parts[2] === 'blob' && parts.length > 4) {
    return { label: `${repo}/${parts.at(-1)}`, source: 'GitHub file' }
  }
  return { label: repo, source: 'Repository' }
}

function figmaLabel(url) {
  const name = url.pathname.split('/').filter(Boolean).at(-1) || ''
  return decodeSlug(name).replace(/-/g, ' ').trim() || 'Figma file'
}

function classifyLink(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  if (NOISE_HOSTS.some((noise) => host === noise || host.endsWith(`.${noise}`))) return null
  if (host.endsWith('notion.so') || host.endsWith('notion.site')) {
    return { kind: 'notion', label: notionLabel(url), source: 'Notion' }
  }
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return { kind: 'github', ...githubLabel(url) }
  }
  if (host.endsWith('figma.com')) {
    return { kind: 'figma', label: figmaLabel(url), source: 'Figma' }
  }
  return { kind: 'link', label: host, source: host }
}

function classifyPath(rawPath) {
  const name = folderLabel(rawPath)
  if (!name) return null
  const extension = FILE_EXTENSION_PATTERN.exec(name)?.[1]?.toLowerCase()
  const isFile = Boolean(extension && KNOWN_EXTENSIONS.has(extension))
  return {
    kind: isFile ? 'file' : 'folder',
    label: name,
    source: isFile ? 'File' : 'Folder',
  }
}

function parentOf(rawPath) {
  const parts = rawPath.split('/').filter(Boolean)
  if (parts.length < 2) return ''
  return `/${parts.slice(0, -1).join('/')}`
}

// One folder that holds several files reads better than a list of siblings.
function groupByFolder(items, workingDirectory) {
  const byParent = new Map()
  items.forEach((item) => {
    if (item.manual || item.root || (item.kind !== 'file' && item.kind !== 'folder')) return
    const parent = parentOf(item.value)
    if (!parent || parent === workingDirectory) return
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent).push(item)
  })

  const absorbed = new Set()
  const groups = []
  byParent.forEach((siblings, parent) => {
    if (siblings.length < 2) return
    siblings.forEach((item) => absorbed.add(item.value))
    groups.push({
      id: parent,
      value: parent,
      kind: 'folder',
      label: folderLabel(parent),
      source: `Folder · ${siblings.length} items`,
      count: siblings.reduce((total, item) => total + item.count, 0),
      order: Math.max(...siblings.map((item) => item.order)),
      children: siblings,
    })
  })

  if (!groups.length) return items
  const kept = items.filter((item) => !absorbed.has(item.value))
  const existing = new Set(kept.map((item) => item.value))
  return [...kept, ...groups.filter((group) => !existing.has(group.value))]
}

const KIND_ORDER = ['folder', 'github', 'notion', 'figma', 'file', 'link']

function kindLabel(kind) {
  if (kind === 'github') return 'GitHub'
  if (kind === 'notion') return 'Notion'
  if (kind === 'figma') return 'Figma'
  if (kind === 'file') return 'File'
  if (kind === 'folder') return 'Folder'
  return 'Link'
}

// Within a kind, the canonical target beats a deep link into it.
function specificityPenalty(item) {
  if (item.kind === 'github') {
    if (item.source === 'Repository') return 0
    if (item.source === 'GitHub profile') return 2
    return 1
  }
  if (item.kind === 'folder') return item.root ? 0 : 1
  return 0
}

// One link per kind is the point: this is a way back to the thing, not an index.
function pickPrimary(items) {
  const byKind = new Map()
  items.forEach((item) => {
    const bucket = byKind.get(item.kind)
    if (bucket) bucket.push(item)
    else byKind.set(item.kind, [item])
  })

  return KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => {
    const bucket = byKind.get(kind).slice().sort((a, b) => {
      const manual = Number(Boolean(b.manual)) - Number(Boolean(a.manual))
      if (manual) return manual
      const specificity = specificityPenalty(a) - specificityPenalty(b)
      if (specificity) return specificity
      if (b.count !== a.count) return b.count - a.count
      return b.order - a.order
    })
    const [primary, ...alternates] = bucket
    return { ...primary, alternates }
  })
}

// Resources are read back out of the transcript, so nothing extra has to be stored per turn.
function collectResources(messages, workingDirectory) {
  const found = new Map()
  const remember = (value, detail, order) => {
    if (!detail) return
    const existing = found.get(value)
    if (existing) {
      existing.count += 1
      existing.order = order
      return
    }
    found.set(value, { id: value, value, ...detail, count: 1, order })
  }

  messages.forEach((message, index) => {
    const content = typeof message.content === 'string' ? message.content : ''
    if (!content) return
    const urls = content.match(URL_PATTERN) || []
    urls.forEach((raw) => {
      const value = cleanReference(raw)
      remember(value, classifyLink(value), index)
    })
    for (const match of content.matchAll(PATH_PATTERN)) {
      const value = cleanReference(match[1])
      if (!value || value === workingDirectory) continue
      remember(value, classifyPath(value), index)
    }
  })

  const list = groupByFolder([...found.values()], workingDirectory).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return b.order - a.order
  })

  if (workingDirectory) {
    list.unshift({
      id: workingDirectory,
      value: workingDirectory,
      kind: 'folder',
      label: folderLabel(workingDirectory),
      source: 'Working folder',
      count: 1,
      order: Infinity,
      root: true,
    })
  }
  return list
}

const SHELL_STARTED_RE = /<command started in (?:detached )?background with shellId: ([^>]+)>/g
const SHELL_RUNNING_RE = /<command with shellId: (.+?) is still running/g
const SHELL_DONE_RE = /<shellId: (.+?) completed with exit code/g
const NOTIFY_DONE_RE = /\(shellId: ([^)]+)\)\s+has completed/g

function matchAll(text, regex) {
  const found = []
  regex.lastIndex = 0
  let match = regex.exec(text)
  while (match) {
    found.push(match[1].trim())
    match = regex.exec(text)
  }
  return found
}

function resultText(data) {
  const result = data?.result
  if (!result) return ''
  if (typeof result === 'string') return result
  return `${result.content || ''}\n${result.detailedContent || ''}`
}

function eventTime(event) {
  const parsed = Date.parse(event?.timestamp || '')
  return Number.isNaN(parsed) ? Date.now() : parsed
}

// Folds one event into the background activity state. Shared by the live stream and
// by history replay, so reopening a session rebuilds work that is still running.
function foldBackgroundActivity(state, event) {
  const type = event?.type
  const data = event?.data || {}
  const drop = (id) => state.backgroundAgents.filter((item) => item.id !== id)

  if (type === 'tool.execution_start') {
    const args = data.arguments || {}
    return {
      ...state,
      pendingTools: {
        ...state.pendingTools,
        [data.toolCallId]: {
          toolName: data.toolName,
          shellId: args.shellId,
          label: args.description || args.command || 'Background command',
          startedAt: eventTime(event),
        },
      },
    }
  }

  if (type === 'tool.execution_complete') {
    const pending = state.pendingTools[data.toolCallId]
    const rest = { ...state.pendingTools }
    delete rest[data.toolCallId]
    const text = resultText(data)
    let agents = state.backgroundAgents

    if (pending?.toolName === 'stop_bash' && pending.shellId) {
      agents = agents.filter((item) => item.id !== `shell:${pending.shellId}`)
    }
    for (const shellId of matchAll(text, SHELL_DONE_RE)) {
      agents = agents.filter((item) => item.id !== `shell:${shellId}`)
    }
    const running = [...matchAll(text, SHELL_STARTED_RE), ...matchAll(text, SHELL_RUNNING_RE)]
    for (const shellId of running) {
      const id = `shell:${shellId}`
      if (agents.some((item) => item.id === id)) continue
      agents = [...agents, {
        id,
        kind: 'shell',
        name: pending?.label || `Shell ${shellId}`,
        detail: shellId,
        startedAt: pending?.startedAt || eventTime(event),
      }]
    }
    return { ...state, pendingTools: rest, backgroundAgents: agents }
  }

  if (type === 'system.notification') {
    const text = String(data.content || '')
    let agents = state.backgroundAgents
    for (const shellId of matchAll(text, NOTIFY_DONE_RE)) {
      agents = agents.filter((item) => item.id !== `shell:${shellId}`)
    }
    return agents === state.backgroundAgents ? state : { ...state, backgroundAgents: agents }
  }

  if (type === 'subagent.started' && data.executionMode === 'background') {
    const id = `agent:${data.toolCallId}`
    if (!data.toolCallId || state.backgroundAgents.some((item) => item.id === id)) return state
    return {
      ...state,
      backgroundAgents: [...state.backgroundAgents, {
        id,
        kind: 'agent',
        name: data.agentDisplayName || data.agentName || 'Background agent',
        detail: data.model || '',
        startedAt: eventTime(event),
      }],
    }
  }

  if (type === 'subagent.completed' || type === 'subagent.failed') {
    return { ...state, backgroundAgents: drop(`agent:${data.toolCallId}`) }
  }

  return state
}

// Replaying old logs can leave ghosts, because a session that was killed mid-run never
// records its completion notices. Only trust a replay when the log was active recently.
const REPLAY_FRESHNESS_MS = 30 * 60 * 1000

function backgroundActivityFromEvents(events) {
  let state = { pendingTools: {}, backgroundAgents: [] }
  for (const event of events || []) state = foldBackgroundActivity(state, event)
  const last = events?.length ? eventTime(events[events.length - 1]) : 0
  if (Date.now() - last > REPLAY_FRESHNESS_MS) {
    return { pendingTools: {}, backgroundAgents: [] }
  }
  return state
}

// A donut that fills clockwise. With no percentage to show it spins slowly instead, so the
// row still reads as alive rather than stalled.
function Ring({ percent }) {
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const known = typeof percent === 'number'
  const offset = known ? circumference * (1 - Math.min(Math.max(percent, 0), 100) / 100) : circumference * 0.7
  return (
    <svg className={`background-ring ${known ? '' : 'spinning'}`} viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
      <circle className="ring-track" cx="11" cy="11" r={radius} />
      <circle
        className="ring-value"
        cx="11"
        cy="11"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
      />
    </svg>
  )
}

function elapsedLabel(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function displayTime(value) {
  if (!value) return ''
  const date = new Date(value)
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000)
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function modelSpeed(modelId) {
  if (modelId === 'auto') return 'Auto speed'
  if (/haiku|flash|mini|luna/i.test(modelId)) return 'Fast'
  if (/opus|sol|gpt-5\.5$/i.test(modelId)) return 'Deep'
  return 'Balanced'
}

function formatModelPrice(value) {
  if (!Number.isFinite(value)) return null
  const dollars = value / 100
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

function modelLabel(model) {
  if (!model) return ''
  const speed = modelSpeed(model.id)
  if (model.id === 'auto') {
    const discount = model.billing?.discountPercent
    return `${model.name} (${discount ? `${discount}% discount · ` : ''}${speed})`
  }
  const prices = model.billing?.tokenPrices
  const input = formatModelPrice(prices?.inputPrice)
  const output = formatModelPrice(prices?.outputPrice)
  const cost = input && output ? `${input}/${output} per 1M` : 'Cost varies'
  return `${model.name} (${cost} · ${speed})`
}

function eventContent(event) {
  return event?.data?.content || event?.data?.prompt || event?.data?.message || ''
}

function eventAttachments(event) {
  const raw = event?.data?.attachments
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      const filePath = typeof item === 'string' ? item : item?.path
      if (typeof filePath !== 'string' || !filePath) return null
      return {
        type: 'file',
        path: filePath,
        displayName: (typeof item === 'object' && item?.displayName) || fileNameOf(filePath),
      }
    })
    .filter(Boolean)
}

function fileNameOf(filePath) {
  return String(filePath).split('/').pop() || String(filePath)
}

function messagesFromEvents(events) {
  const seen = new Set()
  return events
    .filter((event) => ['user.message', 'assistant.message'].includes(event.type))
    .map((event, index) => ({
      id: event.id || event.data?.messageId || `${event.type}-${index}`,
      role: event.type === 'user.message' ? 'user' : 'assistant',
      content: eventContent(event),
      attachments: eventAttachments(event),
      ...(event.type === 'user.message' ? { status: 'delivered' } : {}),
    }))
    .filter((message) => {
      if (!message.content) return false
      if (seen.has(message.id)) return false
      seen.add(message.id)
      return true
    })
}

function mergeMessage(items, incoming) {
  let index = items.findIndex((item) => item.id === incoming.id)
  if (index < 0 && incoming.role === 'user') {
    index = items.findIndex((item) => item.optimistic && item.role === 'user' && item.content === incoming.content)
  }
  if (index >= 0) {
    const previous = items[index]
    const next = items.slice()
    next[index] = {
      ...incoming,
      attachments: incoming.attachments?.length ? incoming.attachments : previous.attachments,
    }
    return next
  }
  return [...items, incoming]
}

function shellCommandOf(request) {
  if (!request || request.kind !== 'shell') return ''
  if (typeof request.fullCommandText === 'string' && request.fullCommandText) return request.fullCommandText
  const segments = Array.isArray(request.commandSegments) ? request.commandSegments : []
  const fromSegments = segments.map((segment) => segment?.fullCommandText).filter(Boolean)
  if (fromSegments.length) return fromSegments.join('\n')
  const commands = Array.isArray(request.commands) ? request.commands : []
  const fromCommands = commands
    .map((entry) => (typeof entry === 'string' ? entry : entry?.identifier))
    .filter(Boolean)
  if (fromCommands.length) return fromCommands.join('\n')
  return typeof request.command === 'string' ? request.command : ''
}

function permissionDescription(request) {
  if (!request) return 'Copilot wants to use a tool.'
  if (request.intention) return request.intention
  if (request.kind === 'shell') return 'Copilot wants to run a command in your terminal.'
  if (request.kind === 'write') return `Copilot wants to edit ${request.fileName || 'a local file'}.`
  if (request.kind === 'read') return `Copilot wants to read ${request.path || request.fileName || 'a local file'}.`
  if (request.kind === 'url') return `Copilot wants to open ${request.url || 'a web address'}.`
  if (request.kind === 'mcp') {
    return `Copilot wants to use ${request.serverName || 'an MCP server'} with the ${request.toolName || 'tool'} tool.`
  }
  return `Copilot wants to use ${request.kind || 'a local tool'}.`
}

function isAuthErrorMessage(message) {
  return /auth|sign in|log ?in|token|credential/i.test(message || '')
}

function withHardBreaks(text) {
  return String(text).replace(/([^\n])\n(?!\n)/g, '$1  \n')
}

function openExternalLink(event, href) {
  event.preventDefault()
  if (!href) return
  window.copilot?.openExternal(href)
}

const RUNNABLE_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal'])
const RunCommandContext = createContext(null)
const PreviewContext = createContext(null)

const PREVIEW_DEVICES = [
  { id: 'desktop', label: 'Desktop', width: null },
  { id: 'tablet', label: 'Tablet', width: 834 },
  { id: 'mobile', label: 'Mobile', width: 390 },
]

// Only markup we can render on its own gets a preview button. Framework code needs a real dev server.
function previewKindOf(language, code) {
  const lang = String(language || '').toLowerCase()
  const body = String(code || '')
  if (!body.trim()) return null
  if (lang === 'svg') return 'svg'
  if (lang === 'html' || lang === 'htm') return 'html'
  if (lang === 'css') return /[{]/.test(body) ? 'css' : null
  if (lang && lang !== 'xml' && lang !== 'markup') return null
  if (/^\s*<svg[\s>]/i.test(body)) return 'svg'
  if (/<!doctype\s+html|<html[\s>]/i.test(body)) return 'html'
  if (!lang && /<(div|section|main|header|body|button|ul|table|form|article)[\s>]/i.test(body)) return 'html'
  return null
}

const PREVIEW_BRIDGE = `
<script>
  (function () {
    var send = function (payload) {
      try { window.parent.postMessage(Object.assign({ source: 'hc-preview' }, payload), '*') } catch (e) {}
    }
    window.addEventListener('error', function (event) {
      send({ type: 'error', message: event.message || 'Script error' })
    })
    window.addEventListener('unhandledrejection', function (event) {
      send({ type: 'error', message: String((event.reason && event.reason.message) || event.reason || 'Unhandled rejection') })
    })
    document.addEventListener('click', function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null
      if (!anchor) return
      var href = anchor.getAttribute('href') || ''
      if (href.charAt(0) === '#') return
      event.preventDefault()
      send({ type: 'navigate', href: anchor.href })
    })
    var report = function () {
      send({ type: 'size', height: document.documentElement.scrollHeight })
    }
    window.addEventListener('load', report)
    setTimeout(report, 60)
  }())
</script>
`

const PREVIEW_RESET = `
<style>
  html { box-sizing: border-box; }
  *, *::before, *::after { box-sizing: inherit; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
</style>
`

function buildPreviewDocument(kind, code) {
  const body = String(code || '')
  if (kind === 'svg') {
    return `<!doctype html><html><head><meta charset="utf-8">${PREVIEW_RESET}
<style>body{min-height:100vh;display:grid;place-items:center;padding:24px;background:#fff}svg{max-width:100%;height:auto}</style>
</head><body>${body}${PREVIEW_BRIDGE}</body></html>`
  }
  if (kind === 'css') {
    return `<!doctype html><html><head><meta charset="utf-8">${PREVIEW_RESET}<style>${body}</style>
</head><body><div class="preview-css-note" style="padding:24px;font:13px/1.6 -apple-system,sans-serif;color:#6b6862">
These styles are loaded. Add markup that uses them to see the result.</div>${PREVIEW_BRIDGE}</body></html>`
  }
  if (/<html[\s>]/i.test(body)) {
    if (/<\/body>/i.test(body)) return body.replace(/<\/body>/i, `${PREVIEW_BRIDGE}</body>`)
    return `${body}${PREVIEW_BRIDGE}`
  }
  return `<!doctype html><html><head><meta charset="utf-8">${PREVIEW_RESET}
</head><body>${body}${PREVIEW_BRIDGE}</body></html>`
}

function previewTitleOf(kind, code) {
  const heading = /<title[^>]*>([^<]{1,60})<\/title>/i.exec(code)?.[1]
    || /<h1[^>]*>([^<]{1,60})<\/h1>/i.exec(code)?.[1]
  if (heading) return heading.trim()
  if (kind === 'svg') return 'SVG preview'
  if (kind === 'css') return 'Stylesheet preview'
  return 'UI preview'
}

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const runCommand = useContext(RunCommandContext)
  const openPreview = useContext(PreviewContext)
  const runnable = Boolean(runCommand) && RUNNABLE_LANGUAGES.has((language || '').toLowerCase()) && code.trim()
  const previewKind = openPreview ? previewKindOf(language, code) : null

  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => {})
  }

  const confirmRun = () => {
    setConfirming(false)
    runCommand(code)
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{language || 'code'}</span>
        {previewKind && (
          <button
            type="button"
            className="code-preview"
            onClick={() => openPreview({ kind: previewKind, language, code })}
          >
            <Eye size={11} /> Preview
          </button>
        )}
        {runnable && !confirming && (
          <button type="button" className="code-run" onClick={() => setConfirming(true)}>
            <Play size={11} /> Run
          </button>
        )}
        {runnable && confirming && (
          <span className="code-run-confirm">
            Run this?
            <button type="button" className="code-run-yes" onClick={confirmRun}>Run</button>
            <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        )}
        <button type="button" onClick={copy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}

function MarkdownPre({ children }) {
  const child = Array.isArray(children) ? children[0] : children
  const className = child?.props?.className || ''
  const language = /language-([\w-]+)/.exec(className)?.[1]
  const code = String(child?.props?.children ?? '').replace(/\n$/, '')
  return <CodeBlock language={language} code={code} />
}

const markdownComponents = {
  a: ({ href, children, ...rest }) => (
    <a {...rest} href={href} onClick={(event) => openExternalLink(event, href)}>{children}</a>
  ),
  pre: MarkdownPre,
  table: ({ children, ...rest }) => (
    <div className="markdown-table"><table {...rest}>{children}</table></div>
  ),
}

function MessageBody({ role, content }) {
  const source = role === 'user' ? withHardBreaks(content) : content
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

function MessageAttachment({ item }) {
  const [thumbnail, setThumbnail] = useState(item.thumbnail || '')

  useEffect(() => {
    if (item.thumbnail) {
      setThumbnail(item.thumbnail)
      return undefined
    }
    if (!isImageName(item.path)) return undefined
    let active = true
    window.copilot?.readAttachmentPreview?.(item.path)
      .then((result) => {
        if (active && result?.ok) setThumbnail(result.dataUrl)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [item.path, item.thumbnail])

  return (
    <span className={`attachment-chip static ${thumbnail ? 'with-thumb' : ''}`} title={item.path}>
      {thumbnail
        ? <img className="attachment-thumb" src={thumbnail} alt="" />
        : <Paperclip size={11} className={isImageName(item.path) ? 'image-file' : ''} />}
      <span className="attachment-name">{item.displayName || item.path}</span>
    </span>
  )
}

function MessageStatus({ status, attachmentCount }) {
  if (!status) return null
  const suffix = attachmentCount
    ? ` with ${attachmentCount} attachment${attachmentCount > 1 ? 's' : ''}`
    : ''
  if (status === 'sending') {
    return (
      <div className="message-status sending">
        <LoaderCircle className="spin" size={11} /> Sending{suffix}
      </div>
    )
  }
  if (status === 'sent') {
    return (
      <div className="message-status sent">
        <Check size={11} /> Sent{suffix}
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className="message-status failed">
        <AlertTriangle size={11} /> Not sent{suffix}. Put back in the composer so you can try again.
      </div>
    )
  }
  return (
    <div className="message-status delivered">
      <CheckCheck size={11} /> Copilot received this message{suffix}
    </div>
  )
}

function ArtifactPanel({ artifact, onClose, onError }) {
  const [tab, setTab] = useState('preview')
  const [device, setDevice] = useState('desktop')
  const [runtimeError, setRuntimeError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [copied, setCopied] = useState(false)
  const frameRef = useRef(null)

  const document_ = useMemo(
    () => buildPreviewDocument(artifact.kind, artifact.code),
    [artifact.kind, artifact.code],
  )

  useEffect(() => {
    setRuntimeError('')
    setTab('preview')
  }, [artifact.id])

  useEffect(() => {
    const onMessage = (event) => {
      if (event.data?.source !== 'hc-preview') return
      if (event.source !== frameRef.current?.contentWindow) return
      if (event.data.type === 'error') setRuntimeError(String(event.data.message || 'Script error'))
      if (event.data.type === 'navigate') window.copilot?.openExternal(event.data.href)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const reload = () => {
    setRuntimeError('')
    setReloadKey((value) => value + 1)
  }

  const copyCode = () => {
    navigator.clipboard?.writeText(artifact.code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => {})
  }

  const openInBrowser = async () => {
    const result = await window.copilot?.openPreviewInBrowser?.(document_)
    if (result && !result.ok) onError(result.error?.message || 'Could not open the preview.')
  }

  const saveFile = async () => {
    const result = await window.copilot?.savePreviewHtml?.({
      html: document_,
      suggestedName: `${artifact.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'preview'}.html`,
    })
    if (result && !result.ok && !result.canceled) onError(result.error?.message || 'Could not save the preview.')
  }

  const deviceWidth = PREVIEW_DEVICES.find((item) => item.id === device)?.width

  return (
    <aside className="artifact-panel">
      <header className="artifact-head">
        <div className="artifact-title">
          <span className="artifact-icon"><Eye size={14} /></span>
          <div>
            <strong title={artifact.title}>{artifact.title}</strong>
            <small>{artifact.language || artifact.kind}</small>
          </div>
        </div>
        <button type="button" className="artifact-close" onClick={onClose} aria-label="Close preview">
          <X size={15} />
        </button>
      </header>

      <div className="artifact-toolbar">
        <div className="artifact-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'preview'}
            className={tab === 'preview' ? 'active' : ''}
            onClick={() => setTab('preview')}
          >
            <Eye size={12} /> Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'code'}
            className={tab === 'code' ? 'active' : ''}
            onClick={() => setTab('code')}
          >
            <Code2 size={12} /> Code
          </button>
        </div>
        <div className="artifact-tools">
          {tab === 'preview' && (
            <div className="artifact-devices">
              {PREVIEW_DEVICES.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  title={item.label}
                  aria-label={item.label}
                  className={device === item.id ? 'active' : ''}
                  onClick={() => setDevice(item.id)}
                >
                  {item.id === 'desktop' && <Monitor size={12} />}
                  {item.id === 'tablet' && <Tablet size={12} />}
                  {item.id === 'mobile' && <Smartphone size={12} />}
                </button>
              ))}
            </div>
          )}
          <button type="button" title="Reload preview" aria-label="Reload preview" onClick={reload}>
            <RefreshCw size={12} />
          </button>
          <button type="button" title="Copy code" aria-label="Copy code" onClick={copyCode}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          <button type="button" title="Save as HTML" aria-label="Save as HTML" onClick={saveFile}>
            <Download size={12} />
          </button>
          <button type="button" title="Open in browser" aria-label="Open in browser" onClick={openInBrowser}>
            <ExternalLink size={12} />
          </button>
        </div>
      </div>

      {runtimeError && tab === 'preview' && (
        <div className="artifact-error">
          <AlertTriangle size={12} />
          <span>{runtimeError}</span>
          <button type="button" onClick={() => setRuntimeError('')} aria-label="Dismiss"><X size={11} /></button>
        </div>
      )}

      <div className={`artifact-body ${tab}`}>
        {tab === 'preview' ? (
          <div className="artifact-stage">
            <iframe
              key={`${artifact.id}-${reloadKey}`}
              ref={frameRef}
              className="artifact-frame"
              title="UI preview"
              sandbox="allow-scripts allow-forms allow-modals"
              srcDoc={document_}
              style={deviceWidth ? { width: `${deviceWidth}px` } : undefined}
            />
          </div>
        ) : (
          <pre className="artifact-code"><code>{artifact.code}</code></pre>
        )}
      </div>
    </aside>
  )
}

function App() {
  const api = window.copilot
  const [ready, setReady] = useState(false)
  const [auth, setAuth] = useState(null)
  const [models, setModels] = useState([])
  const [sessions, setSessions] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [selectedModel, setSelectedModel] = useState('auto')
  const [messages, setMessages] = useState([])
  const [sessionState, setSessionState] = useState({})
  const [backgroundProbes, setBackgroundProbes] = useState({})
  const [tick, setTick] = useState(0)
  const [quota, setQuota] = useState(null)
  const [capabilities, setCapabilities] = useState(null)
  const [knowledge, setKnowledge] = useState([])
  const [toolkitOpen, setToolkitOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const composingRef = useRef(false)
  const compositionEndedAtRef = useRef(0)
  const composerRef = useRef(null)
  const [attachments, setAttachments] = useState([])
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [error, setError] = useState(null)
  const [permissions, setPermissions] = useState([])
  const [permissionDetailsFor, setPermissionDetailsFor] = useState(null)
  const [sessionToDelete, setSessionToDelete] = useState(null)
  const [aliases, setAliases] = useState(() => loadValue(ALIASES_KEY, {}))
  const [pinnedPaths, setPinnedPaths] = useState(() => loadValue(PINS_KEY, []))
  const [pinnedSessionIds, setPinnedSessionIds] = useState(() => loadValue(PINNED_SESSIONS_KEY, []))
  const [selectedProject, setSelectedProject] = useState(() => {
    const stored = loadValue(SELECTED_PROJECT_KEY, null)
    return isFolderKey(stored) ? stored : null
  })
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => clamp(
    Number(loadValue(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH)),
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
  ))
  const [projectsHeight, setProjectsHeight] = useState(() => clamp(
    Number(loadValue(PROJECTS_HEIGHT_KEY, PROJECTS_DEFAULT_HEIGHT)),
    PROJECTS_MIN_HEIGHT,
    maxProjectsHeight(),
  ))
  const [projectsCollapsed, setProjectsCollapsed] = useState(() => Boolean(loadValue(PROJECTS_COLLAPSED_KEY, false)))
  const [resizing, setResizing] = useState(null)
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [editingSession, setEditingSession] = useState(false)
  const [editingSessionId, setEditingSessionId] = useState(null)
  const [rowMenu, setRowMenu] = useState(null)
  const [visibleCount, setVisibleCount] = useState(80)
  const [loadingSession, setLoadingSession] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const selectedIdRef = useRef(selectedId)
  const selectedModelRef = useRef(selectedModel)
  const selectedProjectRef = useRef(selectedProject)
  const atBottomRef = useRef(true)
  const searchInputRef = useRef(null)
  const conversationRef = useRef(null)
  const dragDepthRef = useRef(0)
  const dragStateRef = useRef(null)
  const restoredSelectionRef = useRef(false)
  const draftsRef = useRef({})
  const draftSessionIdRef = useRef(null)
  const messageRef = useRef('')
  const attachmentsRef = useRef([])
  const [draftAttachmentCounts, setDraftAttachmentCounts] = useState({})
  const [artifacts, setArtifacts] = useState({})
  const [artifactWidth, setArtifactWidth] = useState(() => clamp(
    Number(loadValue(ARTIFACT_WIDTH_KEY, ARTIFACT_DEFAULT_WIDTH)),
    ARTIFACT_MIN_WIDTH,
    ARTIFACT_MAX_WIDTH,
  ))

  const artifact = selectedId ? artifacts[selectedId] : null

  const openPreview = useCallback(({ kind, language, code }) => {
    const sessionId = selectedIdRef.current
    if (!sessionId) return
    setArtifacts((current) => ({
      ...current,
      [sessionId]: {
        id: `${sessionId}-${Date.now()}`,
        kind,
        language,
        code,
        title: previewTitleOf(kind, code),
      },
    }))
  }, [])

  const closePreview = useCallback(() => {
    const sessionId = selectedIdRef.current
    if (!sessionId) return
    setArtifacts((current) => {
      if (!current[sessionId]) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [])

  useEffect(() => {
    saveValue(ARTIFACT_WIDTH_KEY, artifactWidth)
  }, [artifactWidth])
  const queuesRef = useRef({})
  const [queues, setQueues] = useState({})
  const drainQueueRef = useRef(() => false)

  const [resourceEdits, setResourceEdits] = useState(() => loadValue(RESOURCES_KEY, {}) || {})
  const [railOpen, setRailOpen] = useState(false)
  const [railDraft, setRailDraft] = useState(null)
  const [railMenu, setRailMenu] = useState(null)

  useEffect(() => saveValue(RESOURCES_KEY, resourceEdits), [resourceEdits])

  const editResources = useCallback((sessionId, updater) => {
    if (!sessionId) return
    setResourceEdits((current) => {
      const existing = current[sessionId] || { hidden: [], manual: [], labels: {} }
      const next = updater(existing)
      return { ...current, [sessionId]: next }
    })
  }, [])

  // Queued messages are keyed by session so typing ahead in one never leaks into another.
  const writeQueue = useCallback((sessionId, updater) => {
    if (!sessionId) return
    const current = queuesRef.current[sessionId] || []
    const next = typeof updater === 'function' ? updater(current) : updater
    if (next.length) queuesRef.current[sessionId] = next
    else delete queuesRef.current[sessionId]
    setQueues({ ...queuesRef.current })
  }, [])

  useEffect(() => {
    if (!selectedId) return
    setDraftAttachmentCounts((current) => (
      current[selectedId] === attachments.length
        ? current
        : { ...current, [selectedId]: attachments.length }
    ))
  }, [selectedId, attachments])

  useEffect(() => {
    messageRef.current = message
    attachmentsRef.current = attachments
  })

  // Each session keeps its own composer draft, so switching sessions never loses a pasted screenshot.
  useLayoutEffect(() => {
    const previousId = draftSessionIdRef.current
    if (previousId === selectedId) return
    if (previousId) {
      draftsRef.current[previousId] = {
        message: messageRef.current,
        attachments: attachmentsRef.current,
      }
    }
    draftSessionIdRef.current = selectedId
    const draft = (selectedId && draftsRef.current[selectedId]) || { message: '', attachments: [] }
    messageRef.current = draft.message
    attachmentsRef.current = draft.attachments
    setMessage(draft.message)
    setAttachments(draft.attachments)
  }, [selectedId])

  const clearDraft = useCallback((sessionId) => {
    if (sessionId) delete draftsRef.current[sessionId]
    setDraftAttachmentCounts((current) => ({ ...current, [sessionId]: 0 }))
    if (sessionId === draftSessionIdRef.current) {
      messageRef.current = ''
      attachmentsRef.current = []
      setMessage('')
      setAttachments([])
    }
  }, [])

  const restoreDraft = useCallback((sessionId, draft) => {
    if (!sessionId) return
    if (sessionId === draftSessionIdRef.current) {
      setMessage((current) => (current.trim() ? current : draft.message))
      setAttachments((current) => {
        const paths = new Set(current.map((item) => item.path))
        return [...current, ...draft.attachments.filter((item) => !paths.has(item.path))]
      })
      return
    }
    const stored = draftsRef.current[sessionId] || { message: '', attachments: [] }
    const paths = new Set(stored.attachments.map((item) => item.path))
    const merged = [...stored.attachments, ...draft.attachments.filter((item) => !paths.has(item.path))]
    draftsRef.current[sessionId] = {
      message: stored.message.trim() ? stored.message : draft.message,
      attachments: merged,
    }
    setDraftAttachmentCounts((current) => ({ ...current, [sessionId]: merged.length }))
  }, [])

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  useEffect(() => {
    selectedModelRef.current = selectedModel
  }, [selectedModel])

  useEffect(() => {
    selectedProjectRef.current = selectedProject
  }, [selectedProject])

  const selected = sessions.find((session) => session.id === selectedId)
  const selectedWorkingDirectory = workingDirectoryOf(selected)
  const quotaSnapshot = quota?.premium_interactions || quota?.chat || null
  const liveState = sessionState[selectedId] || EMPTY_SESSION_STATE
  const working = liveState.working
  const backgroundAgents = liveState.backgroundAgents
  const selectedQueue = (selectedId && queues[selectedId]) || EMPTY_QUEUE

  // Only tick while background work exists, so an idle app does no per-second work.
  useEffect(() => {
    if (!backgroundAgents.length) return undefined
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [backgroundAgents.length])


  const sessionEdits = useMemo(
    () => (selectedId && resourceEdits[selectedId]) || EMPTY_EDITS,
    [resourceEdits, selectedId],
  )
  const resources = useMemo(() => {
    const detected = collectResources(messages, selectedWorkingDirectory)
    const hidden = new Set(sessionEdits.hidden || [])
    const manual = (sessionEdits.manual || []).map((item, index) => ({
      ...item,
      manual: true,
      count: 1,
      order: index,
    }))
    const manualValues = new Set(manual.map((item) => item.value))
    const merged = [
      ...manual,
      ...detected.filter((item) => !manualValues.has(item.value)),
    ]
      .filter((item) => !hidden.has(item.value))
      .map((item) => ({ ...item, label: sessionEdits.labels?.[item.value] || item.label }))
    return pickPrimary(merged)
  }, [messages, selectedWorkingDirectory, sessionEdits])

  const patchSessionState = useCallback((sessionId, patch) => {
    setSessionState((current) => {
      const previous = current[sessionId] || EMPTY_SESSION_STATE
      const next = typeof patch === 'function' ? patch(previous) : { ...previous, ...patch }
      return { ...current, [sessionId]: next }
    })
  }, [])

  const showError = useCallback((text, options = {}) => {
    if (!text) return
    setError({ message: text, persistent: options.persistent || isAuthErrorMessage(text) })
  }, [])

  // Poll the detached shell logs for progress while background work is live. The shellIds
  // are the join key, so only shell items are probed; subagents have no log to read.
  const shellIds = backgroundAgents.filter((item) => item.kind === 'shell').map((item) => item.detail).join(',')
  useEffect(() => {
    if (!api?.probeBackground || !shellIds) return undefined
    let cancelled = false
    const poll = () => {
      api.probeBackground(shellIds.split(',')).then((result) => {
        if (cancelled || !result?.ok) return
        setBackgroundProbes(result.report)
        // The .exit file is ground truth: if it exists the command is over, even when the
        // completion notice never made it into the event log.
        const finished = Object.values(result.report).filter((probe) => probe.finished).map((probe) => probe.shellId)
        if (finished.length && selectedId) {
          patchSessionState(selectedId, (current) => ({
            ...current,
            backgroundAgents: current.backgroundAgents.filter(
              (item) => !(item.kind === 'shell' && finished.includes(item.detail)),
            ),
          }))
        }
      }).catch(() => {})
    }
    poll()
    const timer = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [api, patchSessionState, selectedId, shellIds])

  useEffect(() => {
    if (!error || error.persistent) return undefined
    const timer = setTimeout(() => setError(null), ERROR_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [error])

  const projects = useMemo(() => {
    const byKey = new Map()
    sessions.forEach((session) => {
      const key = workingDirectoryOf(session)
      if (!key) return
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          name: folderLabel(key),
          path: key,
          count: 0,
          lastActivity: 0,
        })
      }
      const entry = byKey.get(key)
      entry.count += 1
      const time = new Date(session.updatedAt).getTime() || 0
      if (time > entry.lastActivity) entry.lastActivity = time
    })
    return [...byKey.values()]
      .map((entry) => ({ ...entry, pinned: pinnedPaths.includes(entry.key) }))
      .sort((a, b) => {
        const pinDifference = Number(b.pinned) - Number(a.pinned)
        if (pinDifference) return pinDifference
        return b.lastActivity - a.lastActivity
      })
  }, [pinnedPaths, sessions])

  const visibleProjects = useMemo(() => {
    if (showAllProjects) return projects
    const preview = projects.slice(0, PROJECT_PREVIEW_COUNT)
    if (selectedProject && !preview.some((project) => project.key === selectedProject)) {
      const active = projects.find((project) => project.key === selectedProject)
      if (active) return [...preview, active]
    }
    return preview
  }, [projects, selectedProject, showAllProjects])

  const visibleSessions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions
      .filter((session) => !selectedProject || projectKeyOf(session) === selectedProject)
      .filter((session) => {
        if (!needle) return true
        const title = aliases[session.id] || session.title
        return `${title} ${projectName(session)}`.toLowerCase().includes(needle)
      })
      .sort((a, b) => {
        const pinDifference = Number(pinnedSessionIds.includes(b.id)) - Number(pinnedSessionIds.includes(a.id))
        if (pinDifference) return pinDifference
        return new Date(b.updatedAt) - new Date(a.updatedAt)
      })
  }, [aliases, pinnedSessionIds, query, selectedProject, sessions])

  const pinnedVisibleSessions = visibleSessions.filter((session) => pinnedSessionIds.includes(session.id))
  const regularVisibleSessions = visibleSessions.filter((session) => !pinnedSessionIds.includes(session.id))
  const displayedRegularSessions = regularVisibleSessions.slice(0, Math.max(0, visibleCount - pinnedVisibleSessions.length))

  useEffect(() => saveValue(ALIASES_KEY, aliases), [aliases])
  useEffect(() => saveValue(PINS_KEY, pinnedPaths), [pinnedPaths])
  useEffect(() => saveValue(PINNED_SESSIONS_KEY, pinnedSessionIds), [pinnedSessionIds])
  useEffect(() => saveValue(SELECTED_PROJECT_KEY, selectedProject), [selectedProject])
  useEffect(() => saveValue(SELECTED_SESSION_KEY, selectedId), [selectedId])
  useEffect(() => saveValue(SIDEBAR_WIDTH_KEY, sidebarWidth), [sidebarWidth])
  useEffect(() => saveValue(PROJECTS_HEIGHT_KEY, projectsHeight), [projectsHeight])
  useEffect(() => saveValue(PROJECTS_COLLAPSED_KEY, projectsCollapsed), [projectsCollapsed])

  const startSidebarResize = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragStateRef.current = { type: 'sidebar', origin: event.clientX, start: sidebarWidth }
    setResizing('sidebar')
  }

  const startProjectsResize = (event) => {
    if (event.button !== 0) return
    if (projectsCollapsed) return
    event.preventDefault()
    dragStateRef.current = { type: 'projects', origin: event.clientY, start: projectsHeight }
    setResizing('projects')
  }

  const startArtifactResize = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragStateRef.current = { type: 'artifact', origin: event.clientX, start: artifactWidth }
    setResizing('artifact')
  }

  useEffect(() => {
    if (!resizing) return undefined
    const move = (event) => {
      const state = dragStateRef.current
      if (!state) return
      if (state.type === 'sidebar') {
        const next = state.start + (event.clientX - state.origin)
        setSidebarWidth(clamp(Math.round(next), SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH))
        return
      }
      if (state.type === 'artifact') {
        const next = state.start - (event.clientX - state.origin)
        setArtifactWidth(clamp(Math.round(next), ARTIFACT_MIN_WIDTH, maxArtifactWidth()))
        return
      }
      const next = state.start + (event.clientY - state.origin)
      setProjectsHeight(clamp(Math.round(next), PROJECTS_MIN_HEIGHT, maxProjectsHeight()))
    }
    const stop = () => {
      dragStateRef.current = null
      setResizing(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [resizing])

  useEffect(() => {
    const onWindowResize = () => {
      setProjectsHeight((height) => clamp(height, PROJECTS_MIN_HEIGHT, maxProjectsHeight()))
      setArtifactWidth((width) => clamp(width, ARTIFACT_MIN_WIDTH, maxArtifactWidth()))
    }
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [])

  const resetScroll = useCallback(() => {
    atBottomRef.current = true
    setAtBottom(true)
  }, [])

  const openSession = useCallback((sessionId) => {
    if (!sessionId) return
    if (sessionId === selectedIdRef.current) {
      setSessionMenuOpen(false)
      setEditingSession(false)
      return
    }
    setMessages([])
    setLoadingSession(true)
    resetScroll()
    setSessionMenuOpen(false)
    setEditingSession(false)
    setSelectedId(sessionId)
  }, [resetScroll])

  const createSession = useCallback(async (options = {}) => {
    const activeProject = selectedProjectRef.current
    const workingDirectory = options.chooseFolder || !isFolderKey(activeProject) ? '' : activeProject
    const result = await api.createSession({
      model: selectedModelRef.current,
      workingDirectory,
      chooseFolder: Boolean(options.chooseFolder),
    })
    if (result.canceled) return
    if (!result.ok) {
      showError(result.error?.message || 'Could not create a session.')
      return
    }
    setError(null)
    setSessions((items) => [result.session, ...items])
    const directory = workingDirectoryOf(result.session)
    if (directory) setSelectedProject(directory)
    setMessages([])
    setLoadingSession(true)
    resetScroll()
    setSelectedId(result.session.id)
  }, [api, resetScroll, showError])

  useEffect(() => {
    if (!api) {
      return undefined
    }

    const unsubscribeEvents = api.onEvent(({ sessionId, event }) => {
      const isSelected = sessionId === selectedIdRef.current

      if (event.type === 'assistant.message_delta') {
        patchSessionState(sessionId, (current) => ({
          ...current,
          working: true,
          liveText: current.liveText + (event.data?.deltaContent || ''),
        }))
      }
      if (event.type === 'assistant.message') {
        const content = eventContent(event)
        patchSessionState(sessionId, { liveText: '' })
        if (content && isSelected) {
          setMessages((items) => mergeMessage(items, {
            id: event.id || event.data?.messageId || crypto.randomUUID(),
            role: 'assistant',
            content,
          }))
        }
      }
      if (event.type === 'user.message') {
        const content = eventContent(event)
        if (content && isSelected) {
          setMessages((items) => mergeMessage(items, {
            id: event.id || event.data?.messageId || crypto.randomUUID(),
            role: 'user',
            content,
            attachments: eventAttachments(event),
            status: 'delivered',
          }))
        }
      }
      if (event.type === 'tool.execution_start') {
        patchSessionState(sessionId, (current) => ({
          ...current,
          working: true,
          toolActivity: [...current.toolActivity.slice(-3), {
            id: event.data?.toolCallId || crypto.randomUUID(),
            name: event.data?.toolName || 'Using a tool',
            status: 'running',
          }],
        }))
      }
      if (event.type === 'tool.execution_complete') {
        patchSessionState(sessionId, (current) => ({
          ...current,
          toolActivity: current.toolActivity.map((item) => (
            item.id === event.data?.toolCallId ? { ...item, status: 'done' } : item
          )),
        }))
      }
      patchSessionState(sessionId, (current) => foldBackgroundActivity(current, event))

      if (event.type === 'session.idle') {
        // Background shells and agents outlive a turn, so they are never cleared here.
        patchSessionState(sessionId, { liveText: '', toolActivity: [] })
        // Only fall back to idle when nothing is queued, so the composer never flickers between turns.
        if (!drainQueueRef.current(sessionId)) {
          patchSessionState(sessionId, { working: false })
        }
        api.refreshQuota().then((result) => {
          if (result.ok) setQuota(result.quota)
        }).catch((e) => showError(e?.message || String(e)))
      }
      if (event.type === 'session.error') {
        patchSessionState(sessionId, { working: false, backgroundAgents: [] })
        queuesRef.current = Object.fromEntries(
          Object.entries(queuesRef.current).filter(([key]) => key !== sessionId),
        )
        setQueues({ ...queuesRef.current })
        if (isSelected) showError(event.data?.message || 'The Copilot session reported an error.')
      }
    })

    const unsubscribePermission = api.onPermission((payload) => {
      setPermissions((items) => (
        items.some((item) => item.requestId === payload.requestId) ? items : [...items, payload]
      ))
    })

    const unsubscribeMetadata = api.onSessionMetadata((metadata) => {
      if (!metadata?.id) return
      setSessions((items) => items.map((session) => {
        if (session.id !== metadata.id) return session
        const hasTitle = metadata.title && metadata.title !== 'Untitled session'
        return {
          ...session,
          ...metadata,
          title: hasTitle ? metadata.title : session.title,
          context: metadata.context?.workingDirectory ? metadata.context : session.context,
        }
      }))
    })

    const unsubscribeCommands = api.onCommand((command) => {
      if (command === 'new-session') createSession()
      if (command === 'new-session-folder') createSession({ chooseFolder: true })
      if (command === 'focus-search') searchInputRef.current?.focus()
    })

    api.initialize().then((result) => {
      if (!result.ok) {
        showError(result.error?.message || 'Could not connect to GitHub Copilot.', { persistent: true })
        return
      }
      const sorted = result.sessions.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      setAuth(result.auth)
      setModels(result.models)
      setSessions(sorted)
      setQuota(result.quota)
      setCapabilities(result.capabilities)
      setKnowledge(result.capabilities?.knowledge || [])
      setSelectedModel(result.models[0]?.id || 'auto')
      setReady(true)

      let project = selectedProjectRef.current
      if (project && !sorted.some((session) => projectKeyOf(session) === project)) {
        project = null
        setSelectedProject(null)
      }
      const pool = project ? sorted.filter((session) => projectKeyOf(session) === project) : sorted
      const storedId = loadValue(SELECTED_SESSION_KEY, null)
      const restored = pool.find((session) => session.id === storedId) || pool[0] || null
      restoredSelectionRef.current = true
      if (restored) {
        setLoadingSession(true)
        setSelectedId(restored.id)
      }
    }).catch((e) => showError(e?.message || String(e)))

    return () => {
      unsubscribeEvents()
      unsubscribePermission()
      unsubscribeMetadata()
      unsubscribeCommands()
    }
  }, [api, createSession, patchSessionState, showError])

  useEffect(() => {
    if (!api || !selectedId) return
    let active = true
    api.openSession(selectedId).then((result) => {
      if (!active || selectedIdRef.current !== selectedId) return
      setLoadingSession(false)
      if (!result.ok) {
        showError(result.error?.message || 'Could not open this session.')
        return
      }
      setMessages(messagesFromEvents(result.events))
      // Rebuild work that was already running before this session was opened.
      const activity = backgroundActivityFromEvents(result.events)
      patchSessionState(selectedId, activity)
      const current = result.currentModel
      if (current?.modelId) setSelectedModel(current.modelId)
    }).catch((e) => showError(e?.message || String(e)))
    return () => {
      active = false
    }
  }, [api, patchSessionState, selectedId, showError])

  useEffect(() => {
    if (!restoredSelectionRef.current) return
    if (!selectedProject) return
    const current = sessions.find((session) => session.id === selectedId)
    if (current && projectKeyOf(current) === selectedProject) return
    const newest = sessions
      .filter((session) => projectKeyOf(session) === selectedProject)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0]
    if (newest) {
      openSession(newest.id)
      return
    }
    setMessages([])
    setLoadingSession(false)
    setSelectedId(null)
  }, [openSession, selectedId, selectedProject, sessions])

  useEffect(() => {
    if (!api) return
    const directory = isFolderKey(selectedProject)
      ? selectedProject
      : (isFolderKey(selectedWorkingDirectory) ? selectedWorkingDirectory : '')
    api.instructionFiles(directory).then((result) => {
      if (result.ok) setKnowledge(result.files.map((file) => file.label))
    }).catch((e) => showError(e?.message || String(e)))
  }, [api, selectedProject, selectedWorkingDirectory])

  useEffect(() => {
    if (!atBottomRef.current) return
    const node = conversationRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages, liveState.liveText, liveState.working, loadingSession])

  useEffect(() => {
    if (!sessionMenuOpen) return undefined
    const close = () => setSessionMenuOpen(false)
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSessionMenuOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [sessionMenuOpen])

  useEffect(() => {
    if (!rowMenu) return undefined
    const close = () => setRowMenu(null)
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setRowMenu(null)
    }
    window.addEventListener('resize', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [rowMenu])

  const handleConversationScroll = (event) => {
    const node = event.currentTarget
    const near = node.scrollHeight - node.scrollTop - node.clientHeight < 120
    atBottomRef.current = near
    setAtBottom(near)
  }

  const jumpToLatest = () => {
    const node = conversationRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
  }

  const addAttachmentItems = useCallback((incoming) => {
    const usable = incoming.filter((item) => item && item.path)
    if (!usable.length) return
    setAttachments((items) => {
      const paths = new Set(items.map((item) => item.path))
      return [...items, ...usable.filter((item) => !paths.has(item.path))]
    })
  }, [])

  const addAttachments = async () => {
    const result = await api.pickAttachments()
    if (result.canceled) return
    if (!result.ok) {
      showError(result.error?.message || 'Could not attach those files.')
      return
    }
    addAttachmentItems(result.attachments)
  }

  const removeAttachment = (filePath) => {
    setAttachments((items) => items.filter((item) => item.path !== filePath))
  }

  const addDroppedFiles = async (files) => {
    const list = Array.from(files || [])
    if (!list.length) return
    const dropped = await Promise.all(list.map(async (file) => ({
      type: 'file',
      path: api.getPathForFile(file),
      displayName: file.name,
      thumbnail: await readImageThumbnail(file),
    })))
    addAttachmentItems(dropped)
  }

  const addPastedImages = async (files) => {
    for (const file of files) {
      const existingPath = api.getPathForFile?.(file)
      if (existingPath) {
        addAttachmentItems([{
          type: 'file',
          path: existingPath,
          displayName: file.name || existingPath,
          thumbnail: await readImageThumbnail(file),
        }])
        continue
      }
      const buffer = await file.arrayBuffer()
      const extension = String(file.type || '').split('/')[1] || 'png'
      const result = await api.savePastedImage(buffer, extension)
      if (!result?.ok) {
        showError(result?.error?.message || 'Could not save the pasted image.')
        continue
      }
      const thumbnail = await readImageThumbnail(file)
      addAttachmentItems([{ ...result.attachment, thumbnail }])
    }
  }

  const handleComposerPaste = (event) => {
    const items = Array.from(event.clipboardData?.items || [])
    const images = items
      .filter((item) => item.kind === 'file' && String(item.type || '').startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean)
    if (!images.length) return
    event.preventDefault()
    addPastedImages(images).catch((e) => showError(e?.message || String(e)))
  }

  const handleConversationDragEnter = (event) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDraggingFiles(true)
  }

  const handleConversationDragOver = (event) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleConversationDragLeave = (event) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDraggingFiles(false)
  }

  const handleConversationDrop = (event) => {
    event.preventDefault()
    dragDepthRef.current = 0
    setDraggingFiles(false)
    addDroppedFiles(event.dataTransfer.files).catch((e) => showError(e?.message || String(e)))
  }

  const dropTargetHandlers = {
    onDragEnter: handleConversationDragEnter,
    onDragOver: handleConversationDragOver,
    onDragLeave: handleConversationDragLeave,
    onDrop: handleConversationDrop,
  }

  useEffect(() => {
    const node = composerRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`
  }, [message, selectedId])

  const deliverMessage = useCallback(async (sessionId, prompt, sentAttachments) => {
    const outgoing = sentAttachments.map(({ type, path: filePath, displayName }) => ({
      type,
      path: filePath,
      displayName,
    }))
    const optimisticId = `local-${crypto.randomUUID()}`
    patchSessionState(sessionId, { working: true })
    if (selectedIdRef.current === sessionId) {
      setMessages((items) => [...items, {
        id: optimisticId,
        role: 'user',
        content: prompt,
        attachments: sentAttachments,
        status: 'sending',
        optimistic: true,
      }])
    }
    const result = await api.sendMessage({ sessionId, prompt, attachments: outgoing })
    if (!result.ok) {
      patchSessionState(sessionId, { working: false })
      restoreDraft(sessionId, { message: prompt, attachments: sentAttachments })
      if (selectedIdRef.current === sessionId) {
        setMessages((items) => items.map((item) => (
          item.id === optimisticId ? { ...item, status: 'failed', optimistic: false } : item
        )))
      }
      showError(result.error?.message || 'Could not send the message.')
      return
    }
    if (selectedIdRef.current === sessionId) {
      setMessages((items) => items.map((item) => (
        item.id === optimisticId && item.status === 'sending' ? { ...item, status: 'sent' } : item
      )))
    }
  }, [api, patchSessionState, restoreDraft, showError])

  const drainQueue = useCallback((sessionId) => {
    const queue = queuesRef.current[sessionId]
    if (!queue?.length) return false
    const [next, ...rest] = queue
    writeQueue(sessionId, rest)
    deliverMessage(sessionId, next.prompt, next.attachments)
    return true
  }, [deliverMessage, writeQueue])

  useEffect(() => {
    drainQueueRef.current = drainQueue
  }, [drainQueue])

  const removeQueued = (sessionId, itemId) => {
    writeQueue(sessionId, (items) => items.filter((item) => item.id !== itemId))
  }

  const openResource = (item) => {
    if (item.kind === 'folder' || item.kind === 'file') {
      api.openPath(item.value).then((result) => {
        if (!result?.ok) showError(`Could not open ${item.value}`)
      })
      return
    }
    api.openExternal(item.value)
  }

  const insertResource = (item) => {
    setMessage((current) => {
      const spacer = !current || current.endsWith(' ') || current.endsWith('\n') ? '' : ' '
      return `${current}${spacer}${item.value} `
    })
    composerRef.current?.focus()
  }

  const hideResource = (item) => {
    editResources(selectedId, (edits) => ({
      ...edits,
      hidden: [...new Set([...(edits.hidden || []), item.value])],
      manual: (edits.manual || []).filter((entry) => entry.value !== item.value),
    }))
  }

  const renameResource = (item, label) => {
    const trimmed = label.trim()
    editResources(selectedId, (edits) => {
      const labels = { ...(edits.labels || {}) }
      if (trimmed) labels[item.value] = trimmed
      else delete labels[item.value]
      return { ...edits, labels }
    })
  }

  const addResource = (value, label) => {
    const trimmed = value.trim()
    if (!trimmed) return
    const detail = trimmed.startsWith('/')
      ? classifyPath(trimmed)
      : classifyLink(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
    if (!detail) {
      showError('That does not look like a link or a folder path.')
      return
    }
    const resolved = trimmed.startsWith('/') || trimmed.startsWith('http') ? trimmed : `https://${trimmed}`
    editResources(selectedId, (edits) => ({
      ...edits,
      hidden: (edits.hidden || []).filter((entry) => entry !== resolved),
      manual: [
        ...(edits.manual || []).filter((entry) => entry.value !== resolved),
        { id: resolved, value: resolved, ...detail },
      ],
      labels: label?.trim() ? { ...(edits.labels || {}), [resolved]: label.trim() } : edits.labels,
    }))
    setRailDraft(null)
  }

  const runCommandFromBlock = useCallback((code) => {
    const command = code.trim()
    if (!command || !selectedId) return
    const prompt = `Run this in the terminal and show me the output:\n\n\`\`\`bash\n${command}\n\`\`\``
    setError(null)
    // Queue instead of dropping the command when the session is mid-turn.
    if (sessionState[selectedId]?.working) {
      writeQueue(selectedId, (items) => [...items, {
        id: crypto.randomUUID(),
        prompt,
        attachments: [],
      }])
      return
    }
    deliverMessage(selectedId, prompt, [])
  }, [deliverMessage, selectedId, sessionState, writeQueue])

  const sendMessage = () => {
    const typedPrompt = message.trim()
    if ((!typedPrompt && !attachments.length) || !selectedId) return
    const prompt = typedPrompt || 'Please review the attached file.'
    const sessionId = selectedId
    const sentAttachments = attachments.map((item) => ({
      type: 'file',
      path: item.path,
      displayName: item.displayName,
      thumbnail: item.thumbnail,
    }))
    clearDraft(sessionId)
    setError(null)
    if (working) {
      writeQueue(sessionId, (items) => [...items, {
        id: crypto.randomUUID(),
        prompt,
        attachments: sentAttachments,
      }])
      return
    }
    deliverMessage(sessionId, prompt, sentAttachments)
  }

  const stopSession = async () => {
    if (!selectedId) return
    const result = await api.abortSession(selectedId)
    if (!result.ok) {
      showError(result.error?.message || 'Could not stop this session.')
      return
    }
    writeQueue(selectedId, [])
    patchSessionState(selectedId, { working: false, liveText: '', toolActivity: [], backgroundAgents: [] })
  }

  const forkSession = async (session) => {
    const sourceName = aliases[session.id] || session.title || 'Untitled session'
    const result = await api.forkSession({
      sessionId: session.id,
      name: `${sourceName} copy`,
    })
    if (!result.ok) {
      showError(result.error?.message || 'Could not fork the session.')
      return
    }

    setError(null)
    setSessions((items) => [result.session, ...items])
    const directory = workingDirectoryOf(result.session)
    if (directory) setSelectedProject(directory)
    setMessages([])
    setLoadingSession(true)
    resetScroll()
    setSelectedId(result.session.id)
  }

  const changeModel = async (model) => {
    setSelectedModel(model)
    if (!selectedId) return
    const result = await api.setModel({ sessionId: selectedId, model })
    if (!result.ok) showError(result.error?.message || 'Could not change the model.')
  }

  const deleteSession = async () => {
    const sessionId = sessionToDelete?.id
    if (!sessionId) return
    const result = await api.deleteSession(sessionId)
    if (!result.ok) {
      showError(result.error?.message || 'Could not delete the session.')
      return
    }
    const remaining = sessions.filter((session) => session.id !== sessionId)
    setSessions(remaining)
    setPinnedSessionIds((items) => items.filter((id) => id !== sessionId))
    setPermissions((items) => items.filter((item) => item.sessionId !== sessionId))
    setSessionState((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    delete draftsRef.current[sessionId]
    writeQueue(sessionId, [])
    setDraftAttachmentCounts((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    if (selectedId === sessionId) {
      const fallback = remaining.find((session) => !selectedProject || projectKeyOf(session) === selectedProject)
        || remaining[0]
      messageRef.current = ''
      attachmentsRef.current = []
      setMessage('')
      setAttachments([])
      setMessages([])
      resetScroll()
      setSelectedId(fallback?.id || null)
    }
    setSessionToDelete(null)
  }

  const activePermission = useMemo(() => {
    if (!permissions.length) return null
    return permissions.find((item) => item.sessionId === selectedId) || permissions[0]
  }, [permissions, selectedId])

  const activePermissionSession = useMemo(() => {
    if (!activePermission) return null
    return sessions.find((session) => session.id === activePermission.sessionId) || null
  }, [activePermission, sessions])

  const answerPermission = (approved, forSession = false) => {
    if (!activePermission) return
    api.answerPermission({ requestId: activePermission.requestId, approved, forSession })
    setPermissions((items) => items.filter((item) => item.requestId !== activePermission.requestId))
  }

  const togglePin = (key) => {
    setPinnedPaths((items) => (
      items.includes(key) ? items.filter((item) => item !== key) : [...items, key]
    ))
  }

  const toggleSessionPin = (sessionId) => {
    setPinnedSessionIds((items) => (
      items.includes(sessionId) ? items.filter((id) => id !== sessionId) : [...items, sessionId]
    ))
  }

  const renameSession = (name) => {
    const trimmed = name.trim()
    if (trimmed && selectedId) setAliases((items) => ({ ...items, [selectedId]: trimmed }))
    setEditingSession(false)
  }

  const renameSessionFromList = (sessionId, name) => {
    const trimmed = name.trim()
    if (trimmed) setAliases((items) => ({ ...items, [sessionId]: trimmed }))
    setEditingSessionId(null)
  }

  const sessionIsWorking = (sessionId) => Boolean(sessionState[sessionId]?.working)
  const sessionHasBackgroundAgents = (sessionId) => (sessionState[sessionId]?.backgroundAgents?.length || 0) > 0
  const sessionNeedsAnswer = (sessionId) => permissions.some((item) => item.sessionId === sessionId)

  const openRowMenu = (session, x, y) => {
    const width = 160
    const height = 152
    setRowMenu({
      session,
      x: Math.min(x, window.innerWidth - width - 8),
      y: Math.min(y, window.innerHeight - height - 8),
    })
  }

  const renderSessionRow = (session) => (
    <div
      className={`session-row ${selectedId === session.id ? 'selected' : ''} ${rowMenu?.session.id === session.id ? 'menu-open' : ''}`}
      key={session.id}
      onContextMenu={(event) => {
        event.preventDefault()
        openRowMenu(session, event.clientX, event.clientY)
      }}
    >
      {editingSessionId === session.id ? (
        <div className="session-rename-row">
          <input
            autoFocus
            defaultValue={aliases[session.id] || session.title}
            onBlur={(event) => renameSessionFromList(session.id, event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter') renameSessionFromList(session.id, event.currentTarget.value)
              if (event.key === 'Escape') setEditingSessionId(null)
            }}
          />
        </div>
      ) : (
        <button className="session-main" onClick={() => openSession(session.id)}>
          <span
            className={`session-dot ${sessionHasBackgroundAgents(session.id) ? 'running' : ''}`}
            title={sessionHasBackgroundAgents(session.id) ? 'Background work running' : undefined}
            aria-hidden="true"
          />
          <span className="session-copy">
            <strong>{aliases[session.id] || session.title}</strong>
          </span>
          <span className="session-meta">
            <small>{displayTime(session.updatedAt)}</small>
            {draftAttachmentCounts[session.id] > 0 && session.id !== selectedId && (
              <span
                className="session-draft-badge"
                title={`${draftAttachmentCounts[session.id]} unsent attachment${draftAttachmentCounts[session.id] > 1 ? 's' : ''} waiting in this session`}
              >
                <Paperclip size={9} />{draftAttachmentCounts[session.id]}
              </span>
            )}
            {queues[session.id]?.length > 0 && (
              <span
                className="session-queue-badge"
                title={`${queues[session.id].length} message${queues[session.id].length > 1 ? 's' : ''} queued in this session`}
              >
                {queues[session.id].length} queued
              </span>
            )}
            {sessionIsWorking(session.id) && (
              <span className="status working" title="Working"><span /></span>
            )}
            {!sessionIsWorking(session.id) && sessionNeedsAnswer(session.id) && (
              <span className="status waiting" title="Waiting for you">!</span>
            )}
          </span>
        </button>
      )}
      <div className="session-actions">
        <button
          type="button"
          className="session-more"
          title="Session options"
          aria-label={`Options for ${aliases[session.id] || session.title}`}
          aria-haspopup="menu"
          aria-expanded={rowMenu?.session.id === session.id}
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            openRowMenu(session, rect.right - 160, rect.bottom + 4)
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  )

  return (
    <main
      className={`app-shell ${artifact ? 'with-artifact' : ''} ${resizing ? `resizing resizing-${resizing}` : ''}`}
      style={{ '--sidebar-width': `${sidebarWidth}px`, '--artifact-width': `${artifactWidth}px` }}
    >
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="titlebar">
            <span className="brand"><Sparkles size={15} /> <span>HC Copilot</span></span>
          </div>
          <div className="header-actions">
            <button className="new-button" onClick={() => createSession()} disabled={!ready}>
              <Plus size={15} /> New chat
            </button>
          </div>
        </header>

        <button className="toolkit" onClick={() => setToolkitOpen(true)}>
          <div className="section-title"><span>Toolkit</span><span className="toolkit-open-label">View all</span></div>
          <div className="toolkit-grid">
            <div><span>MCP</span><strong>{capabilities?.mcp?.length ?? '...'}</strong></div>
            <div><span>Agents</span><strong>{capabilities?.agents?.length ?? '...'}</strong></div>
            <div><span>Knowledge</span><strong>{knowledge.length}</strong></div>
            <div><span>Skills</span><strong>{capabilities?.skills?.length ?? '...'}</strong></div>
          </div>
        </button>

        <section
          className={`projects ${projectsCollapsed ? 'collapsed' : ''}`}
          style={projectsCollapsed ? undefined : { height: `${projectsHeight}px` }}
        >
          <div className="section-title">
            <button
              type="button"
              className="section-collapse"
              aria-expanded={!projectsCollapsed}
              title={projectsCollapsed ? 'Show projects' : 'Hide projects'}
              onClick={() => setProjectsCollapsed((value) => !value)}
            >
              {projectsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              <span>Projects</span>
            </button>
            <small>{projects.length}</small>
            <button
              type="button"
              className="section-add"
              onClick={() => createSession({ chooseFolder: true })}
              disabled={!ready}
              title="Add a project by picking a folder"
              aria-label="Add a project by picking a folder"
            >
              <FolderPlus size={13} />
            </button>
          </div>
          {!projectsCollapsed && (
          <div className="projects-scroll">
            <div className="project-row-group">
              <div className={`project-row all-row ${selectedProject === null ? 'active' : ''}`}>
                <button className="project-main" onClick={() => setSelectedProject(null)}>
                  <span className="project-dot all"><Folder size={12} /></span>
                  <span>All</span>
                </button>
                <small>{sessions.length}</small>
              </div>
              {visibleProjects.map((project) => (
                <div
                  className={`project-row ${selectedProject === project.key ? 'active' : ''}`}
                  key={project.key}
                >
                  <button
                    className="project-main"
                    title={project.path}
                    onClick={() => setSelectedProject(selectedProject === project.key ? null : project.key)}
                  >
                    <span className={`project-dot ${project.pinned ? 'pinned' : ''}`} />
                    <span>{project.name}</span>
                  </button>
                  <small>{project.count}</small>
                  <button
                    type="button"
                    className={`row-action ${project.pinned ? 'pinned' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      togglePin(project.key)
                    }}
                    title={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
                    aria-label={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
                  >
                    <Pin size={12} />
                  </button>
                </div>
              ))}
            </div>
            {projects.length > PROJECT_PREVIEW_COUNT && (
              <button className="manage-projects" onClick={() => setShowAllProjects((value) => !value)}>
                {showAllProjects ? 'Show less' : `Show all ${projects.length}`}
              </button>
            )}
            {!projects.length && (
              <p className="project-empty">Start a chat in a folder to see your working folders here.</p>
            )}
          </div>
          )}
        </section>

        {!projectsCollapsed && (
          <div
            className="projects-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the projects list"
            title="Drag to resize, double click to reset"
            onPointerDown={startProjectsResize}
            onDoubleClick={() => setProjectsHeight(PROJECTS_DEFAULT_HEIGHT)}
          >
            <span />
          </div>
        )}

        {backgroundAgents.length > 0 && (
          <section className="background-rail">
            <div className="section-title">
              <span className="background-rail-title">
                <span className="background-pulse" aria-hidden="true" />
                Running now
              </span>
              <small>{backgroundAgents.length}</small>
            </div>
            <div className="background-rail-list">
              {backgroundAgents.map((agent) => {
                const probe = agent.kind === 'shell' ? backgroundProbes[agent.detail] : null
                const percent = typeof probe?.percent === 'number' ? probe.percent : null
                return (
                  <div className="background-item" key={agent.id}>
                    <Ring percent={percent} />
                    <div className="background-item-body">
                      <strong title={agent.name}>{agent.name}</strong>
                      <div className="background-item-meta" key={tick}>
                        {percent === null
                          ? <span>{elapsedLabel(agent.startedAt)}</span>
                          : <span className="background-percent">{percent}%</span>}
                        <span className="background-dot-sep">·</span>
                        <span>
                          {probe?.eta
                            ? `${probe.eta} left`
                            : (percent === null ? 'no progress reported' : elapsedLabel(agent.startedAt))}
                        </span>
                      </div>
                      <div className="background-bar">
                        <span
                          className={percent === null ? 'indeterminate' : ''}
                          style={percent === null ? undefined : { width: `${percent}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <div className="search-box">
          <Search size={14} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setVisibleCount(80)
            }}
            placeholder="Search sessions"
          />
          {query && <button onClick={() => setQuery('')}><X size={12} /></button>}
        </div>

        <div className="session-label"><span>Sessions</span><small>{visibleSessions.length}</small></div>
        <div className="session-list">
          {!!pinnedVisibleSessions.length && (
            <div className="session-group-label"><Pin size={11} /> Pinned</div>
          )}
          {pinnedVisibleSessions.map(renderSessionRow)}
          {!!pinnedVisibleSessions.length && !!displayedRegularSessions.length && (
            <div className="session-group-label">Recent</div>
          )}
          {displayedRegularSessions.map(renderSessionRow)}
          {visibleSessions.length > visibleCount && (
            <button className="load-more" onClick={() => setVisibleCount((count) => count + 80)}>
              Show more sessions
            </button>
          )}
          {ready && !visibleSessions.length && (
            <div className="empty-sessions">
              <Folder size={18} />
              <span>No sessions yet</span>
              <button onClick={() => createSession()}>Start a chat</button>
            </div>
          )}
        </div>

        <footer className="sidebar-footer">
          <div className="account">
            <span className={`connection-dot ${auth?.isAuthenticated ? 'online' : ''}`} />
            <span>{auth?.login || 'Connecting to Copilot'}</span>
          </div>
          <div className="creator-credit">
            <span>Made by Hsuan C and Copilot</span>
            <button onClick={() => api.openGitHub()}>GitHub</button>
          </div>
        </footer>
      </aside>

      <div
        className="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        title="Drag to resize, double click to reset"
        onPointerDown={startSidebarResize}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
      >
        <span />
      </div>

      <section className="workspace">
       <RunCommandContext.Provider value={runCommandFromBlock}>
        <PreviewContext.Provider value={openPreview}>
        <header className="topbar">
          <div className="session-title">
            <span className="session-title-icon"><TerminalSquare size={16} /></span>
            <div>
              {selected ? (
                editingSession ? (
                  <input
                    autoFocus
                    defaultValue={aliases[selected.id] || selected.title}
                    onBlur={(event) => renameSession(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return
                      if (event.key === 'Enter') renameSession(event.currentTarget.value)
                      if (event.key === 'Escape') setEditingSession(false)
                    }}
                  />
                ) : (
                  <div className="session-title-row">
                    <strong title={aliases[selected.id] || selected.title}>
                      {aliases[selected.id] || selected.title}
                    </strong>
                    <div className="session-menu-wrap" onMouseDown={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="session-menu-button"
                        title="Session options"
                        aria-label="Session options"
                        aria-expanded={sessionMenuOpen}
                        onClick={() => setSessionMenuOpen((value) => !value)}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      {sessionMenuOpen && (
                        <div className="session-menu">
                          <button type="button" onClick={() => { setSessionMenuOpen(false); setEditingSession(true) }}>
                            Rename
                          </button>
                          <button type="button" onClick={() => { setSessionMenuOpen(false); toggleSessionPin(selected.id) }}>
                            {pinnedSessionIds.includes(selected.id) ? 'Unpin' : 'Pin'}
                          </button>
                          <button type="button" onClick={() => { setSessionMenuOpen(false); forkSession(selected) }}>
                            Fork this session
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => { setSessionMenuOpen(false); setSessionToDelete(selected) }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              ) : (
                <strong>HC Copilot</strong>
              )}
              <small>
                {selected
                  ? `${projectName(selected)} · ${selectedWorkingDirectory || 'Local session'}`
                  : 'Choose a folder to start'}
              </small>
            </div>
          </div>

          <div className="credit-visibility">
            <label className="model-picker">
              <span>Model</span>
              <select value={selectedModel} onChange={(event) => changeModel(event.target.value)} disabled={!models.length}>
                {models.length
                  ? models.map((model) => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)
                  : <option>Loading models</option>}
              </select>
              <ChevronDown size={13} />
            </label>
            <div className="credit-copy">
              <span>AI credits</span>
              <strong>
                {quotaSnapshot
                  ? `${quotaSnapshot.usedRequests.toLocaleString()} / ${quotaSnapshot.entitlementRequests.toLocaleString()}`
                  : '...'}
              </strong>
              <small>{quotaSnapshot ? `${quotaSnapshot.remainingPercentage.toFixed(1)}% left` : 'Loading usage'}</small>
            </div>
            <div className="credit-ring">
              <svg viewBox="0 0 36 36">
                <path className="ring-bg" d="M18 2.5a15.5 15.5 0 1 1 0 31 15.5 15.5 0 1 1 0-31" />
                <path
                  className="ring-value"
                  pathLength="100"
                  style={{ strokeDasharray: `${quotaSnapshot?.remainingPercentage || 0} 100` }}
                  d="M18 2.5a15.5 15.5 0 1 1 0 31 15.5 15.5 0 1 1 0-31"
                />
              </svg>
            </div>
          </div>
        </header>

        {selected && (resources.length > 0 || railOpen) && (
          <div className={`resource-rail ${railOpen ? 'open' : ''}`}>
            <div className="rail-strip">
              <div className="rail-chips">
                {(railOpen ? [] : resources).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`rail-chip kind-${item.kind}`}
                    onClick={() => openResource(item)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setRailMenu({ item, x: event.clientX, y: event.clientY })
                    }}
                    title={`${item.label} · ${item.value}`}
                  >
                    <span className={`rail-tag kind-${item.kind}`}>{kindLabel(item.kind)}</span>
                  </button>
                ))}
                {railOpen && <span className="rail-heading">Resources in this session</span>}
              </div>
              <button
                type="button"
                className="rail-toggle"
                onClick={() => setRailOpen((value) => !value)}
                aria-expanded={railOpen}
                aria-label={railOpen ? 'Collapse resources' : 'Expand resources'}
              >
                <ChevronDown size={14} />
              </button>
            </div>

            {railOpen && (
              <div className="rail-panel">
                {resources.map((item) => (
                  <div className="rail-group" key={item.id}>
                    <div className="rail-row">
                      <span className={`rail-tag kind-${item.kind}`}>{kindLabel(item.kind)}</span>
                      <button
                        type="button"
                        className="rail-row-label"
                        onClick={() => openResource(item)}
                        title={item.value}
                      >
                        {item.label}
                      </button>
                      <span className="rail-source">{item.source}</span>
                      <button
                        type="button"
                        className="rail-row-action"
                        onClick={() => insertResource(item)}
                        title="Add to your message"
                        aria-label={`Add ${item.label} to your message`}
                      >
                        <Plus size={13} />
                      </button>
                      <button
                        type="button"
                        className="rail-row-action"
                        onClick={(event) => setRailMenu({ item, x: event.clientX, y: event.clientY })}
                        title="More"
                        aria-label={`More options for ${item.label}`}
                      >
                        <MoreHorizontal size={13} />
                      </button>
                    </div>
                    {item.alternates?.map((alternate) => (
                      <div className="rail-row alternate" key={alternate.id}>
                        <span className="rail-tag placeholder" />
                        <button
                          type="button"
                          className="rail-row-label"
                          onClick={() => openResource(alternate)}
                          title={alternate.value}
                        >
                          {alternate.label}
                        </button>
                        <span className="rail-source">{alternate.source}</span>
                        <button
                          type="button"
                          className="rail-row-action"
                          onClick={() => insertResource(alternate)}
                          title="Add to your message"
                          aria-label={`Add ${alternate.label} to your message`}
                        >
                          <Plus size={13} />
                        </button>
                        <button
                          type="button"
                          className="rail-row-action"
                          onClick={(event) => setRailMenu({ item: alternate, x: event.clientX, y: event.clientY })}
                          title="More"
                          aria-label={`More options for ${alternate.label}`}
                        >
                          <MoreHorizontal size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
                {!resources.length && (
                  <p className="rail-empty">Links and folders you mention will show up here.</p>
                )}
                {railDraft === null ? (
                  <button type="button" className="rail-add" onClick={() => setRailDraft('')}>
                    <Plus size={13} /> Add a link or folder
                  </button>
                ) : (
                  <form
                    className="rail-add-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      addResource(railDraft)
                    }}
                  >
                    <input
                      autoFocus
                      value={railDraft}
                      placeholder="Paste a link or /Users/you/folder"
                      onChange={(event) => setRailDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setRailDraft(null)
                      }}
                    />
                    <button type="submit">Add</button>
                    <button type="button" onClick={() => setRailDraft(null)}>Cancel</button>
                  </form>
                )}
              </div>
            )}
          </div>
        )}

        {railMenu && (
          <>
            <div className="row-menu-backdrop" onMouseDown={() => setRailMenu(null)} />
            <div
              className="row-menu"
              style={{
                top: Math.min(railMenu.y + 4, window.innerHeight - 190),
                left: Math.min(railMenu.x, window.innerWidth - 190),
              }}
            >
              <button type="button" onClick={() => { insertResource(railMenu.item); setRailMenu(null) }}>
                Add to your message
              </button>
              <button type="button" onClick={() => { openResource(railMenu.item); setRailMenu(null) }}>
                Open
              </button>
              {(railMenu.item.kind === 'folder' || railMenu.item.kind === 'file') && (
                <button type="button" onClick={() => { api.revealPath(railMenu.item.value); setRailMenu(null) }}>
                  Show in Finder
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const next = window.prompt('Name this resource', railMenu.item.label)
                  if (next !== null) renameResource(railMenu.item, next)
                  setRailMenu(null)
                }}
              >
                Rename
              </button>
              <div className="row-menu-divider" />
              <button
                type="button"
                className="danger"
                onClick={() => { hideResource(railMenu.item); setRailMenu(null) }}
              >
                Remove
              </button>
            </div>
          </>
        )}

        {error && (
          <div className="error-banner">
            <AlertTriangle size={14} />
            <span>{error.message}</span>
            <button onClick={() => setError(null)}><X size={13} /></button>
          </div>
        )}

        <div
          className={`conversation ${draggingFiles ? 'dragging-files' : ''}`}
          ref={conversationRef}
          onScroll={handleConversationScroll}
          {...dropTargetHandlers}
        >
          <div className="conversation-inner">
            {draggingFiles && (
              <div className="drop-overlay">
                <Paperclip size={21} />
                <strong>Drop files to attach</strong>
                <span>They will be included with your next message.</span>
              </div>
            )}
            {loadingSession && (
              <div className="session-loading"><LoaderCircle className="spin" size={15} /> Loading session history</div>
            )}
            {!selected && (
              <div className="welcome">
                <span><Sparkles size={23} /></span>
                <h1>What are you working on?</h1>
                <p>Start a chat right away, or pick a folder so Copilot can work with those files, tools, MCP servers, and skills.</p>
                <div className="welcome-actions">
                  <button onClick={() => createSession()} disabled={!ready}>
                    <Plus size={15} /> New chat
                  </button>
                  <button
                    className="secondary"
                    onClick={() => createSession({ chooseFolder: true })}
                    disabled={!ready}
                  >
                    <Folder size={15} /> Choose a folder
                  </button>
                </div>
              </div>
            )}
  
            {messages.map((item) => (
              <article className={`message ${item.role}`} key={item.id}>
                {item.role !== 'user' && <div className="avatar copilot"><Sparkles size={15} /></div>}
                <div>
                  <div className="speaker">{item.role === 'user' ? 'You' : 'Copilot'}</div>
                  {!!item.attachments?.length && (
                    <div className="message-attachments">
                      {item.attachments.map((attachment) => (
                        <MessageAttachment item={attachment} key={attachment.path} />
                      ))}
                    </div>
                  )}
                  <MessageBody role={item.role} content={item.content} />
                  {item.role === 'user' && (
                    <MessageStatus status={item.status} attachmentCount={item.attachments?.length || 0} />
                  )}
                </div>
              </article>
            ))}
  
            {(liveState.liveText || working) && (
              <article className="message assistant">
                <div className="avatar copilot"><Sparkles size={15} /></div>
                <div>
                  <div className="speaker">Copilot</div>
                  {liveState.liveText
                    ? <MessageBody role="assistant" content={liveState.liveText} />
                    : <div className="thinking"><LoaderCircle className="spin" size={14} /> Working</div>}
                  {!!liveState.toolActivity.length && (
                    <div className="tool-activity">
                      {liveState.toolActivity.map((tool) => (
                        <div key={tool.id}>
                          {tool.status === 'done' ? <Check size={11} /> : <LoaderCircle className="spin" size={11} />}
                          <span>{tool.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            )}
          </div>
        </div>

        {selected && !atBottom && (
          <button className="jump-latest" onClick={jumpToLatest}>
            <ArrowDown size={13} /> Jump to latest
          </button>
        )}

        {selected && (
          <div className="composer-wrap">
            {!!selectedQueue.length && (
              <div className="queue-strip">
                <div className="queue-heading">
                  Queued · sends when this turn finishes
                </div>
                {selectedQueue.map((item, index) => (
                  <div className="queue-item" key={item.id}>
                    <span className="queue-index">{index + 1}</span>
                    <span className="queue-text">{item.prompt}</span>
                    {!!item.attachments.length && (
                      <span className="queue-attach">
                        <Paperclip size={10} />{item.attachments.length}
                      </span>
                    )}
                    <button
                      onClick={() => removeQueued(selectedId, item.id)}
                      aria-label={`Remove queued message ${index + 1}`}
                      title="Remove from queue"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={`composer ${draggingFiles ? 'dragging-files' : ''}`} {...dropTargetHandlers}>
              {!!attachments.length && (
                <div className="attachment-chips">
                  {attachments.map((item) => (
                    <span
                      className={`attachment-chip ${item.thumbnail ? 'with-thumb' : ''}`}
                      key={item.path}
                      title={item.path}
                    >
                      {item.thumbnail
                        ? <img className="attachment-thumb" src={item.thumbnail} alt="" />
                        : <Paperclip size={11} className={isImageName(item.path) ? 'image-file' : ''} />}
                      <span className="attachment-name">{item.displayName || item.path}</span>
                      <button
                        onClick={() => removeAttachment(item.path)}
                        aria-label={`Remove ${item.displayName || item.path}`}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onPaste={handleComposerPaste}
                onCompositionStart={() => { composingRef.current = true }}
                onCompositionEnd={() => {
                  composingRef.current = false
                  compositionEndedAtRef.current = Date.now()
                }}
                onKeyDown={(event) => {
                  if (
                    composingRef.current ||
                    event.nativeEvent.isComposing ||
                    event.keyCode === 229 ||
                    Date.now() - compositionEndedAtRef.current < 250
                  ) return
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    sendMessage()
                  }
                }}
                placeholder={working
                  ? 'Type ahead. Enter adds it to the queue.'
                  : 'Ask Copilot to do anything on your computer...'}
                rows={1}
                ref={composerRef}
              />
            </div>
            <div className="composer-actions">
              <div>
                <button title="Attach file" aria-label="Attach file" onClick={addAttachments}>
                  <Paperclip size={16} />
                </button>
              </div>
              <div className="composer-send-group">
                {working && (
                  <button className="stop" onClick={stopSession} title="Stop" aria-label="Stop">
                    <Square size={12} /> Stop
                  </button>
                )}
                <button
                  className={`send ${working ? 'queueing' : ''}`}
                  onClick={sendMessage}
                  disabled={!message.trim() && !attachments.length}
                  title={working ? 'Add to queue' : 'Send'}
                  aria-label={working ? 'Add to queue' : 'Send'}
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
          </div>
        )}
        </PreviewContext.Provider>
       </RunCommandContext.Provider>
      </section>

      {artifact && (
        <>
          <div
            className="artifact-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the preview panel"
            title="Drag to resize, double click to reset"
            onPointerDown={startArtifactResize}
            onDoubleClick={() => setArtifactWidth(ARTIFACT_DEFAULT_WIDTH)}
          >
            <span />
          </div>
          <ArtifactPanel artifact={artifact} onClose={closePreview} onError={showError} />
        </>
      )}

      {activePermission && (
        <div className="permission-backdrop">
          <div className="permission-dialog">
            <span className="permission-icon"><TerminalSquare size={19} /></span>
            <h2>Allow this action?</h2>
            {activePermissionSession && (
              <p className="permission-session-note">
                {activePermission.sessionId !== selectedId ? 'Another session: ' : ''}
                {aliases[activePermissionSession.id] || activePermissionSession.title}
                {folderLabel(workingDirectoryOf(activePermissionSession))
                  ? ` · ${folderLabel(workingDirectoryOf(activePermissionSession))}`
                  : ''}
              </p>
            )}
            <p>{permissionDescription(activePermission.request)}</p>
            {shellCommandOf(activePermission.request) && (
              <pre className="permission-command">{shellCommandOf(activePermission.request)}</pre>
            )}
            <button
              className="permission-details-toggle"
              onClick={() => setPermissionDetailsFor(
                permissionDetailsFor === activePermission.requestId ? null : activePermission.requestId,
              )}
            >
              {permissionDetailsFor === activePermission.requestId ? 'Hide details' : 'Show details'}
            </button>
            {permissionDetailsFor === activePermission.requestId && (
              <pre>{JSON.stringify(activePermission.request, null, 2)}</pre>
            )}
            <div className="permission-actions">
              <button onClick={() => answerPermission(false)}>Deny</button>
              <button onClick={() => answerPermission(true, true)}>Allow for session</button>
              <button className="primary" onClick={() => answerPermission(true)}>Allow once</button>
            </div>
          </div>
        </div>
      )}

      {toolkitOpen && (
        <div className="toolkit-backdrop" onMouseDown={() => setToolkitOpen(false)}>
          <section className="toolkit-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>Shared capabilities</span>
                <h2>Toolkit</h2>
              </div>
              <button onClick={() => setToolkitOpen(false)} aria-label="Close toolkit"><X size={16} /></button>
            </header>
            <div className="toolkit-details-scroll">
              {[
                ['MCP', capabilities?.mcp],
                ['Agents', capabilities?.agents],
                ['Knowledge', knowledge],
                ['Skills', capabilities?.skills],
              ].map(([label, items]) => (
                <section className="toolkit-group" key={label}>
                  <div><h3>{label}</h3><span>{items?.length || 0}</span></div>
                  <ul>
                    {(items || []).map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </section>
              ))}
            </div>
          </section>
        </div>
      )}

      {rowMenu && (
        <>
          <div className="row-menu-backdrop" onMouseDown={() => setRowMenu(null)} onContextMenu={(event) => { event.preventDefault(); setRowMenu(null) }} />
          <div className="row-menu" role="menu" style={{ left: rowMenu.x, top: rowMenu.y }}>
            <button type="button" role="menuitem" onClick={() => { setRowMenu(null); setEditingSessionId(rowMenu.session.id) }}>
              <PenLine size={13} /> Rename
            </button>
            <button type="button" role="menuitem" onClick={() => { setRowMenu(null); toggleSessionPin(rowMenu.session.id) }}>
              <Pin size={13} /> {pinnedSessionIds.includes(rowMenu.session.id) ? 'Unpin' : 'Pin'}
            </button>
            <button type="button" role="menuitem" onClick={() => { setRowMenu(null); forkSession(rowMenu.session) }}>
              <GitFork size={13} /> Fork this session
            </button>
            <span className="row-menu-divider" />
            <button type="button" role="menuitem" className="danger" onClick={() => { setRowMenu(null); setSessionToDelete(rowMenu.session) }}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </>
      )}

      {sessionToDelete && (
        <div className="permission-backdrop">
          <div className="permission-dialog delete-dialog">
            <span className="permission-icon delete"><Trash2 size={18} /></span>
            <h2>Delete this session?</h2>
            <p>{aliases[sessionToDelete.id] || sessionToDelete.title}</p>
            <div className="permission-actions">
              <button onClick={() => setSessionToDelete(null)}>Cancel</button>
              <button className="danger" onClick={deleteSession}>Delete session</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
