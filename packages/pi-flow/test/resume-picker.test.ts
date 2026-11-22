import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { ParkedCandidate } from '../flow/durable-refs.ts'
import {
  buildResumeFallbackLines,
  buildResumeMenuOptions,
  formatAge,
  ownerHint,
  ownerPidAlive,
  planResumePickerOutcome,
  RESUME_NONE_VALUE,
  type ResumeSelection,
} from '../flow/resume-picker.ts'

// AIDEV-NOTE: PMR-T9ZQ 2.2 — pure unit tests for the parked-run resume
// picker building blocks. The planner is UI-free, so the whole decision
// table (incl. the owner-liveness hint text) is pinned here without any
// ctx fake; index.ts wiring (phase 3) only ever passes the picked label's
// value back in as `selection`.

const NOW = '2026-11-20T12:00:00.000Z'

/** Spawn a child that exits immediately and return its pid AFTER it has
 * been reaped, so the pid is definitively dead. Waiting for 'close' (not
 * just 'exit') is what guarantees libuv already reaped it — probing on
 * 'exit' could still see a zombie and read as alive. */
async function spawnExitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  })
  const pid = child.pid
  if (typeof pid !== 'number') throw new Error('spawn returned no pid')
  await once(child, 'close')
  return pid
}

function candidate(
  overrides: Partial<ParkedCandidate> & { ref: string },
): ParkedCandidate {
  const base: ParkedCandidate = {
    ref: overrides.ref,
    phase: 'implement',
    status: 'running',
    updatedAt: '2026-11-20T11:55:00.000Z',
    hasWorktree: true,
  }
  return { ...base, ...overrides }
}

// ---------------------------------------------------------------------------
// formatAge — boundary pins.

test('formatAge: sub-minute and exactly one minute boundaries', () => {
  assert.equal(formatAge(NOW, '2026-11-20T11:59:59.000Z'), 'just now')
  assert.equal(formatAge(NOW, '2026-11-20T11:59:00.000Z'), '1m ago')
  assert.equal(formatAge(NOW, '2026-11-20T11:01:00.000Z'), '59m ago')
})

test('formatAge: hour boundaries', () => {
  assert.equal(formatAge(NOW, '2026-11-20T11:00:00.000Z'), '1h ago')
  assert.equal(formatAge(NOW, '2026-11-19T13:00:00.000Z'), '23h ago')
})

test('formatAge: day boundaries', () => {
  assert.equal(formatAge(NOW, '2026-11-19T12:00:00.000Z'), '1d ago')
  assert.equal(formatAge(NOW, '2026-11-17T12:00:00.000Z'), '3d ago')
})

test('formatAge: future timestamp reads just now', () => {
  assert.equal(formatAge(NOW, '2026-11-20T12:05:00.000Z'), 'just now')
})

test('formatAge: unparsable timestamp yields unknown, never NaN', () => {
  assert.equal(formatAge(NOW, 'not-a-timestamp'), 'unknown')
  assert.equal(formatAge('not-a-timestamp', NOW), 'unknown')
})

// ---------------------------------------------------------------------------
// ownerPidAlive — the copied ESRCH/EPERM probe.

test('ownerPidAlive: this process is alive', () => {
  assert.equal(ownerPidAlive(process.pid), true)
})

test('ownerPidAlive: a reaped child pid is dead', async () => {
  const pid = await spawnExitedChildPid()
  assert.equal(ownerPidAlive(pid), false)
})

test('ownerPidAlive: a non-positive pid is never alive', () => {
  assert.equal(ownerPidAlive(0), false)
  assert.equal(ownerPidAlive(-1), false)
})

// ---------------------------------------------------------------------------
// ownerHint — display-only hint text.

test('ownerHint: no owner → empty string', () => {
  assert.equal(ownerHint(undefined), '')
})

test('ownerHint: alive owner pid → appears alive', () => {
  assert.equal(
    ownerHint({
      sessionFile: '/agent/session.jsonl',
      pid: process.pid,
      at: NOW,
    }),
    'owner session appears alive',
  )
})

test('ownerHint: dead owner pid → exited', async () => {
  const pid = await spawnExitedChildPid()
  assert.equal(
    ownerHint({ sessionFile: null, pid, at: NOW }),
    'owner session exited',
  )
})

// ---------------------------------------------------------------------------
// Menu options — label shape.

