// Markdown written by the agent links to real things on this machine far more often than it links
// to the web: a handover ZIP, a README it just wrote, a file inside the session folder. Those
// hrefs are plain POSIX paths, so handing them straight to `new URL()` threw "Invalid URL" and
// every local link in the app looked broken. Deciding what a link means is done here, once, so the
// renderer and the main process cannot disagree about it.

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/
const WEB_SCHEMES = new Set(['http:', 'https:'])
// Schemes that can run code or smuggle a payload. A link in a transcript is untrusted text.
const BLOCKED_SCHEMES = new Set([
  'javascript:', 'data:', 'vbscript:', 'blob:', 'about:', 'chrome:', 'devtools:', 'filesystem:',
])
// Only a real line reference is stripped off a path. A plain "#" is legal in a file name, so
// "notes#2.md" keeps its hash and only "notes.md#L12" loses one.
const LINE_ANCHOR = /#L(\d+)(?:-L?\d+)?$/

function decodeIfPossible(value) {
  if (!value.includes('%')) return value
  try {
    const decoded = decodeURIComponent(value)
    return decoded === value ? value : decoded
  } catch {
    // A literal percent in a file name is not an encoding error, it is just a file name.
    return value
  }
}

function normalizePosix(input) {
  const absolute = input.startsWith('/')
  const parts = []
  for (const part of input.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  if (absolute) return `/${joined}`
  return joined || '.'
}

function expandHome(input, homeDirectory) {
  if (!homeDirectory) return input
  if (input === '~') return homeDirectory
  if (input.startsWith('~/')) return `${homeDirectory}/${input.slice(2)}`.replace(/\/+/g, '/')
  return input
}

function pathFromFileUrl(href) {
  // `new URL` is safe here because the scheme is already known to be file:, and it is the only
  // thing that gets the host and percent decoding of a file URL right.
  try {
    const url = new URL(href)
    if (url.hostname && url.hostname !== 'localhost') return null
    return decodeURIComponent(url.pathname)
  } catch {
    return null
  }
}

// Both the decoded and the raw spelling are offered because only the file system can say which one
// the author meant: "Customer%20Day.zip" is almost always a space, but it could be the name.
function candidatesFor(rawPath, { workingDirectory = '', homeDirectory = '' } = {}) {
  const spellings = [decodeIfPossible(rawPath), rawPath]
  const out = []
  for (const spelling of spellings) {
    if (!spelling) continue
    const expanded = expandHome(spelling, homeDirectory)
    if (!expanded.startsWith('/')) continue
    const normalized = normalizePosix(expanded)
    if (!out.includes(normalized)) out.push(normalized)
  }
  if (out.length) return { candidates: out, relative: false }
  // Nothing was absolute, so this is relative and only means something inside a session folder.
  if (!workingDirectory) return { candidates: [], relative: true }
  for (const spelling of spellings) {
    if (!spelling) continue
    const normalized = normalizePosix(`${workingDirectory}/${spelling}`)
    if (!out.includes(normalized)) out.push(normalized)
  }
  return { candidates: out, relative: true }
}

export function classifyLinkTarget(href, options = {}) {
  const raw = typeof href === 'string' ? href.trim() : ''
  if (!raw) return { kind: 'empty' }
  // In-page jumps are the browser's job and were never broken.
  if (raw.startsWith('#')) return { kind: 'anchor' }

  const scheme = (SCHEME.exec(raw)?.[1] || '').toLowerCase()
  const protocol = scheme ? `${scheme}:` : ''
  if (BLOCKED_SCHEMES.has(protocol)) {
    return { kind: 'blocked', protocol, message: `${protocol} links are not allowed.` }
  }
  if (WEB_SCHEMES.has(protocol)) return { kind: 'external', url: raw }
  if (protocol === 'file:') {
    const filePath = pathFromFileUrl(raw)
    if (!filePath) return { kind: 'blocked', protocol, message: 'That file link could not be read.' }
    const { candidates } = candidatesFor(filePath, options)
    return { kind: 'local', candidates, display: filePath, relative: false }
  }
  // Anything else with a scheme is left to the main process, which keeps the final say on what it
  // will hand to the shell. mailto: and the like are unchanged by this module.
  if (protocol) return { kind: 'external', url: raw }
  // A bare domain in prose is a web link, not a file next to the session folder.
  if (/^www\.[^/\s]+\./i.test(raw)) return { kind: 'external', url: `https://${raw}` }

  const lineMatch = LINE_ANCHOR.exec(raw)
  const withoutAnchor = lineMatch ? raw.slice(0, lineMatch.index) : raw
  const lineNumber = lineMatch ? Number(lineMatch[1]) : null
  const { candidates, relative } = candidatesFor(withoutAnchor, options)
  if (relative && !candidates.length) {
    return {
      kind: 'needs-folder',
      display: withoutAnchor,
      message: `"${withoutAnchor}" is a relative path and this chat has no folder, so there is nothing to resolve it against.`,
    }
  }
  return { kind: 'local', candidates, display: withoutAnchor, relative, lineNumber }
}

export function missingLocalFileMessage(result) {
  const tried = result?.candidates || []
  if (!tried.length) return `Could not work out where "${result?.display || ''}" points.`
  if (tried.length === 1) return `There is no file at ${tried[0]}.`
  return `There is no file at ${tried[0]} (also tried ${tried.slice(1).join(', ')}).`
}
