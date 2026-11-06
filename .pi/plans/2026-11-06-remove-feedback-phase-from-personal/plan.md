# PMR-GFM5 — Remove feedback phase from personal flow

Research: notes/brainstorm/2026-11-06-pmr-gfm5.md

## Goal / behavior
Personal mode no longer has a separate `/feedback` phase or re-review step. The
outcome-summary aven note and `status=done` + `done` label happen inside the
validate phase, after a successful `flow_land` push. Work mode is unchanged.

## Done when
- Personal `/flow` ends after validate (no feedback prompt injected); `done` label + status done + summary note exist on the ticket after push.
- Work mode phase order and prompts unchanged.
- `/feedback` in personal mode refuses with a clear message.
- Verification: `bun run check`.

## Out of scope
Work-mode feedback (sonarqube / pr-quality), label names, label-gate ordering semantics for work.

## Design
- `mode-profile.ts`: add `phases: readonly Phase[]` (work = all four; personal = plan, implement, validate).
- `flow/orchestrate.ts`: `nextPhase(labels, mode)` iterates the mode's phases; default mode `work` keeps callers compatible.
- `flow/label-gate.ts`: `done` (feedback) label is still written through `flow_phase_complete(feedback)`; in personal mode the gate requires only `review-passed` before it (same ordering), so the tool works from inside validate.
- `validate/prompt.ts` personal gate: after `flow_land` ok and push, (a) write `## Outcome summary` aven note (What shipped / Test evidence / Review verdict; never invent filler), (b) set status done, (c) call `flow_phase_complete(feedback)`.
- `flow/phase-prompts.ts` / `feedback/prompt.ts`: remove personalSection; `/feedback` personal returns refusal.
- `/flow` description in `index.ts` updated.

## Phase 1. Mode-keyed phase list and nextPhase
Add `phases` to MODE_PROFILE; make `nextPhase` take mode; thread mode through `flow/loop.ts` advanceAfter.

Acceptance criteria:
- [ ] personal: labels planned+active+review-passed → `{kind:'done'}`; work: same labels → feedback.
- [ ] Existing orchestrate/loop tests pass; new tests cover both modes.
- [ ] `bun run check` green.

## Phase 2. Personal validate prompt owns summary + done
Extend personal code-review gate in `validate/prompt.ts` with post-push steps; remove personal feedback prompt and make `/feedback` refuse in personal mode; update `/flow` text and README.

Acceptance criteria:
- [ ] Personal validate prompt names the summary note, status done, and `flow_phase_complete(feedback)` after flow_land ok + push.
- [ ] `/feedback` in personal mode refuses; work mode prompt unchanged.
- [ ] phase-prompts, feedback, flow tests updated; `bun run check` green.
