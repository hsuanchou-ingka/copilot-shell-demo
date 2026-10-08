// Scratch probe: raw SDK latency, no Electron. Usage: node probe/raw-timing.mjs [model]
import { CopilotClient } from '@github/copilot-sdk'
import { createProbeSession, installProbeCleanup, cleanupProbeSessions } from './probe-session.mjs'
const model = process.argv[2] // undefined = SDK default
const prompts = {
  A: 'Reply with exactly: ok',
  B: 'List the files in the current folder using ls and tell me how many there are',
}
const t0c = performance.now()
const client = new CopilotClient({ autoStart: true })
await client.start()
installProbeCleanup(client)
console.log(`client.start ${Math.round(performance.now() - t0c)}ms`)

async function run(label) {
  const tc = performance.now()
  const s = await createProbeSession(client, {
    workingDirectory: process.cwd(), streaming: true,
    ...(model ? { model } : {}),
    onPermissionRequest: async () => ({ kind: 'allow' }),
  })
  const createMs = Math.round(performance.now() - tc)
  let cur = null
  try { cur = await s.rpc.model.getCurrent() } catch (e) { cur = 'err ' + e.message }
  const r = { label, createMs, model: JSON.stringify(cur), firstEvent: null, firstDelta: null, firstTool: null, idle: null, deltas: 0, chars: 0, types: {}, eventModels: new Set(), turnEnded: [] }
  let tSend = 0
  s.on((ev) => {
    const t = Math.round(performance.now() - tSend)
    if (!tSend) return
    r.types[ev.type] = (r.types[ev.type] || 0) + 1
    if (r.firstEvent === null) r.firstEvent = `${t}(${ev.type})`
    if (ev.data?.model) r.eventModels.add(ev.data.model)
    if (ev.type === 'assistant.message_delta') { r.deltas++; r.chars += (ev.data?.deltaContent || '').length; if (r.firstDelta === null) r.firstDelta = t }
    if (ev.type.startsWith('tool.') && r.firstTool === null) r.firstTool = `${t}(${ev.type})`
    if (ev.type === 'tool.execution_start') r.turnEnded.push(`toolstart@${t}`)
    if (ev.type === 'tool.execution_complete') r.turnEnded.push(`toolend@${t}`)
    if (ev.type === 'assistant.turn_start' || ev.type === 'assistant.turn_end') r.turnEnded.push(`${ev.type.split('.')[1]}@${t}`)
    if (ev.type === 'session.idle' && r.idle === null) r.idle = t
  })
  tSend = performance.now()
  await s.send({ prompt: prompts[label] })
  r.sendReturn = Math.round(performance.now() - tSend)
  while (r.idle === null && performance.now() - tSend < 180000) await new Promise((x) => setTimeout(x, 20))
  r.eventModels = [...r.eventModels].join(',')
  console.log(JSON.stringify(r))
  try { await s.destroy?.() } catch {}
}
for (const label of ['A', 'A', 'B', 'B']) await run(label)
await cleanupProbeSessions(client)
await client.stop(); process.exit(0)
