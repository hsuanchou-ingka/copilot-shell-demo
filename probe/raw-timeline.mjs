// Scratch probe: full event timeline for one prompt. Usage: node probe/raw-timeline.mjs <A|B> [model]
import { CopilotClient } from '@github/copilot-sdk'
import { createProbeSession, installProbeCleanup, cleanupProbeSessions } from './probe-session.mjs'
const [label = 'A', model] = process.argv.slice(2)
const prompts = { A: 'Reply with exactly: ok', B: 'List the files in the current folder using ls and tell me how many there are' }
const client = new CopilotClient({ autoStart: true }); await client.start(); installProbeCleanup(client)
if (label === 'models') { console.log((await client.listModels()).map((m) => m.id).join(' ')); process.exit(0) }
const s = await createProbeSession(client, { workingDirectory: process.cwd(), streaming: true, ...(model ? { model } : {}), onPermissionRequest: async () => ({ kind: 'allow' }) })
const skip = new Set(['assistant.streaming_delta', 'assistant.tool_call_delta', 'assistant.reasoning_delta', 'session.mcp_server_status_changed'])
let tSend = 0; let idle = false
s.on((ev) => {
  if (!tSend) return
  const t = Math.round(performance.now() - tSend)
  if (ev.type === 'session.idle') idle = true
  if (skip.has(ev.type)) return
  const extra = ev.data?.model || ev.data?.toolName || ev.data?.durationMs || ev.data?.duration || ''
  console.log(String(t).padStart(6), ev.type, extra)
})
tSend = performance.now(); await s.send({ prompt: prompts[label] })
while (!idle) await new Promise((x) => setTimeout(x, 20))
await cleanupProbeSessions(client)
await client.stop(); process.exit(0)
