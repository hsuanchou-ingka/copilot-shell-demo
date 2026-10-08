// Scratch probe: cold vs warm turn in the same session. Usage: node probe/raw-warm.mjs [model]
import { CopilotClient } from '@github/copilot-sdk'
import { createProbeSession, installProbeCleanup, cleanupProbeSessions } from './probe-session.mjs'
const model = process.argv[2]
const client = new CopilotClient({ autoStart: true }); await client.start(); installProbeCleanup(client)
const s = await createProbeSession(client, { workingDirectory: process.cwd(), streaming: true, ...(model ? { model } : {}), onPermissionRequest: async () => ({ kind: 'allow' }) })
let st
s.on((ev) => {
  if (!st) return
  const t = Math.round(performance.now() - st.t0)
  if (ev.type === 'session.mcp_servers_loaded') st.mcp = t
  if (ev.type === 'assistant.turn_start' && st.turn == null) st.turn = t
  if (ev.type === 'model.call_start' && st.call == null) { st.call = t; st.model = ev.data?.model }
  if (ev.type === 'assistant.message_delta' && st.delta == null) st.delta = t
  if (ev.type === 'session.idle') st.idle = t
})
for (let i = 1; i <= 3; i++) {
  st = { t0: performance.now() }
  await s.send({ prompt: 'Reply with exactly: ok' })
  while (st.idle == null) await new Promise((x) => setTimeout(x, 20))
  const { t0, ...out } = st; console.log(`turn${i}`, JSON.stringify(out))
}
await cleanupProbeSessions(client)
await client.stop(); process.exit(0)
