import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  isMainConversationEvent,
  isSubagentLifecycleEvent,
  isSubagentTranscriptEvent,
  subagentIdOf,
} from '../shared/agent-events.mjs'
import {
  STREAM_DELTA_TYPES,
  applySessionPatch,
  applyStreamChunk,
  createStreamBuffer,
  toolArgumentDetail,
} from '../src/live-stream.mjs'

const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const mainSource = await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8')

// Shapes copied from a real transcript on disk. The main conversation's events carry no
// agentId at all; everything a delegated agent produces carries the child's id. The subagent
// lifecycle events carry that same id even though the root turn is what created them.
const CHILD = 'c999e067-1633-4cbb-89b2-3e10ae0cd670'
const SESSION = 'session-under-test'

const realUserMessage = {
  type: 'user.message',
  id: 'user-1',
  timestamp: '2026-10-07T12:00:00.000Z',
  data: { content: 'Please review the release notes and tell me what is missing.', parentAgentTaskId: null },
}
const rootAssistantMessage = {
  type: 'assistant.message',
  id: 'assistant-1',
  timestamp: '2026-10-07T12:00:05.000Z',
  data: { content: 'Here is what I found in the release notes.' },
}
const subagentPrompt = {
  type: 'user.message',
  id: 'subagent-prompt-1',
  agentId: CHILD,
  timestamp: '2026-10-07T12:00:06.000Z',
  data: {
    content: 'Own this entire scope; parent will not operate on these files while you work.',
    source: `agent-${SESSION}`,
    parentAgentTaskId: 'word-module-cleanup',
  },
}
const subagentReply = {
  type: 'assistant.message',
  id: 'subagent-reply-1',
  agentId: CHILD,
  timestamp: '2026-10-07T12:00:30.000Z',
  data: { content: 'Done. I rewrote the word module and verified the tests.' },
}
const subagentStarted = {
  type: 'subagent.started',
  id: 'subagent-started-1',
  agentId: CHILD,
  timestamp: '2026-10-07T12:00:06.000Z',
  data: { toolCallId: 'call-1', agentName: 'worker', agentType: 'worker', executionMode: 'background' },
}
const subagentCompleted = {
  type: 'subagent.completed',
  id: 'subagent-completed-1',
  agentId: CHILD,
  timestamp: '2026-10-07T12:05:00.000Z',
  data: { toolCallId: 'call-1', agentName: 'worker', durationMs: 294000 },
}

test('a delegated agent is told apart from the main conversation by its agentId', () => {
  assert.equal(subagentIdOf(realUserMessage), '')
  assert.equal(subagentIdOf(subagentPrompt), CHILD)

  assert.equal(isSubagentTranscriptEvent(realUserMessage), false)
  assert.equal(isSubagentTranscriptEvent(rootAssistantMessage), false)
  assert.equal(isSubagentTranscriptEvent(subagentPrompt), true)
  assert.equal(isSubagentTranscriptEvent(subagentReply), true)

  // Lifecycle events carry the child's id too, and the background panel needs them.
  assert.equal(isSubagentLifecycleEvent(subagentStarted), true)
  assert.equal(isSubagentTranscriptEvent(subagentStarted), false)
  assert.equal(isMainConversationEvent(subagentStarted), true)
  assert.equal(isMainConversationEvent(subagentCompleted), true)

  // Compaction is a session-level event and must never be mistaken for delegated work.
  assert.equal(isSubagentTranscriptEvent({ type: 'session.compaction_start', data: {} }), false)
  assert.equal(isSubagentTranscriptEvent({ type: 'session.compaction_complete', data: {} }), false)
})

test('history leaves out delegated work and keeps the English message the user typed', async () => {
  const messagesFromEvents = await loadMessagesFromEvents()
  const history = messagesFromEvents([
    { type: 'session.start', data: {} },
    realUserMessage,
    subagentStarted,
    subagentPrompt,
    subagentReply,
    subagentCompleted,
    rootAssistantMessage,
  ])

  assert.deepEqual(history.map((item) => item.id), ['user-1', 'assistant-1'])
  assert.equal(history[0].role, 'user')
  assert.match(history[0].content, /release notes/)
  assert.equal(history.some((item) => /Own this entire scope/.test(item.content)), false)
})