test('buildResumeMenuOptions: one option per candidate plus the none row last', () => {
  const options = buildResumeMenuOptions(
    [
      candidate({ ref: 'PMR-AAA' }),
      candidate({ ref: 'PMR-BBB', phase: 'plan' }),
    ],
    NOW,
  )
  assert.equal(options.length, 3)
  assert.deepEqual(
    options.map((o) => o.value),
    ['PMR-AAA', 'PMR-BBB', RESUME_NONE_VALUE],
  )
  assert.deepEqual(
    options.map((o) => o.label),
    [
      'Resume PMR-AAA — implement, running, updated 5m ago',
      'Resume PMR-BBB — plan, running, updated 5m ago',
      'None — leave this session clean',
    ],
  )
})

test('buildResumeMenuOptions: age comes from owner.at when present, updatedAt otherwise', () => {
  const options = buildResumeMenuOptions(
    [
      candidate({
        ref: 'PMR-CCC',
        updatedAt: '2026-11-20T09:00:00.000Z',
        owner: {
          sessionFile: null,
          pid: process.pid,
          at: '2026-11-20T11:30:00.000Z',
        },
      }),
    ],
    NOW,
  )
  assert.equal(
    options[0].label,
    'Resume PMR-CCC — implement, running, updated 30m ago, owner session appears alive',
  )
})

test('buildResumeMenuOptions: dead owner appends the exited hint', () => {
  const options = buildResumeMenuOptions(
    [
      candidate({
        ref: 'PMR-DDD',
        owner: { sessionFile: null, pid: 0, at: '2026-11-20T11:00:00.000Z' },
      }),
    ],
    NOW,
  )
  assert.equal(
    options[0].label,
    'Resume PMR-DDD — implement, running, updated 1h ago, owner session exited',
  )
})

test('buildResumeMenuOptions: null phase renders as none', () => {
  const options = buildResumeMenuOptions(
    [candidate({ ref: 'PMR-EEE', phase: null })],
    NOW,
  )
  assert.equal(
    options[0].label,
    'Resume PMR-EEE — none, running, updated 5m ago',
  )
})

test('buildResumeMenuOptions: labels are single-line', () => {
  const options = buildResumeMenuOptions(
    [
      candidate({
        ref: 'PMR-FFF',
        owner: { sessionFile: null, pid: process.pid, at: NOW },
      }),
    ],
    NOW,
  )
  for (const option of options) {
    assert.ok(!option.label.includes('\n'))
  }
})

test('buildResumeMenuOptions: empty candidates → only the none row', () => {
  const options = buildResumeMenuOptions([], NOW)
  assert.deepEqual(options, [
    { label: 'None — leave this session clean', value: RESUME_NONE_VALUE },
  ])
})

// ---------------------------------------------------------------------------
// Headless fallback lines.

test('buildResumeFallbackLines: one line per candidate with the recovery command', () => {
  const lines = buildResumeFallbackLines(
    [
      candidate({ ref: 'PMR-GGG' }),
      candidate({ ref: 'PMR-HHH', phase: 'validate', status: 'paused' }),
    ],
    NOW,
  )
  assert.deepEqual(lines, [
    'PMR-GGG — implement, running, updated 5m ago — recover with /flow PMR-GGG',
    'PMR-HHH — validate, paused, updated 5m ago — recover with /flow PMR-HHH',
  ])
})

test('buildResumeFallbackLines: empty candidates → no lines', () => {
  assert.deepEqual(buildResumeFallbackLines([], NOW), [])
})

// ---------------------------------------------------------------------------
// planResumePickerOutcome — the decision table.

test('planResumePickerOutcome: empty candidates → silent regardless of UI/selection', () => {
  assert.deepEqual(planResumePickerOutcome(true, [], undefined, NOW), {
    kind: 'silent',
  })
  assert.deepEqual(planResumePickerOutcome(false, [], undefined, NOW), {
    kind: 'silent',
  })
  assert.deepEqual(
    planResumePickerOutcome(true, [], { stage: 'resume-cancelled' }, NOW),
    { kind: 'silent' },
  )
})

test('planResumePickerOutcome: no UI → fallback lines, never a menu', () => {
  const candidates = [candidate({ ref: 'PMR-III' })]
  const plan = planResumePickerOutcome(false, candidates, undefined, NOW)
  assert.equal(plan.kind, 'fallback')
  if (plan.kind !== 'fallback') return
  assert.deepEqual(plan.lines, buildResumeFallbackLines(candidates, NOW))
})

