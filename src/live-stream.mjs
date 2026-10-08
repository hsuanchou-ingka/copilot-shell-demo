// State helpers for the live event stream.
//
// A single tool turn delivers a few hundred events, and most of them change nothing that is on
// screen. Every update used to build a fresh state object anyway, which made React redraw the
// whole window once per event. These helpers keep the old object whenever nothing really changed,
// and they fold bursts of streamed text into one update per frame.

// The model this app prefers for new chats when the account offers it. It answers about as fast
// as the quickest model on offer, while "auto" tends to route to much slower ones.
export const PREFERRED_MODEL = 'claude-opus-5.5'

// The preferred model when the list has it, otherwise whatever the list offers first, otherwise
// "auto", which the runtime always understands.
export function defaultModelId(models) {
  const list = Array.isArray(models) ? models : []
  if (list.some((model) => model?.id === PREFERRED_MODEL)) return PREFERRED_MODEL
  return list[0]?.id || 'auto'
}

// True when both objects hold the same values under the same keys, one level deep.
export function sameShallow(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.is(a[key], b[key]))
}

// Applies one patch to one session's slice of the state map. The map itself is handed back
// untouched when the patch leaves that slice as it was, which is what lets React skip the render.
export function applySessionPatch(current, sessionId, patch, emptyState, now = Date.now()) {
  const previous = current[sessionId] || emptyState
  const next = typeof patch === 'function' ? patch(previous) : { ...previous, ...patch }
  if (sameShallow(previous, next)) return current
  // Stamped here rather than at each of the several places a turn can end, so no route out of a
  // turn can forget to record that it happened. Callers that end a turn for a reason other than
  // the work being done say so in the same patch. The progress line belongs to the turn, so it
  // goes with it, and the next turn never opens with the last one's tool still named.
  if (previous.working && !next.working) {
    if (!next.turnEndedAt) {
      next.turnEndedAt = now
      if (!next.turnOutcome) next.turnOutcome = 'done'
    }
    next.progress = null
  }
  return { ...current, [sessionId]: next }
}

// The streamed event types that are buffered and released once per frame.
export const STREAM_DELTA_TYPES = new Set([
  'assistant.message_delta',
  'assistant.reasoning_delta',
  'assistant.tool_call_delta',
])

// How much reasoning text is kept. Only the last line's worth is shown, so a little more than
// that is plenty and the string never grows with a long chain of thought.
const REASONING_KEEP = 240
// How much of a tool call's streamed input is kept. The command or path sits at the front of
// the arguments, so the head is all that is needed.
const TOOL_INPUT_KEEP = 600

function emptyChunk() {
  return { text: '', reasoning: '', reasoningId: '', tool: null }
}

// Merges one streamed event into the pending chunk for its session.
function addToChunk(chunk, event) {
  const data = event?.data || {}
  if (event.type === 'assistant.message_delta') {
    chunk.text += data.deltaContent || ''
  } else if (event.type === 'assistant.reasoning_delta') {
    if (chunk.reasoningId && data.reasoningId && chunk.reasoningId !== data.reasoningId) chunk.reasoning = ''
    chunk.reasoningId = data.reasoningId || chunk.reasoningId
    chunk.reasoning = (chunk.reasoning + (data.deltaContent || '')).slice(-REASONING_KEEP)
  } else if (event.type === 'assistant.tool_call_delta') {
    const id = data.toolCallId || ''
    const sameCall = chunk.tool && chunk.tool.id === id
    const input = (sameCall ? chunk.tool.input : '') + (data.inputDelta || '')
    chunk.tool = { id, name: data.toolName || (sameCall ? chunk.tool.name : ''), input: input.slice(0, TOOL_INPUT_KEEP) }
  }
}

