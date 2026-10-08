// Helper for probe scripts: tracks the sessions they create and deletes them afterwards,
// so probe runs do not leave sessions behind in ~/.copilot/session-state.
import { rm, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Every prompt the probe scripts send. The sweep script matches leftovers against this list.
export const PROBE_PROMPTS = [
  'Reply with exactly: ok',
  'List the files in the current folder using ls and tell me how many there are',
]

export const SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state')

const ids = new Set()
let cleaning = null

export async function createProbeSession(client, options) {
  const session = await client.createSession(options)
  ids.add(session.sessionId)
  return session
}

const exists = (p) => access(p).then(() => true, () => false)

export async function cleanupProbeSessions(client) {
  const list = [...ids]
  ids.clear()
  for (const id of list) {
    let note = ''
    try {
      await client.deleteSession(id)
    } catch (e) {
      note = `deleteSession failed: ${e.message}`
    }
    const dir = join(SESSION_STATE_DIR, id)
    try {
      if (await exists(dir)) {
        await rm(dir, { recursive: true, force: true })
        console.log(`probe-cleanup ${id}: removed folder by fs.rm${note ? ` (${note})` : ''}`)
      } else {
        console.log(`probe-cleanup ${id}: ${note || 'removed'}${note ? ', no folder on disk' : ''}`)
      }
    } catch (e) {
      console.log(`probe-cleanup ${id}: could not remove folder: ${e.message}`)
    }
  }
}

export function installProbeCleanup(client) {
  const run = () => (cleaning ??= cleanupProbeSessions(client))
  process.on('beforeExit', () => { run() })
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await run()
      process.exit(sig === 'SIGINT' ? 130 : 143)
    })
  }
  process.on('uncaughtException', async (err) => {
    console.error(err)
    await run()
    process.exit(1)
  })
}
