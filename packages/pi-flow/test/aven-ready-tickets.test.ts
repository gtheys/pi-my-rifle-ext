import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyReadyTickets,
  lastAvenResolutionFailure,
} from '../aven/client.ts'

// PMR-3E1Z: classifier for the ready-ticket picker. Same fail-closed
// convention as classifyOpenTicketRefs (PMR-384R): aven exits 0 on errors,
// so classification is by TEXT; any anomaly returns null and every null
// path records its reason via recordAvenFailure. [] is reserved for a
// successfully parsed empty array. Entries lacking a non-empty string ref
// or title are skipped, mirroring extractListRefs' skip rule.

test('valid JSON array parses to ref+title pairs; [] is a real zero-ready answer', () => {
  assert.deepEqual(
    classifyReadyTickets(
      '[{"ref":"PMR-1","title":"A — B"},{"ref":"PMR-2","title":"t"}]',
      '',
    ),
    [
      { ref: 'PMR-1', title: 'A — B' },
      { ref: 'PMR-2', title: 't' },
    ],
  )
  assert.deepEqual(classifyReadyTickets('[]', ''), [])
})

test('entries lacking a non-empty ref or title are skipped; the array still parses', () => {
  assert.deepEqual(
    classifyReadyTickets(
      '[{"ref":"PMR-1"},{"title":"t"},{"ref":"","title":"t"},{},"s"]',
      '',
    ),
    [],
  )
})

test('aven error text on stdout or stderr classifies as null (exit-0 failure)', () => {
  assert.equal(classifyReadyTickets('Error: nope\n[]', ''), null)
  assert.equal(classifyReadyTickets('[]', '  error: indented boom'), null)
})

test('non-JSON stdout classifies as null', () => {
  assert.equal(classifyReadyTickets('{not json', ''), null)
})

test('non-array JSON (schema drift) classifies as null', () => {
  assert.equal(classifyReadyTickets('{"a":1}', ''), null)
})

test('classify-level anomalies record the failure reason', () => {
  classifyReadyTickets('Error: nope\n[]', '')
  assert.match(lastAvenResolutionFailure() ?? '', /error text/)
  classifyReadyTickets('[]', '  error: x')
  assert.match(lastAvenResolutionFailure() ?? '', /stderr reported an error/)
  // lowercase `error:` on stdout is NOT an avenErrorText pattern — it falls
  // through to the JSON path and records the not-valid-JSON reason.
  classifyReadyTickets('error: nope', '')
  assert.match(lastAvenResolutionFailure() ?? '', /not valid JSON/i)
  classifyReadyTickets('{not json', '')
  assert.match(lastAvenResolutionFailure() ?? '', /not valid JSON/i)
  classifyReadyTickets('{"a":1}', '')
  assert.match(lastAvenResolutionFailure() ?? '', /schema drift/i)
})
