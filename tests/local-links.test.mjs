import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { classifyLinkTarget, missingLocalFileMessage } from '../shared/link-targets.mjs'
import { openLinkTarget } from '../electron/open-link.mjs'

const HOME = '/Users/hsuan.chou'

// The three links from the handover message that started this. Every one of them is an absolute
// POSIX path with percent encoded spaces, which is exactly the shape `new URL()` refused.
const HANDOVER_LINKS = [
  '/Users/hsuan.chou/Documents/my-agent/100_Todo/projects/Customer%20Day%20Claude%20Design.zip',
  '/Users/hsuan.chou/Documents/my-agent/100_Todo/projects/customer-day-review-design-handoff/Claude%20Prompt.md',
  '/Users/hsuan.chou/Documents/my-agent/100_Todo/projects/customer-day-review-design-handoff/README.md',
]

test('the handover links are read as local files with their spaces decoded', () => {
  const decoded = HANDOVER_LINKS.map((href) => classifyLinkTarget(href, { homeDirectory: HOME }))
  assert.deepEqual(decoded.map((item) => item.kind), ['local', 'local', 'local'])
  assert.equal(
    decoded[0].candidates[0],
    '/Users/hsuan.chou/Documents/my-agent/100_Todo/projects/Customer Day Claude Design.zip',
  )
  assert.equal(
    decoded[1].candidates[0],
    '/Users/hsuan.chou/Documents/my-agent/100_Todo/projects/customer-day-review-design-handoff/Claude Prompt.md',
  )
  // The raw spelling is kept as a fallback in case a file really is named with a percent sign.
  assert.ok(decoded[0].candidates.includes(HANDOVER_LINKS[0]))
  assert.equal(decoded[2].candidates.length, 1, 'a path with nothing to decode needs one candidate')
})

test('no local link shape is ever classified as a web link', () => {
  for (const href of [...HANDOVER_LINKS, '~/notes.md', './rel.md', 'docs/a.md', 'file:///tmp/a.md']) {
    const result = classifyLinkTarget(href, { homeDirectory: HOME, workingDirectory: '/w' })
    assert.equal(result.kind, 'local', `${href} should be local, got ${result.kind}`)
  }
})

test('file URLs are decoded, including percent encoding and CJK', () => {
  const result = classifyLinkTarget('file:///Users/a/%E4%B8%AD%E6%96%87%20%E6%AA%94.md')
  assert.equal(result.kind, 'local')
  assert.equal(result.candidates[0], '/Users/a/中文 檔.md')
})

test('a tilde resolves against home and a relative path against the session folder', () => {
  const tilde = classifyLinkTarget('~/Documents/a.md', { homeDirectory: HOME })
  assert.equal(tilde.candidates[0], `${HOME}/Documents/a.md`)

  const relative = classifyLinkTarget('docs/a.md', { workingDirectory: '/Users/hsuan.chou/Projects/x' })
  assert.equal(relative.candidates[0], '/Users/hsuan.chou/Projects/x/docs/a.md')

  const dotted = classifyLinkTarget('./sub/../b.md', { workingDirectory: '/w' })
  assert.equal(dotted.candidates[0], '/w/b.md')
})

test('a relative link with no session folder says so instead of guessing', () => {
  const result = classifyLinkTarget('docs/a.md', { workingDirectory: '' })
  assert.equal(result.kind, 'needs-folder')
  assert.match(result.message, /relative path/)
  // It must never silently resolve against the renderer page or some unrelated cwd.
  assert.equal(result.candidates, undefined)
})

test('a line anchor is stripped but a hash inside a file name is not', () => {
  const anchored = classifyLinkTarget('/Users/a/App.jsx#L120', { homeDirectory: HOME })
  assert.equal(anchored.candidates[0], '/Users/a/App.jsx')
  assert.equal(anchored.lineNumber, 120)

  const ranged = classifyLinkTarget('/Users/a/App.jsx#L10-L20')
  assert.equal(ranged.candidates[0], '/Users/a/App.jsx')

  const hashedName = classifyLinkTarget('/Users/a/notes#2.md')
  assert.equal(hashedName.candidates[0], '/Users/a/notes#2.md')
  assert.equal(hashedName.lineNumber, null)
})

test('web links and in-page anchors keep behaving exactly as before', () => {
  assert.deepEqual(classifyLinkTarget('https://github.com/x'), { kind: 'external', url: 'https://github.com/x' })
  assert.deepEqual(classifyLinkTarget('http://127.0.0.1:8942/?comments=open'), {
    kind: 'external', url: 'http://127.0.0.1:8942/?comments=open',
  })
  assert.equal(classifyLinkTarget('#section').kind, 'anchor')
  assert.equal(classifyLinkTarget('').kind, 'empty')
  assert.equal(classifyLinkTarget(null).kind, 'empty')
  // mailto is left to the main process exactly as it was, not newly opened and not newly blocked.
  assert.deepEqual(classifyLinkTarget('mailto:a@b.c'), { kind: 'external', url: 'mailto:a@b.c' })
})

