// Scratch probe: reconstruct main-conversation turn timelines from a session transcript.
import { readFileSync } from 'node:fs'
import { isMainConversationEvent } from '../shared/agent-events.mjs'
const ev = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const main = ev.filter(isMainConversationEvent)
const starts = main.map((e, i) => (e.type === 'user.message' ? i : -1)).filter((i) => i >= 0)
for (const s of starts.slice(-Number(process.argv[3] || 5))) {
  const t0 = Date.parse(main[s].timestamp)
  const next = starts.find((i) => i > s) ?? main.length
  const seg = main.slice(s, next)
  let think = 0, tool = 0, cur = null, calls = 0, firstMsg = null, firstTool = null, lastEnd = null, waits = []
  for (const e of seg) {
    const t = Date.parse(e.timestamp) - t0
    if (e.type === 'assistant.turn_start') { cur = { s: t, ft: null, lc: null }; calls++ }
    if (e.type === 'assistant.message' && firstMsg == null) firstMsg = t
    if (e.type === 'tool.execution_start' && firstTool == null) firstTool = t
    if (cur && e.type === 'tool.execution_start' && cur.ft == null) { cur.ft = t; think += t - cur.s; waits.push(t - cur.s) }
    if (cur && e.type === 'tool.execution_complete') cur.lc = t
    if (cur && e.type === 'assistant.turn_end') { if (cur.ft == null) { think += t - cur.s; waits.push(t - cur.s) } else tool += (cur.lc ?? t) - cur.ft; cur = null; lastEnd = t }
  }
  const model = [...new Set(seg.map((e) => e.data?.model).filter(Boolean))].join(',')
  waits.sort((a, b) => a - b)
  console.log(`${main[s].timestamp} model=${model || '?'} calls=${calls} firstAssistantMsg=${firstMsg} firstTool=${firstTool} lastTurnEnd=${lastEnd} modelWait=${think} toolExec=${tool} perCallMedian=${waits[waits.length >> 1]} max=${waits[waits.length - 1]}`)
}
