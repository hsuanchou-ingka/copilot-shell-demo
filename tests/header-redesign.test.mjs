import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
const cssSource = await readFile(new URL('../src/App.css', import.meta.url), 'utf8')

function sectionBetween(source, start, end) {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, 'missing source section: ' + start)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(to, -1, 'missing source section end: ' + end)
  return source.slice(from, to)
}

// The header copy is derived during render from the real quota shape, so the derivation is
// lifted straight out of App.jsx and run against that shape rather than being restated here.
const derivation = sectionBetween(
  appSource,
  '  const quotaSnapshot = quota?.premium_interactions',
  '  const liveState = sessionState[selectedId]',
)

function creditState({ quota = null, quotaRefreshing = false, quotaFlash = null, quotaFailed = false, quotaUpdatedAt = null }) {
  const run = new Function(
    'quota', 'quotaRefreshing', 'quotaFlash', 'quotaFailed', 'quotaUpdatedAt',
    'quotaRefreshRef', 'models', 'selectedModel',
    derivation + '\nreturn { creditLineOne, creditTone, creditLineTwo, creditValueTone, quotaRemaining, quotaLow, quotaCheckedLabel }',
  )
  return run(quota, quotaRefreshing, quotaFlash, quotaFailed, quotaUpdatedAt, { current: null }, [], 'auto')
}

const HEALTHY = { premium_interactions: { usedRequests: 18420, entitlementRequests: 50000, remainingPercentage: 63.2 } }
const LOW = { premium_interactions: { usedRequests: 47000, entitlementRequests: 50000, remainingPercentage: 6 } }
const CHAT_ONLY = { chat: { usedRequests: 10, entitlementRequests: 100, remainingPercentage: 90 } }

test('the compact summary reports what is left against the entitlement', () => {
  const state = creditState({ quota: HEALTHY })
  assert.equal(state.quotaRemaining, 31580)
  assert.equal(state.creditLineTwo, '31,580 left / 50,000')
  assert.equal(state.creditLineOne, 'AI credits')
  assert.equal(state.creditValueTone, 'normal')
})

test('the chat quota is read when premium interactions are absent', () => {
  assert.equal(creditState({ quota: CHAT_ONLY }).creditLineTwo, '90 left / 100')
})

test('a check that came back with the same numbers still reads as a check that happened', () => {
  const unchanged = creditState({ quota: HEALTHY, quotaFlash: 'same', quotaUpdatedAt: Date.UTC(2026, 9, 7, 12, 0) })
  assert.match(unchanged.creditLineOne, /^Checked .+, no change$/)
  assert.equal(unchanged.creditTone, 'checked')
  const changed = creditState({ quota: HEALTHY, quotaFlash: 'changed', quotaUpdatedAt: Date.UTC(2026, 9, 7, 12, 0) })
  assert.match(changed.creditLineOne, /^Checked /)
  assert.doesNotMatch(changed.creditLineOne, /no change/)
})

test('a check in flight says so without disturbing the balance underneath', () => {
  const state = creditState({ quota: HEALTHY, quotaRefreshing: true })
  assert.equal(state.creditLineOne, 'Checking...')
  assert.equal(state.creditLineTwo, '31,580 left / 50,000')
})

test('a failed check keeps the last known balance visible and says it is stale', () => {
  const state = creditState({ quota: HEALTHY, quotaFailed: true })
  assert.equal(state.creditLineOne, 'Check failed, last known')
  assert.equal(state.creditTone, 'failed')
  assert.equal(state.creditLineTwo, '31,580 left / 50,000')
})

test('a failed first read has no balance to keep and says that instead', () => {
  const state = creditState({ quotaFailed: true })
  assert.equal(state.creditLineTwo, 'Balance unavailable')
  assert.equal(state.creditValueTone, 'failed')
  assert.equal(state.creditLineOne, 'AI credits')
})

test('a low balance is stated in words as well as colour', () => {
  const state = creditState({ quota: LOW })
  assert.equal(state.quotaLow, true)
  assert.equal(state.creditLineOne, 'AI credits, running low')
  assert.equal(state.creditValueTone, 'low')
})

test('the first successful read arrives as a balance, later reads arrive as checks', () => {
  const body = sectionBetween(appSource, '      onQuota: (next) => {', '      onError: () => {')
  const flashes = []
  const run = new Function(
    'quotaUsedRef', 'setQuota', 'setQuotaFailed', 'setQuotaUpdatedAt', 'setQuotaFlash',
    'quotaFlashTimerRef', 'clearTimeout', 'setTimeout',
    'const handler = ' + body.replace('      onQuota: ', '') .replace(/,\s*$/, '') + '\nreturn handler',
  )
  const quotaUsedRef = { current: null }
  const handler = run(
    quotaUsedRef, () => {}, () => {}, () => {}, (value) => flashes.push(value),
    { current: null }, () => {}, () => 1,
  )
  handler(HEALTHY)
  assert.deepEqual(flashes, [], 'the first read is the balance arriving, not a re-check')
  handler(HEALTHY)
  assert.deepEqual(flashes, ['same'])
  handler({ premium_interactions: { usedRequests: 18500, entitlementRequests: 50000, remainingPercentage: 63 } })
  assert.deepEqual(flashes, ['same', 'changed'])
  assert.equal(quotaUsedRef.current, 18500)
})