// Folds a released chunk into one session's state. Assistant text replaces any progress line,
// because the answer itself is now on screen. Reasoning and tool input only update the line.
export function applyStreamChunk(state, chunk) {
  let next = state
  if (chunk.reasoning) {
    const previous = next.progress
    const carried = previous?.kind === 'thinking' && previous.id === chunk.reasoningId ? previous.text : ''
    next = {
      ...next,
      progress: { kind: 'thinking', id: chunk.reasoningId, text: (carried + chunk.reasoning).slice(-REASONING_KEEP) },
    }
  }
  if (chunk.tool) {
    const previous = next.progress
    const carried = previous?.kind === 'tool' && previous.id === chunk.tool.id ? previous.input : ''
    const input = carried.length >= TOOL_INPUT_KEEP ? carried : (carried + chunk.tool.input).slice(0, TOOL_INPUT_KEEP)
    next = {
      ...next,
      progress: {
        kind: 'tool',
        id: chunk.tool.id,
        name: chunk.tool.name || previous?.name || '',
        input,
        detail: '',
      },
    }
  }
  if (chunk.text) {
    next = { ...next, working: true, liveText: next.liveText + chunk.text, progress: null }
  }
  return next
}

// Collects streamed events per session and hands them over in one go on the next frame, so a
// burst of fifty deltas costs one render instead of fifty. `schedule` and `cancel` are
// requestAnimationFrame and cancelAnimationFrame in the app; tests pass synchronous stand-ins.
export function createStreamBuffer({ schedule, cancel, apply }) {
  const pending = new Map()
  let scheduled = false
  let handle = null

  const flushSession = (sessionId) => {
    const chunk = pending.get(sessionId)
    if (!chunk) return
    pending.delete(sessionId)
    apply(sessionId, chunk)
  }

  const flushAll = () => {
    scheduled = false
    handle = null
    for (const sessionId of [...pending.keys()]) flushSession(sessionId)
  }

  return {
    push(sessionId, event) {
      let chunk = pending.get(sessionId)
      if (!chunk) {
        chunk = emptyChunk()
        pending.set(sessionId, chunk)
      }
      addToChunk(chunk, event)
      if (!scheduled) {
        scheduled = true
        handle = schedule(flushAll)
      }
    },
    // Releases whatever is waiting for one session straight away. Called before any other event
    // for that session is handled, so the order of events on screen is the order they arrived in.
    flush(sessionId) {
      if (pending.has(sessionId)) flushSession(sessionId)
    },
    dispose() {
      if (scheduled) cancel(handle)
      scheduled = false
      handle = null
      pending.clear()
    },
  }
}

// Reads a command or path out of a tool call's arguments, whether they arrive as an object or
// as the half-written JSON text that streams in before the call starts.
const ARGUMENT_KEYS = ['command', 'path']
const PARTIAL_ARGUMENT_RE = /"(command|path)"\s*:\s*"((?:[^"\\]|\\.)*)/

function unescapeJsonFragment(text) {
  return text
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\(["\\/])/g, '$1')
    .replace(/\\$/, '')
}

export function toolArgumentDetail(argumentsValue) {
  if (argumentsValue && typeof argumentsValue === 'object') {
    for (const key of ARGUMENT_KEYS) {
      if (typeof argumentsValue[key] === 'string' && argumentsValue[key]) return argumentsValue[key]
    }
    return ''
  }
  if (typeof argumentsValue !== 'string') return ''
  const match = PARTIAL_ARGUMENT_RE.exec(argumentsValue)
  return match ? unescapeJsonFragment(match[2]) : ''
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

// How many characters of reasoning and of a tool's arguments the progress line shows.
const REASONING_SHOWN = 80
const ARGUMENT_SHOWN = 60

// The single line of text shown under "Working" while the model has not started its answer.
export function progressLine(progress) {
  if (!progress) return ''
  if (progress.kind === 'thinking') {
    const text = oneLine(progress.text)
    if (!text) return 'Thinking'
    return `Thinking ${text.length > REASONING_SHOWN ? `...${text.slice(-REASONING_SHOWN)}` : text}`
  }
  if (progress.kind === 'tool') {
    const name = progress.name || 'a tool'
    const detail = oneLine(progress.detail || toolArgumentDetail(progress.input))
    if (!detail) return `Running ${name}`
    return `Running ${name}: ${detail.length > ARGUMENT_SHOWN ? `${detail.slice(0, ARGUMENT_SHOWN)}...` : detail}`
  }
  return ''
}
