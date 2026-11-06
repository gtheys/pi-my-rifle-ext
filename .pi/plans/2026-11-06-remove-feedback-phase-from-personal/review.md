# Code Review — PMR-GFM5 (fold personal feedback into validate)

**Reviewed:** `git diff 4d69d6d1eb3a68536262e7239fc15cef78b64f55..HEAD` (3 commits: plan doc, mode-keyed phase list, prompt fold)
**Verdict:** correct (no blocking issues)

## Summary
Personal mode no longer runs `/feedback` as a phase: `MODE_PROFILE.phases` is
mode-keyed, `nextPhase(labels, mode)` ends the personal flow after validate,
and the personal validate prompt now owns the outcome-summary note, status
done, and `flow_phase_complete(feedback)` after the push. Work mode is
unchanged (default `'work'` keeps the full four-phase order for every
call site that doesn't pass a mode).

## Verification
- `bun run check`: lint ✔, typecheck ✔. Tests: pi-flow 586/586 pass. The
  `check` exit-1 comes from `pi-interactive-subagents` — **pre-existing at the
  merge base** (confirmed by running that package's tests in a worktree at
  `4d69d6d`, same failures, package untouched by this branch).
- `mode` is required on `PhasePromptInput` and `/flow` threads it
  (`index.ts:316`); `loop.ts:219` reads `this.state?.promptInput.mode`, so a
  live personal loop correctly ends at validate.
- `checkPhaseCompletion('feedback', ...)` (label-gate.ts) requires only
  planned+active+review-passed — the gate accepts completion from inside
  personal validate, as the plan assumed.
- `mode-profile.ts` imports `Phase` type-only from `orchestrate.ts`, so the
  new import pair creates no runtime cycle.

## Findings

### [P2] Stale docs still describe the removed personal feedback phase
**Files:** `docs/piv-flow-personal.md:43` (comparison table), `:108-115`
(mermaid FEEDBACK stage), `:183`, `:214` (label ledger), `:381`, `:408`,
`:453` (command list); `openwiki/workflows/planning-and-implementation.md:45`
**Issue:** These all instruct personal-mode users to run `/feedback` for the
outcome summary and `done`, which now refuses with a block message. The doc
contradicts the shipped behavior and will mislead on the next run.
**Suggested Fix:** Update both docs: personal ends after validate; fold the
summary-note + done steps into the validate/landing description; drop
`/feedback` from the personal command list (or mark it work-only).

### [P3] Personal tickets already at review-passed (pre-upgrade) report "(done)" without being done
**File:** `packages/pi-flow/index.ts:301` (with `flow/orchestrate.ts:29-35`)
**Issue:** A personal ticket carrying `planned+active+review-passed` but no
`done` label (mid-flow when this change lands) makes `/flow` print
"all phase labels present (done) — nothing to run" although the summary note,
status done, and `done` label never landed; `/feedback` now refuses. Recovery
exists (re-run `/validate`, or call `flow_phase_complete(feedback)` directly),
so this is a one-time migration rough edge, not a stranding.
**Suggested Fix:** Optionally adjust the notify wording for the mode-keyed
done case (e.g. only claim "(done)" when the `done` label is present), or
document the manual close-out for in-flight tickets.

## What's Good
- Work-mode behavior is provably untouched: the default `mode = 'work'` on
  `nextPhase` covers `flow.test.ts` legacy tests and any future caller; the
  summary/done steps landed only inside `buildPersonalCodeReviewGate`.
- The label gate (`label-gate.ts`) already accepted `flow_phase_complete(feedback)`
  after review-passed, so the fold required no gate change — correct reuse.
- Test updates cover both modes explicitly (`flow.test.ts` personal/work,
  `loop.test.ts` personal ends after validate, `phase-prompts.test.ts` block +
  summary-prompt assertions).
- `AIDEV-NOTE` anchors updated where behavior changed (orchestrate.ts,
  phase-command.ts, feedback/prompt.ts header comment).

## Verdict
blockers_count: 0
