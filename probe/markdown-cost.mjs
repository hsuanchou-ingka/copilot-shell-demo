// Scratch probe: cost of re-rendering every message's markdown, which App does on each re-render
// because MessageBody is not memoized. Uses the real main-conversation messages of a session.
import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isMainConversationEvent } from '../shared/agent-events.mjs'
const ev = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const msgs = ev.filter(isMainConversationEvent).filter((e) => (e.type === 'user.message' || e.type === 'assistant.message') && e.data?.content).map((e) => e.data.content)
const chars = msgs.reduce((a, m) => a + m.length, 0)
const list = () => h('div', null, msgs.map((m, i) => h(ReactMarkdown, { key: i, remarkPlugins: [remarkGfm] }, m)))
renderToStaticMarkup(list())
const runs = []; for (let i = 0; i < 5; i++) { const t = performance.now(); renderToStaticMarkup(list()); runs.push(Math.round(performance.now() - t)) }
console.log(`messages=${msgs.length} chars=${chars} fullListMarkdownRender ms: ${runs.join(', ')}`)
const live = msgs.filter((m) => m.length > 1500)[0] || msgs[msgs.length - 1]
const r2 = []; for (let i = 0; i < 20; i++) { const t = performance.now(); renderToStaticMarkup(h(ReactMarkdown, { remarkPlugins: [remarkGfm] }, live)); r2.push(performance.now() - t) }
console.log(`one ${live.length}-char live message parse ms avg ${(r2.reduce((a, b) => a + b) / r2.length).toFixed(1)}`)