test('live delegated events never speak as the user, end the turn or drain the queue', async () => {
  const run = await loadLiveHandler()

  // A real user message and a real reply still land.
  let scene = run([realUserMessage, rootAssistantMessage])
  assert.deepEqual(scene.messages.map((item) => item.role), ['user', 'assistant'])

  // Everything a delegated agent says stays out of the transcript and out of the live line.
  scene = run([
    subagentStarted,
    subagentPrompt,
    { type: 'assistant.message_delta', agentId: CHILD, data: { deltaContent: 'child thinking' } },
    subagentReply,
  ])
  assert.deepEqual(scene.messages, [])
  assert.equal(scene.state.liveText, '')
  assert.equal(scene.state.working, undefined)

  // A delegated tool run does not fill the main conversation's tool strip.
  scene = run([{
    type: 'tool.execution_start',
    agentId: CHILD,
    data: { toolCallId: 'child-tool', toolName: 'bash' },
  }])
  assert.deepEqual(scene.state.toolActivity, [])

  // The child finishing is not the main turn finishing: the queue must not be released.
  scene = run([
    { type: 'user.message', id: 'u2', data: { content: 'Start the cleanup please.' } },
    { type: 'assistant.idle', agentId: CHILD, data: {} },
    { type: 'session.idle', agentId: CHILD, data: {} },
  ], { working: true })
  assert.equal(scene.drained, 0)
  assert.equal(scene.state.working, true)

  // The main turn ending still releases it exactly once.
  scene = run([{ type: 'session.idle', data: {} }], { working: true })
  assert.equal(scene.drained, 1)

  // A delegated failure is the child's problem, not an error banner on the main chat.
  scene = run([{ type: 'session.error', agentId: CHILD, data: { message: 'child failed' } }], { working: true })
  assert.deepEqual(scene.errors, [])
  assert.equal(scene.state.working, true)
  scene = run([{ type: 'session.error', data: { message: 'the session failed' } }], { working: true })
  assert.deepEqual(scene.errors, ['the session failed'])
})

test('the background panel still sees delegated work and its lifecycle', async () => {
  const run = await loadLiveHandler()
  const scene = run([
    subagentStarted,
    {
      type: 'tool.execution_start',
      agentId: CHILD,
      data: { toolCallId: 'child-shell', toolName: 'bash', arguments: { description: 'Long build' } },
    },
    {
      type: 'tool.execution_complete',
      agentId: CHILD,
      data: { toolCallId: 'child-shell', result: { content: '<command started in detached background with shellId: build-1>' } },
    },
  ])
  assert.equal(scene.state.agentHint, 'call-1')
  assert.deepEqual(scene.state.backgroundAgents.map((item) => item.id), ['shell:build-1'])
})

test('the transcript read that settles a running turn ignores delegated turns', async () => {
  const sessionBusy = loadSessionBusy()

  // Main asked, main answered, then a background child kept working. The main turn is over.
  const settled = await sessionBusy([
    { type: 'session.start', data: {} },
    realUserMessage,
    { type: 'assistant.turn_start', data: {} },
    { type: 'assistant.turn_end', data: {} },
    subagentPrompt,
    { type: 'assistant.turn_start', agentId: CHILD, data: {} },
  ])
  assert.deepEqual(settled, { ok: true, busy: false })

  // A main turn that is genuinely open still reads as busy.
  const busy = await sessionBusy([
    { type: 'session.start', data: {} },
    realUserMessage,
    { type: 'assistant.turn_start', data: {} },
    { type: 'assistant.turn_end', agentId: CHILD, data: {} },
  ])
  assert.deepEqual(busy, { ok: true, busy: true })
})

// Pulls the transcript builder and its helpers straight out of App.jsx so the test exercises
// the shipped code rather than a copy of it.
async function loadMessagesFromEvents() {
  const source = sectionBetween(appSource, 'const SKILL_PREAMBLE_RE', '\nfunction mergeMessage')
  const build = new Function(
    'isMainConversationEvent',
    `${source}\nreturn messagesFromEvents`,
  )
  return build(isMainConversationEvent)
}

