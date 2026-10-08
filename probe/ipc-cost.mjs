// Scratch probe: cost of the calls the app's polling loops make, on a copied large session.
// Run with HOME pointed at a throwaway copy so the real session is untouched.
import { CopilotClient } from '@github/copilot-sdk'
const [sessionId, token] = process.argv.slice(2)
const client = new CopilotClient({ gitHubToken: token, useLoggedInUser: false, logLevel: 'error' }); await client.start()
let t = performance.now()
const s = await client.resumeSession(sessionId, { streaming: true, onPermissionRequest: async () => ({ kind: 'allow' }) })
console.log('resumeSession', Math.round(performance.now() - t), 'ms')
const time = async (name, fn, n = 3) => { const out = []; for (let i = 0; i < n; i++) { const a = performance.now(); const r = await fn(); out.push(Math.round(performance.now() - a)); if (i === 0 && name === 'getEvents') console.log('  events', r.length) } console.log(name, out.join(', '), 'ms') }
// Event loop blockage in this process while getEvents runs.
let maxLag = 0, last = performance.now(); const lagTimer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 5); last = now }, 5)
await time('getEvents', () => s.getEvents())
console.log('  max event-loop stall during getEvents', Math.round(maxLag), 'ms'); maxLag = 0
await time('readSqlTodos', () => s.rpc.plan.readSqlTodos())
await time('tasks.list', () => s.rpc.tasks.list())
await time('model.getCurrent', () => s.rpc.model.getCurrent())
console.log('  max stall others', Math.round(maxLag), 'ms')
clearInterval(lagTimer); await client.stop(); process.exit(0)
