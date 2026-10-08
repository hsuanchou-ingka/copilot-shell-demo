import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CARRY_OVER_PREFIX,
  TRANSCRIPT_WARNING_BYTES,
  carryOverPrompt,
  compactionNotice,
  contextMeter,
  formatFileSize,
  formatTokens,
  transcriptWarning,
} from '../src/session-size.mjs'

const MB = 1024 * 1024
const GB = 1024 * MB

test('a transcript under 100 MB gets no warning', () => {
  assert.equal(TRANSCRIPT_WARNING_BYTES, 100 * MB)
  assert.equal(transcriptWarning(0), null)
  assert.equal(transcriptWarning(100 * MB - 1), null)
  assert.equal(transcriptWarning(undefined), null)
  assert.equal(transcriptWarning(Number.NaN), null)
})

test('a large transcript is named in megabytes, a huge one in gigabytes with one decimal', () => {
  assert.equal(transcriptWarning(100 * MB), "This chat's history file is 100 MB, so opening it is slow.")
  assert.equal(transcriptWarning(360.4 * MB), "This chat's history file is 360 MB, so opening it is slow.")
  assert.equal(transcriptWarning(2.6 * GB), "This chat's history file is 2.6 GB, so opening it is slow.")
  assert.equal(formatFileSize(1023 * MB), '1023 MB')
  assert.equal(formatFileSize(GB), '1.0 GB')
})

test('the warning threshold can be lowered for testing', () => {
  assert.equal(transcriptWarning(4096, 1024), "This chat's history file is 0 MB, so opening it is slow.")
  assert.equal(transcriptWarning(512, 1024), null)
})

test('token counts read in thousands', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(950), '950')
  assert.equal(formatTokens(42_300), '42k')
  assert.equal(formatTokens(200_000), '200k')
  assert.equal(formatTokens(-1), '')
})

test('the meter hides without figures and clamps its fill', () => {
  assert.equal(contextMeter(null), null)
  assert.equal(contextMeter({ used: null, limit: 200_000 }), null)
  assert.equal(contextMeter({ used: 10, limit: 0 }), null)
  assert.deepEqual(contextMeter({ used: 42_000, limit: 200_000 }), { label: '42k / 200k', fraction: 0.21 })
  assert.equal(contextMeter({ used: 300_000, limit: 200_000 }).fraction, 1)
})

test('the compaction notice says what was removed and who started it', () => {
  assert.equal(compactionNotice({ messagesRemoved: 12, tokensRemoved: 31_400 }), 'Compacted: removed 12 messages, 31k tokens')
  assert.equal(
    compactionNotice({ messagesRemoved: 1, tokensRemoved: 800 }, true),
    'History compacted automatically: removed 1 message, 800 tokens',
  )
  assert.equal(compactionNotice({}), 'Compacted: removed 0 messages, 0 tokens')
  // A short chat can grow when compacted; the runtime reports that as a negative saving.
  assert.equal(
    compactionNotice({ messagesRemoved: 3, tokensRemoved: -414 }),
    'Compacted: removed 3 messages, the summary added 414 tokens',
  )
})

test('a carried over summary is prefixed and an empty one is refused', () => {
  assert.equal(carryOverPrompt('  The plan so far.  '), `${CARRY_OVER_PREFIX}\n\nThe plan so far.`)
  assert.equal(carryOverPrompt(''), null)
  assert.equal(carryOverPrompt('   '), null)
  assert.equal(carryOverPrompt(undefined), null)
})
