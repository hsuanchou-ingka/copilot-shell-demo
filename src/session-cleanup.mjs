// Which chats are worth offering to clean up, and which are safe to remove without asking.
//
// Everything here is a plain function of the session and what the window knows about it, so the
// rules can be tested on their own and the window only has to gather the facts.

export const IDLE_DAYS = 30
const IDLE_MS = IDLE_DAYS * 24 * 60 * 60 * 1000
// A chat that was just opened has not had the chance to be used yet. Waiting this long before
// removing an empty one keeps a chat from vanishing while someone is still deciding what to type.
export const EMPTY_GRACE_MS = 10 * 60 * 1000

export const REASON_LABELS = Object.freeze({
  external: 'External',
  empty: 'Empty',
  'one-message': 'One message',
  'idle-30d': 'Idle 30 days',
})

function timeOf(value) {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

function isProtected(session, ctx) {
  if (!session?.id) return true
  if (session.id === ctx.selectedId) return true
  if (ctx.working) return true
  const pinned = ctx.pinned
  if (pinned instanceof Set ? pinned.has(session.id) : Array.isArray(pinned) && pinned.includes(session.id)) {
    return true
  }
  return false
}

// The reasons a session could be cleaned up, in the order they are shown. The open chat, a pinned
// one and one with a turn running never get any, whatever else is true about them.
export function cleanupReasons(session, ctx = {}) {
  if (isProtected(session, ctx)) return []
  if (!ctx.owned) return ['external']
  const reasons = []
  // A count that could not be read is null, and that says nothing about how used the chat is.
  const count = ctx.stats?.userMessages
  if (count === 0) reasons.push('empty')
  else if (count === 1) reasons.push('one-message')
  const updatedAt = timeOf(session.updatedAt)
  const now = ctx.now ?? Date.now()
  if (updatedAt !== null && now - updatedAt > IDLE_MS) reasons.push('idle-30d')
  return reasons
}

// Only a chat nobody has typed in is ever removed without asking, and only once it has either
// been left behind or been sitting there unused for a while.
export function isAutoDeletable(session, ctx = {}) {
  if (!ctx.owned || isProtected(session, ctx)) return false
  if (!cleanupReasons(session, ctx).includes('empty')) return false
  if (ctx.justLeft === true) return true
  const createdAt = timeOf(session.createdAt)
  const now = ctx.now ?? Date.now()
  return createdAt !== null && now - createdAt > EMPTY_GRACE_MS
}