test('planResumePickerOutcome: no UI with a selection still → fallback', () => {
  const plan = planResumePickerOutcome(
    false,
    [candidate({ ref: 'PMR-JJJ' })],
    { stage: 'resume-picked', value: 'PMR-JJJ' },
    NOW,
  )
  assert.equal(plan.kind, 'fallback')
})

test('planResumePickerOutcome: UI without selection → menu options', () => {
  const candidates = [
    candidate({ ref: 'PMR-KKK' }),
    candidate({ ref: 'PMR-LLL' }),
  ]
  const plan = planResumePickerOutcome(true, candidates, undefined, NOW)
  assert.equal(plan.kind, 'menu')
  if (plan.kind !== 'menu') return
  assert.deepEqual(plan.options, buildResumeMenuOptions(candidates, NOW))
  assert.equal(plan.options[plan.options.length - 1].value, RESUME_NONE_VALUE)
})

test('planResumePickerOutcome: cancel (Esc) → declined with the candidate refs', () => {
  const plan = planResumePickerOutcome(
    true,
    [candidate({ ref: 'PMR-MMM' })],
    { stage: 'resume-cancelled' },
    NOW,
  )
  assert.deepEqual(plan, { kind: 'declined', refs: ['PMR-MMM'] })
})

test('planResumePickerOutcome: the none row → declined', () => {
  const plan = planResumePickerOutcome(
    true,
    [candidate({ ref: 'PMR-NNN' }), candidate({ ref: 'PMR-OOO' })],
    { stage: 'resume-picked', value: RESUME_NONE_VALUE },
    NOW,
  )
  assert.deepEqual(plan, { kind: 'declined', refs: ['PMR-NNN', 'PMR-OOO'] })
})

test('planResumePickerOutcome: picking a candidate → resume with that record', () => {
  const picked = candidate({
    ref: 'PMR-PPP',
    phase: 'plan',
    hasWorktree: false,
  })
  const plan = planResumePickerOutcome(
    true,
    [candidate({ ref: 'PMR-QQQ' }), picked],
    { stage: 'resume-picked', value: 'PMR-PPP' },
    NOW,
  )
  assert.deepEqual(plan, { kind: 'resume', candidate: picked })
})

test('planResumePickerOutcome: unknown label value → declined (lookup miss)', () => {
  const plan = planResumePickerOutcome(
    true,
    [candidate({ ref: 'PMR-RRR' })],
    { stage: 'resume-picked', value: 'PMR-STALE' },
    NOW,
  )
  assert.deepEqual(plan, { kind: 'declined', refs: ['PMR-RRR'] })
})

test('planResumePickerOutcome: selection type accepts both stages', () => {
  const cancelled: ResumeSelection = { stage: 'resume-cancelled' }
  const picked: ResumeSelection = { stage: 'resume-picked', value: 'PMR-SSS' }
  assert.equal(
    planResumePickerOutcome(
      true,
      [candidate({ ref: 'PMR-SSS' })],
      cancelled,
      NOW,
    ).kind,
    'declined',
  )
  assert.equal(
    planResumePickerOutcome(true, [candidate({ ref: 'PMR-SSS' })], picked, NOW)
      .kind,
    'resume',
  )
})

test('planResumePickerOutcome: defaults to the wall clock when now is omitted', () => {
  const plan = planResumePickerOutcome(true, [candidate({ ref: 'PMR-TTT' })])
  assert.equal(plan.kind, 'menu')
  if (plan.kind !== 'menu') return
  assert.match(plan.options[0].label, /updated (just now|\d+[mhd] ago)$/)
})

// ---------------------------------------------------------------------------
// Purity pins — this module must stay UI-free and import-free of peers.

test('grep-proof: resume-picker code (comments stripped) is ui-free, sync, and import-free of peers', async () => {
  const raw = await readFile(
    new URL('../flow/resume-picker.ts', import.meta.url),
    'utf8',
  )
  // The module's AIDEV comments deliberately NAME ctx.ui.select (the call
  // belongs to the caller), so purity is pinned on the code, not the prose.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.ok(!src.includes('ctx'))
  assert.ok(!src.includes('ui.'))
  assert.ok(!src.includes('notify'))
  assert.ok(!src.includes('sendUserMessage'))
  assert.ok(!src.includes('pi-interactive-subagents'))
  assert.ok(!/\bawait\b/.test(src))
  assert.ok(!/\basync\b/.test(src))
})