// Same for the live event handler, which is an inline callback and cannot be imported.
async function loadLiveHandler() {
  const body = sectionBetween(
    appSource,
    '    const unsubscribeEvents = api.onEvent(({ sessionId, event }) => {',
    '\n    const unsubscribePermission',
  )
  const inner = body.slice(body.indexOf('{', body.indexOf('=>')) + 1, body.lastIndexOf('})'))
  const foldSource = sectionBetween(appSource, 'function foldBackgroundActivity(state, event)', '\n// Ceiling for a non-detached')
  const helperSource = sectionBetween(appSource, 'const SHELL_STARTED_RE', '\n// Folds one event')
  const constantsSource = sectionBetween(appSource, 'const TURN_END_EVENTS = new Set', '\n// A turn that has gone this long')
  const contentSource = sectionBetween(appSource, 'const SKILL_PREAMBLE_RE', '\nfunction mergeMessage')

  return (events, initialState = {}) => {
    const scene = {
      messages: [],
      errors: [],
      drained: 0,
      state: { liveText: '', toolActivity: [], pendingTools: {}, backgroundAgents: [], ...initialState },
    }
    const patchSessionState = (id, patch) => {
      scene.state = applySessionPatch({ [id]: scene.state }, id, patch, scene.state)[id]
    }
    // The app releases streamed text once per frame. Here it is released at once, which keeps
    // each run synchronous while still going through the real buffer.
    const streamBuffer = createStreamBuffer({
      schedule: (run) => { run(); return 0 },
      cancel: () => {},
      apply: (id, chunk) => patchSessionState(id, (current) => applyStreamChunk(current, chunk)),
    })
    const handler = new Function(
      'sessionId', 'event', 'selectedIdRef', 'lastEventAtRef',
      'turnEndedAtRef', 'beginPlanTurnForSession', 'markPlanChangedForSession', 'setPlanRevision',
      'patchSessionState', 'setMessages', 'crypto',
      'finishPlanTurnForSession', 'drainQueueRef', 'quotaRefreshRef', 'showError',
      'isMainConversationEvent', 'streamBuffer', 'STREAM_DELTA_TYPES', 'toolArgumentDetail',
      [contentSource, helperSource, foldSource, constantsSource, mergeMessageSource(), inner].join('\n'),
    )
    const turnEndedAtRef = { current: {} }
    for (const event of events) {
      handler(
        SESSION, event, { current: SESSION }, { current: {} },
        turnEndedAtRef, () => {}, () => {}, () => {},
        patchSessionState, (updater) => { scene.messages = updater(scene.messages) }, { randomUUID: () => 'generated' },
        () => {}, { current: () => { scene.drained += 1; return true } }, { current: () => {} },
        (message) => scene.errors.push(message),
        isMainConversationEvent, streamBuffer, STREAM_DELTA_TYPES, toolArgumentDetail,
      )
    }
    return scene
  }
}

function mergeMessageSource() {
  return sectionBetween(appSource, 'function mergeMessage(items, incoming)', '\nfunction shellCommandOf')
    + sectionBetween(appSource, 'function parseSlashInput(text)', '\n// Most commands never print')
}

// Runs the real backend handler for "is this turn still going" against a fake transcript.
function loadSessionBusy() {
  const source = sectionBetween(
    mainSource,
    "registerIpcHandle('copilot:session-busy'",
    "\nregisterIpcHandle('copilot:read-todos'",
  )
  const start = source.indexOf('async (_event, sessionId)')
  const end = source.lastIndexOf('})') + 1
  const handlerSource = source.slice(start, end)
  return async (events) => {
    const build = new Function(
      'resumeSession', 'serializeError', 'isMainConversationEvent', 'liveBusy',
      `return ${handlerSource}`,
    )
    // An empty live map: the session has not been seen live, so the transcript is what is read.
    const handler = build(
      async () => ({ getEvents: async () => events }),
      (error) => ({ message: String(error) }),
      isMainConversationEvent,
      new Map(),
    )
    return handler(null, SESSION)
  }
}

function sectionBetween(source, start, end) {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `missing source section: ${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(to, -1, `missing source section end: ${end}`)
  return source.slice(from, to)
}