test('code bearing schemes are refused by name', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'about:blank']) {
    const result = classifyLinkTarget(href)
    assert.equal(result.kind, 'blocked', `${href} must be blocked`)
    assert.match(result.message, /not allowed/)
  }
})

test('opening a local link finds the file whose name really has the spaces', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hc-links-'))
  await mkdir(path.join(root, 'handoff'), { recursive: true })
  const real = path.join(root, 'handoff', 'Claude Prompt.md')
  await writeFile(real, '# prompt', 'utf8')

  const opened = []
  const result = await openLinkTarget(
    { href: `${root}/handoff/Claude%20Prompt.md` },
    { openPath: async (target) => { opened.push(target); return '' }, openExternal: async () => {} },
  )
  assert.deepEqual(result, { ok: true, path: real })
  assert.deepEqual(opened, [real])
})

test('a local link that points nowhere names the path instead of saying Invalid URL', async () => {
  const result = await openLinkTarget(
    { href: '/Users/hsuan.chou/nope/missing%20file.md' },
    { openPath: async () => '', openExternal: async () => {} },
  )
  assert.equal(result.ok, false)
  assert.match(result.error.message, /no file at \/Users\/hsuan\.chou\/nope\/missing file\.md/)
  assert.doesNotMatch(result.error.message, /Invalid URL/)
})

test('a permission error is surfaced, not folded into the missing-file message', async () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  const result = await openLinkTarget(
    { href: '/Users/hsuan.chou/private/secret.md' },
    { openPath: async () => '', openExternal: async () => {} },
    { statFile: async () => { throw denied } },
  )
  assert.equal(result.ok, false)
  assert.match(result.error.message, /permission denied/)
  assert.match(result.error.message, /\/Users\/hsuan\.chou\/private\/secret\.md/)
  assert.doesNotMatch(result.error.message, /no file at/, 'a real error must not read as "missing"')
})

test('a local link never reports success when nothing was opened', async () => {
  let calls = 0
  const result = await openLinkTarget(
    { href: '/definitely/not/here.md' },
    { openPath: async () => { calls += 1; return '' }, openExternal: async () => {} },
  )
  assert.equal(result.ok, false)
  assert.equal(calls, 0, 'a missing file must not be handed to the shell as a success')
})

test('a shell refusal is surfaced rather than swallowed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hc-links-'))
  const real = path.join(root, 'a.md')
  await writeFile(real, 'x', 'utf8')
  const result = await openLinkTarget(
    { href: real },
    { openPath: async () => 'No application knows how to open this.', openExternal: async () => {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.message, 'No application knows how to open this.')
})

test('web links still go to the browser and blocked ones go nowhere', async () => {
  const external = []
  const shell = { openPath: async () => '', openExternal: async (url) => { external.push(url) } }

  assert.deepEqual(await openLinkTarget({ href: 'https://example.com/a' }, shell), { ok: true })
  assert.deepEqual(external, ['https://example.com/a'])

  const blocked = await openLinkTarget({ href: 'javascript:alert(1)' }, shell)
  assert.equal(blocked.ok, false)
  assert.equal(external.length, 1, 'a blocked scheme must not reach the shell')

  const mail = await openLinkTarget({ href: 'mailto:a@b.c' }, shell)
  assert.equal(mail.ok, false)
  assert.match(mail.error.message, /Only web links/)
})

test('a relative link opens against the session folder it was sent with', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hc-links-'))
  await writeFile(path.join(root, 'README.md'), 'x', 'utf8')
  const opened = []
  const result = await openLinkTarget(
    { href: 'README.md', workingDirectory: root },
    { openPath: async (target) => { opened.push(target); return '' }, openExternal: async () => {} },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(opened, [path.join(root, 'README.md')])

  const stranded = await openLinkTarget(
    { href: 'README.md', workingDirectory: '' },
    { openPath: async () => '', openExternal: async () => {} },
  )
  assert.equal(stranded.ok, false)
  assert.match(stranded.error.message, /relative path/)
})

test('missingLocalFileMessage lists the other spelling it tried', () => {
  const message = missingLocalFileMessage({ display: 'a', candidates: ['/a b.md', '/a%20b.md'] })
  assert.match(message, /no file at \/a b\.md/)
  assert.match(message, /also tried \/a%20b\.md/)
})

// The renderer half: these guard the wiring that actually made the links dead on screen.
const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')

test('markdown links go through the link bridge, not the web only one', () => {
  assert.match(appSource, /openLink\(/, 'the renderer must call the link bridge')
  assert.ok(
    !/function openExternalLink\(event, href\)[\s\S]*?copilot\?\.openExternal\(href\)/.test(appSource),
    'markdown hrefs must no longer be pushed straight at openExternal',
  )
})

test('the markdown url transform keeps file links instead of blanking them', () => {
  assert.match(appSource, /urlTransform=\{markdownUrlTransform\}/)
  assert.match(appSource, /defaultUrlTransform/, 'the default security transform must still run')
})
