import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'
import { parseValidateArgs } from '../validate/args.ts'
import {
  GATE_STEPS,
  gatePassed,
  initialGateState,
  pollExhausted,
  stepFails,
  stepSucceeds,
} from '../validate/gate.ts'
import { DEVCTL_REPO_NAME, resolveDevctlScriptsDir } from '../validate/paths.ts'
import {
  composeHumanTest,
  readResearchPath,
  routePersonalOutcome,
} from '../validate/personal.ts'
import { buildValidatePrompt } from '../validate/prompt.ts'

// --- args ---

test('parseValidateArgs: empty → help', () => {
  assert.deepEqual(parseValidateArgs(''), { kind: 'help' })
  assert.deepEqual(parseValidateArgs('   '), { kind: 'help' })
})

test('parseValidateArgs: Jira-style ref', () => {
  assert.deepEqual(parseValidateArgs('DP-123'), {
    kind: 'jira',
    jiraId: 'DP-123',
  })
  assert.deepEqual(parseValidateArgs('  dp-42  '), {
    kind: 'jira',
    jiraId: 'DP-42',
  })
})

test('parseValidateArgs: aven ref', () => {
  assert.deepEqual(parseValidateArgs('PMR-F7YM'), {
    kind: 'aven',
    ref: 'PMR-F7YM',
  })
})

test('parseValidateArgs: multiple tokens → help', () => {
  assert.deepEqual(parseValidateArgs('DP-1 extra'), { kind: 'help' })
})

// --- gate state machine ---

test('gate: initial state is at minikube, not passed', () => {
  const s = initialGateState()
  assert.equal(s.step, 'minikube')
  assert.equal(s.failed, null)
  assert.deepEqual(s.completed, [])
  assert.equal(gatePassed(s), false)
})

test('gate: success advances in order to completion', () => {
  let s = initialGateState()
  for (const expected of GATE_STEPS) {
    assert.equal(s.step, expected)
    s = stepSucceeds(s)
  }
  assert.equal(gatePassed(s), true)
  assert.deepEqual(s.completed, [...GATE_STEPS])
})

test('gate: failure records step + output and refuses to advance', () => {
  const s0 = initialGateState()
  const s1 = stepFails(s0, 'minikube start timed out')
  assert.deepEqual(s1.failed, {
    step: 'minikube',
    output: 'minikube start timed out',
  })
  assert.equal(s1.step, 'minikube')
  assert.equal(gatePassed(s1), false)
  // advancing past a failed gate is refused — state unchanged
  const s2 = stepSucceeds(s1)
  assert.deepEqual(s2, s1)
})

test('gate: failure at later step keeps earlier completions', () => {
  let s = stepSucceeds(initialGateState()) // minikube done
  s = stepSucceeds(s) // connectivity done -> at queues
  assert.equal(s.step, 'queues')
  const failed = stepFails(s, 'exit 1: queue creation failed')
  assert.deepEqual(failed.failed, {
    step: 'queues',
    output: 'exit 1: queue creation failed',
  })
  assert.deepEqual(failed.completed, ['minikube', 'connectivity'])
})

test('gate: succeed after recorded failure is refused (re-run required)', () => {
  const failed = stepFails(initialGateState(), 'boom')
  assert.deepEqual(stepSucceeds(failed), failed)
})

// --- bounded poll ---

test('pollExhausted: bounded by maxAttempts', () => {
  const cfg = { maxAttempts: 3, intervalMs: 0 }
  assert.equal(pollExhausted(0, cfg), false)
  assert.equal(pollExhausted(2, cfg), false)
  assert.equal(pollExhausted(3, cfg), true)
  assert.equal(pollExhausted(10, cfg), true)
})

// --- paths ---

test('resolveDevctlScriptsDir: joins first workRoot with devctl repo scripts', () => {
  const dir = resolveDevctlScriptsDir(['/home/geert/Code/salaryhero'])
  assert.equal(dir, '/home/geert/Code/salaryhero/sh-devctl/scripts')
})

