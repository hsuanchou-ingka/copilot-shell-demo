import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import DemoTour from './demo-tour.jsx'

// A standalone harness that renders the real interface against fabricated data.
// It backs both the README screenshots and the public web demo on GitHub Pages.
// Pick a state with ?scene=. Add ?shot=1 to get the fixed 1420x920 window the
// screenshots are captured from; without it the window scales to fit the browser.

const WORKSPACE = '/Users/demo/work'
const SESSION_ID = 's1'

const params = new URLSearchParams(window.location.search)
const SHOT = params.get('shot') === '1'
const requestedScene = params.get('scene')
// The public demo has no ?scene= in its URL, so it defaults to a state that shows
// the sidebar, the conversation, the plan panel and a queued message all at once.
// Screenshot capturing always passes an explicit scene, so its old default of
// "overview" is kept for that case.
const scene = requestedScene || (SHOT ? 'overview' : 'tour')

document.body.classList.add(SHOT ? 'shot' : 'web')

if (!SHOT) {
  const STAGE_WIDTH = 1420
  const STAGE_HEIGHT = 920
  const VIEWPORT_MARGIN = 24
  function fitStage() {
    const availableWidth = window.innerWidth - VIEWPORT_MARGIN * 2
    const availableHeight = window.innerHeight - VIEWPORT_MARGIN * 2
    const scaleToFit = Math.min(availableWidth / STAGE_WIDTH, availableHeight / STAGE_HEIGHT)
    document.documentElement.style.setProperty('--stage-scale', String(Math.max(scaleToFit, 0.2)))
  }
  fitStage()
  window.addEventListener('resize', fitStage)
}

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

const SESSIONS = [
  { id: SESSION_ID, title: 'Design system tokens', updatedAt: iso(2), context: { workingDirectory: `${WORKSPACE}/design-system` } },
  { id: 's2', title: 'Onboarding copy pass', updatedAt: iso(14), context: { workingDirectory: `${WORKSPACE}/onboarding` } },
  { id: 's3', title: 'Release notes 4.2', updatedAt: iso(48), context: { workingDirectory: `${WORKSPACE}/docs` } },
  { id: 's4', title: 'Icon export script', updatedAt: iso(96), context: { workingDirectory: `${WORKSPACE}/design-system` } },
  { id: 's5', title: 'Survey data cleanup', updatedAt: iso(180), context: { workingDirectory: `${WORKSPACE}/research` } },
  { id: 's6', title: 'Accessibility audit', updatedAt: iso(320), context: { workingDirectory: `${WORKSPACE}/onboarding` } },
]

const ANSWER = [
  'Three colour tokens changed since the last export.',
  '',
  '| Token | Was | Now |',
  '| --- | --- | --- |',
  '| `surface/raised` | `#FFFFFF` | `#FDFCFA` |',
  '| `text/muted` | `#6B6B6B` | `#75716A` |',
  '| `border/subtle` | `#E5E5E5` | `#E0DDD6` |',
  '',
  'The first two came from the warm neutral pass in https://github.com/acme/design-system/pull/412. The third looks unintentional: it was edited straight in Figma without a matching change in /Users/demo/work/design-system/tokens/colour.json.',
  '',
  'The naming rules in https://www.notion.so/Token-Naming-Rules-1a2b3c4d5e6f7890abcdef1234567890 say semantic tokens should only move through a pull request, so I would treat `border/subtle` as the one to question.',
].join('\n')

const EVENTS = [
  {
    id: 'e1',
    type: 'user.message',
    data: { content: 'The token export drifted again. Compare it against the Figma library at https://www.figma.com/file/aB3dE5fG/Design-System-Tokens and tell me what moved.' },
  },
  { id: 'e2', type: 'assistant.message', data: { content: ANSWER } },
  { id: 'e3', type: 'user.message', data: { content: 'Revert that one and open a PR against the design system repo.' } },
]

const MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', billing: { tokenPrices: { inputPrice: 500, outputPrice: 2500 } } },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', billing: { tokenPrices: { inputPrice: 300, outputPrice: 1500 } } },
  { id: 'auto', name: 'Auto', billing: { discountPercent: 10 } },
]

let emit = null
let ask = null

const noop = () => () => {}
const ok = (extra = {}) => Promise.resolve({ ok: true, ...extra })

// Background agents come from the runtime task registry, so scenes set this to stage them.
let mockTasks = []
let mockTodos = []

window.copilot = {
  initialize: () => ok({
    auth: { login: 'demo-user' },
    models: MODELS,
    sessions: SESSIONS,
    quota: { premium_interactions: { usedRequests: 18420, entitlementRequests: 50000, remainingPercentage: 63.2 } },
    capabilities: {
      mcp: ['figma', 'notion', 'playwright', 'filesystem'],
      agents: ['explore', 'worker', 'reviewer', 'errand'],
      knowledge: ['Brand guidelines', 'Token naming rules'],
      skills: new Array(86).fill('skill'),
    },
  }),
  openSession: () => ok({ events: EVENTS, currentModel: { modelId: 'claude-opus-5' } }),
  listCommands: () => ok({ commands: [] }),
  listTasks: () => ok({ tasks: mockTasks }),
  readTodos: () => ok({ todos: mockTodos }),
  instructionFiles: () => ok({ files: [{ label: 'AGENTS.md' }, { label: 'Brand guidelines' }, { label: 'Token naming rules' }] }),
  refreshQuota: () => ok({ quota: null }),
  probeBackground: () => ok({
    report: {
      icons: { shellId: 'icons', percent: 62, eta: '40s', finished: false, line: '62%|████████  | 124/200 [00:38<00:40, 1.9it/s]' },
      contrast: { shellId: 'contrast', percent: null, finished: false, line: 'checking components/navigation/rail.tsx' },
    },
  }),
  createSession: () => ok(),
  forkSession: () => ok(),
  sendMessage: () => new Promise(() => {}),
  invokeCommand: () => ok(),
  abortSession: () => ok(),
  pickAttachments: () => ok({ files: [] }),
  savePastedImage: () => ok(),
  readAttachmentPreview: () => ok(),
  openPreviewInBrowser: () => ok(),
  savePreviewHtml: () => ok(),
  getPathForFile: () => '',
  setModel: () => ok(),
  deleteSession: () => ok(),
  openExternal: () => ok(),
  openPath: () => ok(),
  revealPath: () => ok(),
  openGitHub: () => ok(),
  answerPermission: () => {},
  onEvent: (handler) => {
    emit = (event) => handler({ sessionId: SESSION_ID, event })
    return () => {}
  },
  onPermission: (handler) => {
    ask = handler
    return () => {}
  },
  onSessionMetadata: noop,
  onCommand: noop,
}

window.localStorage.clear()

function tool(id, name, command, running = true) {
  return {
    type: running ? 'tool.execution_start' : 'tool.execution_complete',
    data: { toolCallId: id, toolName: name, arguments: { command, description: command } },
  }
}

function typeInto(element, text) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(element, text)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressEnter(element) {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
}

function startWork() {
  emit(tool('t1', 'read', 'read tokens/colour.json'))
  emit(tool('t1', 'read', 'read tokens/colour.json', false))
  emit(tool('t2', 'bash', 'git diff --stat tokens/'))
  emit(tool('t2', 'bash', 'git diff --stat tokens/', false))
  emit(tool('t3', 'write', 'write tokens/colour.json'))
  emit({
    type: 'assistant.message_delta',
    data: { deltaContent: 'Reverting `border/subtle` to `#E5E5E5`, then opening a pull request against the design system repo' },
  })
}

