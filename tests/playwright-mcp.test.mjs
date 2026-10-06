import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const wrapper = fileURLToPath(new URL('../scripts/playwright-mcp.sh', import.meta.url))

async function runWrapper(t, securityBody) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hc-playwright-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const record = path.join(directory, 'launch.json')
  await writeFile(path.join(directory, 'security'), `#!/bin/sh\n${securityBody}\n`, { mode: 0o700 })
  await writeFile(path.join(directory, 'npx'), `#!${process.execPath}
require('node:fs').writeFileSync(process.env.TEST_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  hasToken: process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN === 'test-only',
}))
`, { mode: 0o700 })
  const result = spawnSync('/bin/sh', [wrapper], {
    encoding: 'utf8',
    env: {
      PATH: `${directory}:/usr/bin:/bin`,
      TEST_RECORD: record,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'stale-test-only',
    },
  })
  return { result, record }
}

test('Playwright wrapper passes the Keychain token only through the child environment', async (t) => {
  const { result, record } = await runWrapper(t, "printf '%s' 'test-only'")
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), {
    args: ['-y', '@playwright/mcp@latest', '--extension'],
    hasToken: true,
  })
})

test('Playwright wrapper fails closed when Keychain access fails', async (t) => {
  const { result, record } = await runWrapper(t, "printf '%s' 'private-error' >&2; exit 44")
  assert.equal(result.status, 1)
  assert.match(result.stderr, /token unavailable/)
  assert.ok(!result.stderr.includes('private-error'))
  assert.equal(result.stdout, '')
  await assert.rejects(readFile(record), { code: 'ENOENT' })
})

test('Playwright wrapper refuses an empty token instead of starting an unauthenticated connection', async (t) => {
  const { result, record } = await runWrapper(t, 'exit 0')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /token is empty/)
  assert.equal(result.stdout, '')
  await assert.rejects(readFile(record), { code: 'ENOENT' })
})
