// How big a chat has grown, said in words the window can show as they are.
//
// Two different sizes live here. The context window is what the model sees on each turn, and it
// shrinks when the history is compacted. The transcript is the file on disk, which only ever
// grows, so a chat that has been compacted many times can still be slow to open. Everything here
// is a plain function so the wording can be tested without the window.

const MB = 1024 * 1024
const GB = 1024 * MB

// Below this a transcript opens quickly enough that saying anything would only be noise.
export const TRANSCRIPT_WARNING_BYTES = 100 * MB

// A file size as people read it: gigabytes with one decimal, megabytes as a whole number.
export function formatFileSize(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  return `${Math.round(bytes / MB)} MB`
}

// The sentence shown under the header for a chat whose transcript is large enough to be slow to
// open, or null when there is nothing worth saying. The threshold can be passed in for testing.
export function transcriptWarning(bytes, threshold = TRANSCRIPT_WARNING_BYTES) {
  if (!Number.isFinite(bytes) || bytes < threshold) return null
  return `This chat's history file is ${formatFileSize(bytes)}, so opening it is slow.`
}

// A token count in thousands, the way the meter shows it: 42k, 200k, or the plain number below a
// thousand so a fresh chat does not read as zero.
export function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens < 0) return ''
  if (tokens < 1000) return String(Math.round(tokens))
  return `${Math.round(tokens / 1000)}k`
}

// What the meter needs, or null when the figures are missing and the meter should not show.
export function contextMeter(context) {
  const used = context?.used
  const limit = context?.limit
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null
  return {
    label: `${formatTokens(used)} / ${formatTokens(limit)}`,
    fraction: Math.min(1, Math.max(0, used / limit)),
  }
}

// The one line reported after a compaction. Automatic and manual ones say the same thing, only
// the opening differs, so it is clear which of the two just happened.
export function compactionNotice({ messagesRemoved, tokensRemoved }, automatic = false) {
  const messages = Number.isFinite(messagesRemoved) ? messagesRemoved : 0
  const tokens = Number.isFinite(tokensRemoved) ? tokensRemoved : 0
  const lead = automatic ? 'History compacted automatically' : 'Compacted'
  const removed = `removed ${messages} ${messages === 1 ? 'message' : 'messages'}`
  // On a short chat the summary can be longer than what it replaced, and the runtime reports that
  // as a negative saving. Saying "removed -414 tokens" would be nonsense, so it is said plainly.
  if (tokens < 0) return `${lead}: ${removed}, the summary added ${formatTokens(-tokens)} tokens`
  return `${lead}: ${removed}, ${formatTokens(tokens)} tokens`
}

// The first message of a chat started from another one's summary.
export const CARRY_OVER_PREFIX = 'Context carried over from an earlier chat:'

export function carryOverPrompt(summary) {
  const text = typeof summary === 'string' ? summary.trim() : ''
  if (!text) return null
  return `${CARRY_OVER_PREFIX}\n\n${text}`
}
