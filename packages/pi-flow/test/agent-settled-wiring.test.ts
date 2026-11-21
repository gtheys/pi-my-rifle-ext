// AIDEV-NOTE: PMR-EZ96 — SOURCE-level pin for the agent_settled settle-order
// wiring in index.ts (the /flow advancement hook). The four flow-widget
// regression tests pin refreshAfterSettle's ordering contract directly, but
// nothing exercised the ACTUAL wiring in the handler — a regression back to
// two concurrent void calls (void loop.onSettled() + void
// refreshFlowWidget(), the exact PMR-2KH5 bug shape) would pass the entire
// suite. This test reads index.ts and fails if the settle handler regresses
// to concurrent refresh wiring. Lightweight by design: the handler body
// stays where it belongs (registered against pi.on) instead of being
// extracted into a seam.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const indexSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
  'utf8',
)

// The advancement-hook handler region: from the handler's own
// pi.on('agent_settled') registration (located AFTER the /flow advancement
// hook anchor, which sits adjacent to it) up to the next pi.on(
// registration. Region-scoped on purpose — index.ts legitimately calls
// void refreshFlowWidget() in OTHER handlers (e.g. the onFlowSpawn path),
// so a whole-file negative assertion would false-positive.
function settleHandlerRegion(): string {
  const anchor = indexSource.indexOf('AIDEV-NOTE: The /flow advancement hook')
  if (anchor === -1) return ''
  const registration = indexSource.indexOf("pi.on('agent_settled'", anchor)
  if (registration === -1) return ''
  const nextHandler = indexSource.indexOf('pi.on(', registration + 1)
  if (nextHandler === -1) return indexSource.slice(registration)
  return indexSource.slice(registration, nextHandler)
}

test('agent_settled wiring chains the widget refresh AFTER the loop settle work (PMR-2KH5)', () => {
  assert.match(
    settleHandlerRegion(),
    /void refreshAfterSettle\(\(\) => loop\.onSettled\(\)\)/,
    'the settle handler must wire the refresh through refreshAfterSettle(() => loop.onSettled()) — chained, not concurrent',
  )
})

test('agent_settled wiring has no concurrent bare widget refresh in the settle handler (PMR-2KH5)', () => {
  assert.doesNotMatch(
    settleHandlerRegion(),
    /void refreshFlowWidget\(\)/,
    'the settle handler must not fire a concurrent bare void refreshFlowWidget() — that is the exact PMR-2KH5 regression shape',
  )
})