test('the model control is never disabled by a credit read', () => {
  const picker = sectionBetween(appSource, '<label className="model-picker">', '</label>')
  assert.match(picker, /disabled=\{!models\.length\}/)
  assert.doesNotMatch(picker, /quota/i)
  // The real API call and the real model list are kept.
  assert.match(picker, /onChange=\{\(event\) => changeModel\(event\.target\.value\)\}/)
  assert.match(picker, /models\.map\(\(model\) => <option key=\{model\.id\} value=\{model\.id\}>\{modelLabel\(model\)\}<\/option>\)/)
  // Closed state is the short name; the metadata rides along in the real option list.
  assert.match(picker, /\{models\.length \? selectedModelName : 'Loading models'\}/)
})

test('the session menu still offers rename, pin, fork and delete, and spells out the full path', () => {
  const menu = sectionBetween(appSource, '<div className="session-menu" role="menu"', '</div>\n                    )}')
  for (const label of ['Rename', 'Fork this session', 'Delete']) {
    assert.ok(menu.includes(label), 'missing menu item: ' + label)
  }
  assert.match(menu, /pinnedSessionIds\.includes\(selected\.id\) \? 'Unpin' : 'Pin'/)
  assert.match(menu, /session-menu-path/)
  assert.match(menu, /selectedWorkingDirectory \|\| 'Local session'/)
})

test('the stacked ring, percentage and update line are gone from the header', () => {
  for (const gone of ['credit-ring', 'credit-copy', 'credit-updated', 'remainingPercentage.toFixed(1)}% left']) {
    assert.ok(!appSource.includes(gone), 'header still renders: ' + gone)
  }
  assert.ok(!cssSource.includes('.credit-ring'), 'stale ring styles remain')
})

test('the real refresher still drives every refresh entry point', () => {
  assert.match(appSource, /const refreshCredits = \(\) => \{ void quotaRefreshRef\.current\?\.\(\) \}/)
  assert.equal(appSource.match(/onClick=\{refreshCredits\}/g).length, 2, 'both the icon and the details action refresh')
  assert.match(appSource, /createQuotaRefresher\(\{/)
  assert.match(appSource, /shouldRefresh: \(\) => document\.visibilityState !== 'hidden'/)
  assert.match(appSource, /window\.addEventListener\('focus', refresh\)/)
  assert.match(appSource, /document\.addEventListener\('visibilitychange', refresh\)/)
  assert.match(appSource, /void quotaRefreshRef\.current\?\.\(\)/)
})

test('both header popovers close on outside clicks and Escape and hand focus back', () => {
  const credits = sectionBetween(appSource, '  useEffect(() => {\n    if (!creditsOpen)', '  }, [creditsOpen])')
  assert.match(credits, /event\.target\?\.closest\?\.\('\.credit-visibility'\)/)
  assert.match(credits, /creditsButtonRef\.current\?\.focus\(\)/)
  assert.match(credits, /window\.addEventListener\('mousedown', close\)/)
  const session = sectionBetween(appSource, '  useEffect(() => {\n    if (!sessionMenuOpen)', '  }, [sessionMenuOpen])')
  assert.match(session, /sessionMenuButtonRef\.current\?\.focus\(\)/)
})

test('the header grid gives the side tracks equal width and stacks the model row when narrow', () => {
  const topbar = sectionBetween(cssSource, '.topbar {', '}')
  assert.match(topbar, /grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/)
  assert.match(topbar, /grid-template-areas: "left center right";/)
  assert.match(cssSource, /@container conversation \(max-width: 720px\) \{[\s\S]*?"left right"\s*\n\s*"center center";/)
  assert.match(cssSource, /@container conversation \(max-width: 480px\) \{\s*\n\s*\.session-project \{\s*\n\s*display: none;/)
})

test('popovers are capped to the conversation pane so a narrow edge cannot clip them', () => {
  for (const block of ['.session-menu {', '.credit-details {']) {
    assert.match(sectionBetween(cssSource, block, '}'), /max-width: calc\(100cqw - 32px\);/, block)
  }
  // The session menu hangs off the identity cluster, not off its own button: a short title in a
  // narrow pane puts that button near the middle, and a button-anchored menu runs off the edge.
  assert.match(sectionBetween(cssSource, '.session-title {', '}'), /position: relative;/)
  assert.doesNotMatch(sectionBetween(cssSource, '.session-menu-wrap {', '}'), /position: relative;/)
  assert.match(sectionBetween(cssSource, '.session-menu {', '}'), /left: 0;/)
})

test('the collapsed resource strip keeps its toggle outside the overflowing chip row', () => {
  const strip = sectionBetween(appSource, '<div className="rail-strip">', '</div>\n\n            {railOpen &&')
  const chipsEnd = strip.indexOf('</div>')
  assert.ok(strip.indexOf('rail-toggle') > chipsEnd, 'the toggle must not sit inside .rail-chips')
  assert.match(sectionBetween(cssSource, '.rail-chips {', '}'), /flex-wrap: nowrap;/)
  assert.match(sectionBetween(cssSource, '.rail-chips {', '}'), /mask-image: linear-gradient/)
  assert.match(cssSource, /\.resource-rail\.open \.rail-chips \{[\s\S]*?flex-wrap: wrap;/)
  // Expanded rows wrap long paths rather than cutting them off.
  assert.match(sectionBetween(cssSource, '\n.rail-row-label {', '}'), /overflow-wrap: anywhere;/)
})

test('the resource interactions are the real ones', () => {
  const rail = sectionBetween(appSource, '{selected && (resources.length > 0 || railOpen) && (', '{railMenu && (')
  assert.match(rail, /onClick=\{\(\) => openResource\(item\)\}/)
  assert.match(rail, /onClick=\{\(\) => insertResource\(item\)\}/)
  assert.match(rail, /addResource\(railDraft\)/)
  assert.match(rail, /hideResource|setRailMenu/)
})
