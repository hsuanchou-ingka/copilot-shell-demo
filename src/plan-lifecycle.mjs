const EMPTY_TODOS = Object.freeze([])

function copyTodos(todos) {
  return Array.isArray(todos) ? todos.map((todo) => ({ ...todo })) : []
}

function sameTodos(left, right) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((todo, index) => {
    const other = right[index]
    return todo?.id === other?.id
      && todo?.status === other?.status
      && todo?.title === other?.title
  })
}

function todoIsDone(todo) {
  return todo?.status === 'done' || todo?.status === 'completed'
}

function emptyRecord() {
  return {
    baseline: null,
    snapshot: EMPTY_TODOS,
    active: false,
    fresh: false,
    signaled: false,
    turnId: 0,
    readId: 0,
  }
}

function recordFor(state, sessionId) {
  return state.sessions[sessionId] || emptyRecord()
}

function withRecord(state, sessionId, record) {
  return {
    ...state,
    sessions: { ...state.sessions, [sessionId]: record },
  }
}

export function createPlanLifecycleState() {
  return { sessions: {} }
}

export function beginPlanTurn(state, sessionId) {
  if (!sessionId) return { state, turnId: 0 }
  const current = recordFor(state, sessionId)
  const turnId = current.turnId + 1
  const next = {
    ...current,
    active: true,
    fresh: false,
    signaled: false,
    turnId,
    snapshot: current.baseline || EMPTY_TODOS,
  }
  return { state: withRecord(state, sessionId, next), turnId }
}

export function observePlanRead(state, { sessionId, turnId, readId, ok, todos } = {}) {
  if (!sessionId) return state
  const current = recordFor(state, sessionId)
  if (turnId !== undefined && turnId !== current.turnId) return state
  if (readId !== undefined && readId < current.readId) return state
  if (!ok) {
    return withRecord(state, sessionId, {
      ...current,
      snapshot: EMPTY_TODOS,
      fresh: current.fresh,
      readId: readId === undefined ? current.readId : readId,
    })
  }

  const snapshot = copyTodos(todos)
  const changed = current.baseline !== null && !sameTodos(current.baseline, snapshot)
  return withRecord(state, sessionId, {
    ...current,
    baseline: snapshot,
    snapshot,
    fresh: current.active && (current.fresh || current.signaled || changed),
    readId: readId === undefined ? current.readId : readId,
  })
}

export function markPlanChanged(state, { sessionId, turnId } = {}) {
  if (!sessionId) return state
  const current = recordFor(state, sessionId)
  if (!current.active || (turnId !== undefined && turnId !== current.turnId)) return state
  return withRecord(state, sessionId, { ...current, signaled: true })
}

export function finishPlanTurn(state, { sessionId, turnId } = {}) {
  if (!sessionId) return state
  const current = recordFor(state, sessionId)
  if (turnId !== undefined && turnId !== current.turnId) return state
  return withRecord(state, sessionId, { ...current, active: false, fresh: false, signaled: false })
}

export function getPlanForDisplay(state, sessionId, working) {
  if (!sessionId || !working) return EMPTY_TODOS
  const current = recordFor(state, sessionId)
  if (!current.active || !current.fresh) return EMPTY_TODOS
  if (current.snapshot.length > 0 && current.snapshot.every(todoIsDone)) return EMPTY_TODOS
  return current.snapshot
}