test('resolveDevctlScriptsDir: first matching root wins', () => {
  const dir = resolveDevctlScriptsDir(['/a', '/b'])
  assert.equal(dir, '/a/sh-devctl/scripts')
})

test('resolveDevctlScriptsDir: no workRoots → null', () => {
  assert.equal(resolveDevctlScriptsDir([]), null)
})

test('DEVCTL_REPO_NAME is the fixed devctl repo', () => {
  assert.equal(DEVCTL_REPO_NAME, 'sh-devctl')
})

// --- prompt ---

test('buildValidatePrompt: work mode lists all gate steps in order', () => {
  const p = buildValidatePrompt({
    mode: 'work',
    ref: 'DP-71',
    scriptsDir: '/x/sh-devctl/scripts',
  })
  let last = -1
  for (const needle of [
    'minikube status',
    'test-services-connectivity.sh',
    'add-sqs-queues.sh',
    'devctl skill',
    'ask_user_question',
    'acli',
  ]) {
    const i = p.indexOf(needle)
    assert.ok(i > last, `expected "${needle}" after previous step`)
    last = i
  }
  assert.ok(p.includes('DP-71'))
  assert.ok(p.includes('/x/sh-devctl/scripts'))
})

// --- personal mode (PMR-8449) ---

describe('composeHumanTest', () => {
  it('returns insufficient-context when all sections are empty', () => {
    const r = composeHumanTest({
      whatChanged: '',
      planValidationNotes: '',
      researchFindings: '',
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.reason, /insufficient/i)
  })
  it('returns insufficient-context when sections are whitespace only', () => {
    const r = composeHumanTest({
      whatChanged: '  ',
      planValidationNotes: '\n',
      researchFindings: '',
    })
    assert.equal(r.ok, false)
  })
  it('composes runnable steps from whatChanged + validation notes', () => {
    const r = composeHumanTest({
      whatChanged: 'Added gate.ts state machine to validate/.',
      planValidationNotes: 'Run: bun test validate. Expect all tests green.',
      researchFindings: 'Gate must never advance past a failure.',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.steps.length >= 2)
    assert.ok(r.steps.some((s) => s.includes('bun test validate')))
    assert.ok(r.expectedOutcome.includes('all tests green'))
    // whatChanged and research findings appear as context steps
    const joined = r.steps.join('\n')
    assert.ok(joined.includes('Added gate.ts'))
  })
  it('missing validation notes still composes but expected outcome comes from research', () => {
    const r = composeHumanTest({
      whatChanged: 'Rewired /validate personal branch.',
      planValidationNotes: '',
      researchFindings: 'Human runs the flow and answers pass/fail.',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.expectedOutcome.includes('pass/fail'))
  })
})

describe('routePersonalOutcome', () => {
  it('pass completes with a dated aven note', () => {
    const r = routePersonalOutcome({ kind: 'pass' }, '2026-10-16')
    assert.deepEqual(r, {
      action: 'complete',
      avenNote: 'validated by human, 2026-10-16',
    })
  })
  it('fail routes back to /implement with the failure note and retry reset', () => {
    const r = routePersonalOutcome(
      { kind: 'fail', description: 'gate froze after step 2' },
      '2026-10-16',
    )
    assert.deepEqual(r, {
      action: 'reimplement',
      avenNote: 'gate froze after step 2',
      route: '/implement',
      retryBudgetReset: true,
    })
  })
  it('fail without description is refused', () => {
    const r = routePersonalOutcome(
      { kind: 'fail', description: '   ' },
      '2026-10-16',
    )
    assert.equal(r.action, 'invalid')
  })
})

test('buildValidatePrompt: personal mode asks for artifacts, ask_user_question, routing', () => {
  const p = buildValidatePrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    scriptsDir: null,
  })
  assert.ok(p.includes('PMR-F7YM'))
  assert.ok(p.includes('ask_user_question'))
  assert.ok(p.includes('/implement'))
  assert.ok(p.includes('validated by human'))
  assert.ok(!p.includes('PMR-8449'))
  assert.ok(!p.includes('minikube'))
})

test('buildValidatePrompt: personal mode reads research-path metadata, tolerant of absence', () => {
  const p = buildValidatePrompt({
    mode: 'personal',
    ref: 'PMR-F7YM',
    scriptsDir: null,
  })
  assert.match(p, /key=research-path/)
  assert.match(p, /aven show PMR-F7YM --full/)
  assert.match(p, /do NOT fail/i)
})

describe('readResearchPath', () => {
  const block = [
    'title: something',
    'metadata field_id=abc key=research-path',
    'value<<EOF',
    '/repo/notes/brainstorm/rate-limiting.md',
    'EOF',
  ].join('\n')

  it('extracts the path from an aven show --full metadata block', () => {
    assert.equal(
      readResearchPath(block),
      '/repo/notes/brainstorm/rate-limiting.md',
    )
  })
  it('returns null when the metadata block is absent', () => {
    assert.equal(readResearchPath('title: plain ticket\nstate: planned'), null)
  })
  it('returns null for an empty value', () => {
    const empty = [
      'metadata field_id=abc key=research-path',
      'value<<EOF',
      '',
      'EOF',
    ].join('\n')
    assert.equal(readResearchPath(empty), null)
  })
  it('ignores a description merely mentioning research-path', () => {
    assert.equal(
      readResearchPath('description: set research-path on the ticket'),
      null,
    )
  })
})

test('parseValidateArgs: kind prefixes force the kind (PMR-PCVK)', () => {
  assert.deepEqual(parseValidateArgs('aven:DP-71'), {
    kind: 'aven',
    ref: 'DP-71',
  })
  assert.deepEqual(parseValidateArgs('jira:DP-71'), {
    kind: 'jira',
    jiraId: 'DP-71',
  })
})

// --- PMR-C6AK: personal code-review gate in the validate prompt ---

test('buildValidatePrompt: personal step 9 routes through the code_review tool', () => {
  const p = buildValidatePrompt({
    mode: 'personal',
    ref: 'PMR-C6AK',
    scriptsDir: null,
  })
  assert.ok(p.includes('code_review tool with ref=PMR-C6AK'))
  // ordering: human test gate -> /review blockers -> deviation gate -> code_review -> land/push
  const codeReview = p.indexOf('code_review tool with ref=PMR-C6AK')
  const reviewGate = p.indexOf('blockers_count')
  const deviationGate = p.indexOf('Deviation gate')
  const land = p.indexOf('flow_land')
  assert.ok(reviewGate > 0)
  assert.ok(deviationGate > reviewGate)
  assert.ok(codeReview > deviationGate, 'code_review gate after deviation gate')
  assert.ok(
    land > codeReview,
    'flow_land only after the human code-review pass',
  )
  assert.ok(p.includes('push-main'))
  assert.ok(p.includes('tuicr'))
})

test('buildValidatePrompt: personal fail route names the tool-noted findings and /implement', () => {
  const p = buildValidatePrompt({
    mode: 'personal',
    ref: 'PMR-C6AK',
    scriptsDir: null,
  })
  assert.match(p, /On fail: the code_review tool already recorded/)
  assert.ok(p.includes('/implement PMR-C6AK'))
})

test('buildValidatePrompt: work-mode output is byte-identical (pin, PMR-C6AK)', () => {
  const p = buildValidatePrompt({
    mode: 'work',
    ref: 'DP-71',
    scriptsDir: '/x/sh-devctl/scripts',
  })
  const expected = `Validate phase (PIV flow). Mode: work. Ref: DP-71.
Run the work-mode validation gate. Execute these steps IN ORDER and do not skip
or reorder any of them. Every step must succeed before the next one starts.

1. Minikube (bounded): run \`minikube status\`. If it is not Running:
   run \`minikube start\`, then poll \`minikube status\` until Running —
   at most 12 attempts,
   10s apart. If it is still not
   Running after the bound, the gate FAILS (never hang the flow).
2. Connectivity: run \`/x/sh-devctl/scripts/test-services-connectivity.sh\` — must exit 0.
3. SQS queues: run \`/x/sh-devctl/scripts/add-sqs-queues.sh\` — must exit 0.
4. Deploy: use the user's devctl skill to deploy the affected services
   (from the plan's validation notes) to the local cluster.
5. Manual tests: read the plan's validation notes for the manual checks.
   Collect each check's result from the human via ask_user_question
   (pass/fail + evidence). A single fail fails the gate.
6. Jira evidence comment: via acli, post a comment on DP-71 describing
   HOW the change was validated — what was deployed, which tests ran, and the
   evidence from steps 1-5.

Completion rule: the phase passes ONLY after the Jira comment from step 6 has
landed. Track progress against the ordered gate steps
(minikube, connectivity, queues, deploy, manual-tests, jira-comment).

On ANY step failure: STOP. Write the failing step's name and its full failing
output as an aven note on DP-71, and report the failure to the human.
Never continue past a failed step, never mark the phase validated.

Review gate — run ONLY after validation has fully passed:

7. Run /review on this change (the fresh-context reviewer). When it returns,
   write the review artifact's verdict as machine-readable lines — exactly
   one line "blockers_count: <N>" (N = number of must-fix blockers, integer,
   0 when clean) plus one "- blocker: <description>" line per blocker:
   blockers_count: 0
   - blocker: <description> (omit this line entirely when N is 0)
8. Read the count. NEVER treat a missing or malformed count as 0 — a
   malformed artifact means re-run /review, not silent landing.
9. If blockers_count is 0: call the flow_phase_complete tool with ref=DP-71
   and phase="validate" — it applies the "review-passed" label after
   re-checking the gates, and its result confirms the label landed; without
   it the flow halts at validate. Then call the flow_land tool with
   ref=DP-71 and the route (pr) — it authorizes the landing;
   while the flow is active, direct git push / gh pr create are BLOCKED
   until flow_land returns ok. On ok, run the landing step:
   push the branch and create a PR via
   the gh CLI, then post a Jira comment on
   DP-71 linking the PR URL.
10. If blockers_count > 0: record each blocker as an aven note on DP-71,
   route back to /implement DP-71 (retry budget applies), and STOP — do
   not land.

Deviation gate — run ONLY after the review gate returned blockers_count: 0,
and BEFORE the flow_phase_complete(phase="validate") / flow_land calls named
in review-gate step 9. Steps, in order:

D1. Resolve the spec source. Resolve the spec file path via the resolve_spec_path tool
   (repo from the git remote, slug from the Jira summary) and read that spec
   file. Also fetch the Jira ticket text via acli.
D2. Mine the why-inputs: commit messages via git log against the flow's base
   (the commit flow started from), and recent aven notes on DP-71 via the
   existing aven client (interview note, worktree note, oneshot outcome,
   escalation notes).
D3. Run the deviation reviewer: call the deviation_review tool with
   mode="work", the resolved spec text (D1), the git diff vs base, and
   the mined commit messages and aven notes (D2). Await its result.
D4. Read the tool result. The tool already parses the artifact STRICTLY
   (deviations_count contract). An ERROR tool result (spawn failure or
   malformed artifact) means re-run deviation_review — NEVER treat it as 0
   deviations, never silent landing. On ok, continue with the returned
deviations_count.
D5. Route on the returned deviations_count:
   - 0 deviations: record an aven note on DP-71 reading
     "no deviation from spec", then continue to flow_phase_complete with
     ref=DP-71 and phase="validate", then flow_land (review-gate step 9).
   - more than 0: present the full deviation report to the human via
     ask_user_question with exactly two options: "accept" and "fix". WAIT
     for the answer. Record the human decision as an aven note on DP-71
     either way. On "accept": proceed to flow_phase_complete with ref=DP-71
     and phase="validate", then flow_land. On "fix": record the deviation
     report as an aven note on DP-71, route back to /implement DP-71 with
     the deviation report, and STOP — do not land.`
  assert.equal(p, expected)
})