const SCENES = {
  overview() {},

  working() {
    startWork()
  },

  queue() {
    startWork()
    const box = document.querySelector('.composer textarea')
    if (!box) return
    typeInto(box, 'Then update the changelog entry for 4.2')
    pressEnter(box)
    typeInto(box, 'And check whether any component still hardcodes the old grey')
    pressEnter(box)
    typeInto(box, 'Draft the PR description when you get there')
  },

  resources() {
    document.querySelector('.rail-toggle')?.click()
  },

  plan() {
    mockTodos = [
      { id: 'a', title: 'Audit every icon that still ships at a single scale', status: 'done' },
      { id: 'b', title: 'Agree the export naming with the platform team', status: 'done' },
      { id: 'c', title: 'Add the missing 2x and 3x artboards', status: 'done' },
      { id: 'd', title: 'Wire the export panel to the new naming rules', status: 'in_progress' },
      { id: 'e', title: 'Replace the hardcoded greys in the navigation rail', status: 'pending' },
      { id: 'f', title: 'Check contrast on the dark surfaces', status: 'pending' },
      { id: 'g', title: 'Write the handoff note for engineering', status: 'pending' },
      { id: 'h', title: 'Open the pull request against the design system', status: 'pending' },
    ]
    startWork()
    // The app re-reads the plan on the runtime's signal, so the scene has to send it.
    emit({ type: 'session.todos_changed', data: {} })
  },

  planOpen() {
    SCENES.plan()
    window.setTimeout(() => document.querySelector('.plan-hud-head')?.click(), 500)
  },

  // Sending without emitting a reply leaves the turn open with nothing streamed yet, which is
  // the state this is about. The quiet styling needs ninety seconds of silence to arrive on its
  // own, so for a still image it is dressed on the live element rather than waited for.
  quiet() {
    const box = document.querySelector('.composer textarea')
    typeInto(box, 'Check every semantic token against the naming rules')
    pressEnter(box)
    window.setTimeout(() => {
      const node = document.querySelector('.thinking')
      if (!node) return
      node.classList.add('quiet')
      node.firstChild.nextSibling.textContent = 'Working, quiet for 2m 30s'
    }, 700)
  },

  // A turn in flight, counting.
  running() {
    const box = document.querySelector('.composer textarea')
    typeInto(box, 'Check every semantic token against the naming rules')
    pressEnter(box)
  },

  // The same turn once it has ended.
  settled() {
    const box = document.querySelector('.composer textarea')
    typeInto(box, 'Check every semantic token against the naming rules')
    pressEnter(box)
    window.setTimeout(() => emit({ type: 'session.idle', data: {} }), 900)
  },

  // A turn the user cut short. It must not read back as finished work.
  stopped() {
    const box = document.querySelector('.composer textarea')
    typeInto(box, 'Check every semantic token against the naming rules')
    pressEnter(box)
    window.setTimeout(() => {
      const stop = [...document.querySelectorAll('button')]
        .find((node) => node.textContent.trim().startsWith('Stop'))
      if (stop) stop.click()
    }, 900)
  },

  // What it looks like in the ordinary case, where a reply arrives and then the turn ends.
  settledAfterReply() {
    const box = document.querySelector('.composer textarea')
    typeInto(box, 'Check every semantic token against the naming rules')
    pressEnter(box)
    window.setTimeout(() => {
      startWork()
      emit({
        type: 'assistant.message',
        data: { content: 'Reverting `border/subtle` to `#E5E5E5`, then opening a pull request against the design system repo.' },
      })
      emit({ type: 'session.idle', data: {} })
    }, 900)
  },

  permission() {
    ask({
      requestId: 'r1',
      sessionId: SESSION_ID,
      request: {
        kind: 'shell',
        intention: 'Copilot wants to open a pull request against the design system repo.',
        fullCommandText: 'gh pr create --title "Revert border/subtle to #E5E5E5" \\\n  --body-file .github/pr-body.md \\\n  --base main',
      },
    })
  },

  artifact() {
    emit({
      type: 'assistant.message',
      data: {
        content: [
          'Here is the swatch sheet with the reverted value in place.',
          '',
          '```html',
          '<!doctype html>',
          '<html><head><meta charset="utf-8"><style>',
          '  body { margin: 0; padding: 26px; font: 13px/1.5 ui-sans-serif, system-ui; background: #fbfaf8; color: #1c1b19 }',
          '  h1 { margin: 0 0 4px; font-size: 15px; letter-spacing: -0.01em }',
          '  p { margin: 0 0 20px; color: #75716a }',
          '  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px }',
          '  li { display: flex; align-items: center; gap: 12px }',
          '  i { width: 46px; height: 46px; border-radius: 9px; border: 1px solid #e0ddd6 }',
          '  b { display: block; font-size: 12.5px }',
          '  small { color: #75716a; font-family: ui-monospace, monospace }',
          '</style></head><body>',
          '  <h1>Surface and border</h1>',
          '  <p>Rebuilt after the revert.</p>',
          '  <ul>',
          '    <li><i style="background:#FDFCFA"></i><span><b>surface/raised</b><small>#FDFCFA</small></span></li>',
          '    <li><i style="background:#75716A"></i><span><b>text/muted</b><small>#75716A</small></span></li>',
          '    <li><i style="background:#E5E5E5"></i><span><b>border/subtle</b><small>#E5E5E5</small></span></li>',
          '  </ul>',
          '</body></html>',
          '```',
        ].join('\n'),
      },
    })
    window.setTimeout(() => {
      const buttons = document.querySelectorAll('.code-preview')
      buttons[buttons.length - 1]?.click()
    }, 200)
  },

  // The state the public web demo opens on: a plan in progress, a reply already in
  // the conversation, and a second message left typed in the composer, so every
  // region the guided tour points at has something in it from the start.
  tour() {
    SCENES.plan()
    const box = document.querySelector('.composer textarea')
    if (!box) return
    typeInto(box, 'Then update the changelog entry for 4.2')
    pressEnter(box)
    typeInto(box, 'And check whether any component still hardcodes the old grey')
  },

  background() {
    emit({
      type: 'tool.execution_start',
      data: { toolCallId: 'bg1', toolName: 'bash', arguments: { command: 'Export every icon at three scales', description: 'Export every icon at three scales' } },
    })
    emit({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'bg1',
        toolName: 'bash',
        result: { content: '<command started in detached background with shellId: icons>' },
      },
    })
    emit({
      type: 'tool.execution_start',
      data: { toolCallId: 'bg2', toolName: 'bash', arguments: { command: 'Run the contrast checker', description: 'Run the contrast checker' } },
    })
    emit({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'bg2',
        toolName: 'bash',
        result: { content: '<command started in detached background with shellId: contrast>' },
      },
    })
    mockTasks = [{
      id: 'task-1',
      type: 'agent',
      name: 'Audit the empty states',
      intent: 'Reading components/states/empty.tsx',
      startedAt: Date.now() - 48000,
    }]
    startWork()
  },
}

function whenReady(run) {
  const timer = window.setInterval(() => {
    if (!document.querySelector('.composer textarea')) return
    window.clearInterval(timer)
    window.setTimeout(run, 150)
  }, 40)
}

createRoot(document.getElementById('root')).render(<App />)

whenReady(() => {
  try {
    SCENES[scene]?.()
  } catch (error) {
    console.error('scene failed', error)
  }
})

if (!SHOT) {
  // The tour is mounted on its own root outside #stage, so its fixed position
  // elements are measured in real viewport coordinates rather than being caught
  // by the CSS transform that scales the stage to fit the window.
  const tourHost = document.createElement('div')
  tourHost.id = 'demo-tour-host'
  document.body.appendChild(tourHost)
  createRoot(tourHost).render(<DemoTour />)
}
