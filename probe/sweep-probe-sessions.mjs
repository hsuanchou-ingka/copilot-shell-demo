// Safety net: find (and with --delete, remove) leftover probe sessions in ~/.copilot/session-state.
// A folder counts only if its first user.message has content exactly equal to a probe prompt.
// Usage: node probe/sweep-probe-sessions.mjs [--delete]
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PROBE_PROMPTS, SESSION_STATE_DIR } from './probe-session.mjs'

const doDelete = process.argv.includes('--delete')
let scanned = 0
const matched = []
for (const id of await readdir(SESSION_STATE_DIR)) {
  scanned++
  let text
  try { text = await readFile(join(SESSION_STATE_DIR, id, 'events.jsonl'), 'utf8') } catch { continue }
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'user.message') continue
    if (PROBE_PROMPTS.includes(ev.data?.content)) matched.push(id)
    break
  }
}
let removed = 0
for (const id of matched) {
  console.log(`${doDelete ? 'deleting' : 'match'} ${id}`)
  if (doDelete) { await rm(join(SESSION_STATE_DIR, id), { recursive: true, force: true }); removed++ }
}
console.log(`scanned ${scanned}, matched ${matched.length}, removed ${removed}${doDelete ? '' : ' (dry run, pass --delete to remove)'}`)
