// Who an event belongs to.
//
// One chat can have more than one agent working in it. The main conversation is the one the
// person is talking to; a delegated agent is one the main conversation handed a task to, and it
// runs its own little conversation inside the same session: it is sent a prompt, it answers, it
// uses tools, its turn starts and ends. The runtime writes all of that into the same event
// stream, which is why a delegated agent's briefing once appeared in the chat styled as if the
// person had typed it, in whatever language the briefing happened to be written in.
//
// The runtime already says who produced each event: every event from a delegated agent carries
// that agent's id, and nothing the main conversation produces carries one at all. That is the
// whole test. Nothing here looks at the wording of a message, which would only ever be a guess.
//
// The exception that matters: subagent.started and its siblings describe a delegated agent from
// the outside, which is how the background panel knows work was handed off and when it ended.
// They are stamped with the child's id as well, so they have to be let through by name or the
// panel goes blind.
const SUBAGENT_LIFECYCLE_TYPES = new Set([
  'subagent.started',
  'subagent.configured',
  'subagent.completed',
  'subagent.failed',
])

// The id of the delegated agent that produced this event, or an empty string for the main
// conversation. Session-level events such as compaction have no id either, so they stay main.
export function subagentIdOf(event) {
  const id = event?.agentId
  return typeof id === 'string' && id ? id : ''
}

// An announcement about a delegated agent rather than a line from inside one.
export function isSubagentLifecycleEvent(event) {
  return SUBAGENT_LIFECYCLE_TYPES.has(event?.type)
}

// Part of a delegated agent's own conversation: its prompt, its replies, its tools, its turn
// boundaries, its errors. None of it is addressed to the person reading the chat.
export function isSubagentTranscriptEvent(event) {
  return Boolean(subagentIdOf(event)) && !isSubagentLifecycleEvent(event)
}

// What the main conversation is allowed to act on.
export function isMainConversationEvent(event) {
  return !isSubagentTranscriptEvent(event)
}
