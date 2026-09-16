import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginPlanTurn,
  createPlanLifecycleState,
  finishPlanTurn,
  getPlanForDisplay,
  markPlanChanged,
  observePlanRead,
} from '../src/plan-lifecycle.mjs'

const oldPlan = [
  { id: 'one', title: 'One', status: 'done' },
  { id: 'two', title: 'Two', status: 'in_progress' },
]
const changedPlan = [
  { id: 'one', title: 'One', status: 'done' },
  { id: 'two', title: 'Two revised', status: 'in_progress' },
]

function read(state, sessionId, todos, turnId, ok = true) {
  return observePlanRead(state, { sessionId, turnId, ok, todos })
}

test('an unknown first read becomes a baseline without becoming visible', () => {
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)

  assert.deepEqual(getPlanForDisplay(state, 'session-1', false), [])
  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), [])
})

test('a new unchanged turn does not resurrect its session baseline', () => {
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)
  const started = beginPlanTurn(state, 'session-1')
  state = started.state
  state = read(state, 'session-1', oldPlan, started.turnId)

  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), [])
})

test('a changed snapshot is visible only while its turn is active', () => {
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)
  const started = beginPlanTurn(state, 'session-1')
  state = read(started.state, 'session-1', changedPlan, started.turnId)

  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), changedPlan)
  state = finishPlanTurn(state, { sessionId: 'session-1', turnId: started.turnId })
  assert.deepEqual(getPlanForDisplay(state, 'session-1', false), [])
  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), [])
})

test('an explicit current-turn signal can activate an unchanged snapshot after a read', () => {
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)
  const started = beginPlanTurn(state, 'session-1')
  state = markPlanChanged(started.state, { sessionId: 'session-1', turnId: started.turnId })
  state = read(state, 'session-1', oldPlan, started.turnId)

  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), oldPlan)
})

test('a late read from an older turn cannot overwrite the newer turn', () => {
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)
  const first = beginPlanTurn(state, 'session-1')
  const second = beginPlanTurn(first.state, 'session-1')
  state = read(second.state, 'session-1', oldPlan, first.turnId)

  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), [])
})

test('a late read from the same turn cannot overwrite a newer read', () => {
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)
  const started = beginPlanTurn(state, 'session-1')
  state = read(started.state, 'session-1', changedPlan, started.turnId, true)
  state = observePlanRead(state, {
    sessionId: 'session-1',
    turnId: started.turnId,
    readId: 2,
    ok: true,
    todos: changedPlan,
  })
  state = observePlanRead(state, {
    sessionId: 'session-1',
    turnId: started.turnId,
    readId: 1,
    ok: true,
    todos: oldPlan,
  })

  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), changedPlan)
})

test('read failure clears an active stale display', () => {
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)
  const started = beginPlanTurn(state, 'session-1')
  state = read(started.state, 'session-1', changedPlan, started.turnId)
  state = read(state, 'session-1', [], started.turnId, false)

  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), [])
})

test('a successful read can restore the same fresh plan after a failed read', () => {
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)
  const started = beginPlanTurn(state, 'session-1')
  state = read(started.state, 'session-1', changedPlan, started.turnId)
  state = read(state, 'session-1', [], started.turnId, false)
  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), [])
  state = read(state, 'session-1', changedPlan, started.turnId)

  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), changedPlan)
})

test('a completed current plan is hidden', () => {
  const completePlan = oldPlan.map((todo) => ({ ...todo, status: 'completed' }))
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)
  const started = beginPlanTurn(state, 'session-1')
  state = markPlanChanged(started.state, { sessionId: 'session-1', turnId: started.turnId })
  state = read(state, 'session-1', completePlan, started.turnId)

  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), [])
})

test('sessions keep their own active plan lifecycle when the user switches chats', () => {
  let state = createPlanLifecycleState()
  state = read(state, 'session-1', oldPlan)
  state = read(state, 'session-2', oldPlan)
  const started = beginPlanTurn(state, 'session-1')
  state = read(started.state, 'session-1', changedPlan, started.turnId)

  assert.deepEqual(getPlanForDisplay(state, 'session-2', true), [])
  assert.deepEqual(getPlanForDisplay(state, 'session-1', true), changedPlan)
})
