import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { isMainConversationEvent } from '../shared/agent-events.mjs'

// How much a chat has actually been used, read cheaply from its transcript on disk. The cleanup
// rules only need to tell apart a chat nobody typed in, one with a single message, and one with
// more, so the count stops at two. Reading stops there as well, which keeps a transcript of tens
// of megabytes down to its first few lines in the common case.
export const USER_MESSAGE_CAP = 2

// Session ids name a folder on disk, so anything that could step outside that folder is refused.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function isSafeSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId)
}

// Counts the main conversation's user messages, up to the cap. A delegated agent is sent its
// prompt as a user.message too, and that is not the person typing, so it does not count.
export async function countUserMessages(filePath, cap = USER_MESSAGE_CAP) {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let count = 0
  try {
    for await (const line of lines) {
      // Most lines are large tool results; checking the text first avoids parsing any of them.
      if (!line.includes('"user.message"')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        // A line still being written at the end of the file is not a message yet.
        continue
      }
      if (event?.type !== 'user.message' || !isMainConversationEvent(event)) continue
      count += 1
      if (count >= cap) break
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  return count
}

// What is returned when the transcript could not be read: a null count, never a zero.
export const UNKNOWN_STATS = Object.freeze({ userMessages: null, bytes: 0 })

// Keeps one answer per session for as long as its transcript has not been written to since.
export function createSessionStatsReader(sessionStateDirectory) {
  const cache = new Map()

  async function readOne(sessionId) {
    if (!isSafeSessionId(sessionId)) return UNKNOWN_STATS
    const filePath = path.join(sessionStateDirectory, sessionId, 'events.jsonl')
    let info
    try {
      info = await stat(filePath)
    } catch (error) {
      cache.delete(sessionId)
      // No transcript yet means nothing was ever said. Any other failure is only a failed read.
      if (error?.code === 'ENOENT') return { userMessages: 0, bytes: 0 }
      return UNKNOWN_STATS
    }
    const cached = cache.get(sessionId)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.bytes === info.size) return cached.stats
    const stats = { userMessages: await countUserMessages(filePath), bytes: info.size }
    cache.set(sessionId, { mtimeMs: info.mtimeMs, bytes: info.size, stats })
    return stats
  }

  return async function readSessionStats(sessionIds) {
    const ids = Array.isArray(sessionIds) ? [...new Set(sessionIds.filter((id) => typeof id === 'string'))] : []
    const result = {}
    // One at a time keeps a long list from opening every transcript at once.
    for (const id of ids) {
      try {
        result[id] = await readOne(id)
      } catch {
        // A transcript that could not be read is not the same as an empty one, so nothing is
        // claimed about it and the cleanup rules leave it alone.
        result[id] = UNKNOWN_STATS
      }
    }
    return result
  }
}
