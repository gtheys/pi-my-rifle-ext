import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyOpenTicketRefs,
  lastAvenResolutionFailure,
} from '../aven/client.ts'

// PMR-384R fix round (review blocker 1): listOpenTicketRefs must classify
// aven-side anomalies as null — ISC-13: collectOpenGates suppresses NOTHING
// when it cannot verify ticket status — and reserve [] for a successfully
// parsed empty array. aven exits 0 on errors, so classification is by TEXT
// (avenErrorText), never by exit code.

test('valid JSON array parses to refs; [] is a real zero-open answer', () => {
  assert.deepEqual(
    classifyOpenTicketRefs('[{"ref":"PMR-1"},{"ref":"pmr-2"}]', ''),
    ['PMR-1', 'pmr-2'],
  )
  assert.deepEqual(classifyOpenTicketRefs('[]', ''), [])
})

test('aven error text on stdout or stderr classifies as null (exit-0 failure)', () => {
  assert.equal(
    classifyOpenTicketRefs("error: unknown option '--open'", ''),
    null,
  )
  assert.equal(classifyOpenTicketRefs('Error: boom\n[]', ''), null)
  assert.equal(classifyOpenTicketRefs('[]', 'error: aven unavailable'), null)
})

test('non-JSON stdout classifies as null, not []', () => {
  assert.equal(classifyOpenTicketRefs('{not json', ''), null)
})

test('non-array JSON (schema drift) classifies as null', () => {
  assert.equal(classifyOpenTicketRefs('{"a":1}', ''), null)
})

test('indented stderr error line classifies as null (PMR-NPFR)', () => {
  // avenErrorText trims lines but only knows Error:/error-space; the
  // classify-level /^error\b/ check must trim too, or an indented
  // lowercase `error: ...` line slips past when stdout is valid JSON.
  assert.equal(classifyOpenTicketRefs('[]', '  error: indented boom'), null)
  assert.equal(classifyOpenTicketRefs('[]', '\terror: tabbed boom'), null)
  // A line that merely indents other text is not an error.
  assert.deepEqual(classifyOpenTicketRefs('[]', '  warning: fine'), [])
})

test('classify-level anomalies record the failure reason (PMR-710A)', () => {
  // ISC-13 keeps gates on a null universe; lastAvenResolutionFailure must
  // be able to explain WHY the universe was unverifiable, including the
  // classify-level paths that never hit the spawn catch.
  classifyOpenTicketRefs('{not json', '')
  assert.match(lastAvenResolutionFailure() ?? '', /not valid JSON/i)
  classifyOpenTicketRefs('{"a":1}', '')
  assert.match(lastAvenResolutionFailure() ?? '', /schema drift/i)
  classifyOpenTicketRefs('', 'error: aven unavailable')
  assert.match(lastAvenResolutionFailure() ?? '', /aven unavailable/)
  // avenErrorText pattern (Error:/error-space) on stdout -> error-text path.
  classifyOpenTicketRefs('Error: boom\n[]', '')
  assert.match(lastAvenResolutionFailure() ?? '', /Error: boom/)
  // lowercase `error:` on stdout is NOT an avenErrorText pattern — it falls
  // through to the JSON path and records the not-valid-JSON reason.
  classifyOpenTicketRefs("error: unknown option '--open'", '')
  assert.match(lastAvenResolutionFailure() ?? '', /not valid JSON/)
})

test('array entries without a ref are skipped; the array itself still parses', () => {
  assert.deepEqual(classifyOpenTicketRefs('[{"x":1},"s",{"ref":"A"}]', ''), [
    'A',
  ])
})
