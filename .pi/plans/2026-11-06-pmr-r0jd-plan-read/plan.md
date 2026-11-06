# PMR-R0JD — open_in_pane races plan.md write

Scout: `scout-context.md` (same folder). Root cause: planner issued the plan write and `open_in_pane` in parallel; `openFileInPane` does one `existsSync` and fails.

Assumptions: planning runs in the main checkout (no worktree); retry budget 5 × 200ms.

## 1. Phase: Retry in openFileInPane

In `packages/pi-flow/spec-review/open-in-pane.ts`, replace the single `existsSync` check with a bounded poll (5 attempts, 200ms apart; injectable delay for tests). After the budget, return the existing "File not found" result unchanged. Add a unit test next to existing tests: file appearing after a short delay opens; file never appearing returns not-found.

Acceptance criteria:
- [ ] File created ~400ms after the call → `details.ok === true`
- [ ] File never created → `details.ok === false`, text `File not found: <abs>`
- [ ] Existing file → no added delay
- [ ] `bun run test` and `bun run lint` pass

Commit: `fix(pi-flow): retry open_in_pane while plan file is written`

## 2. Phase: Sequential write-then-open prompt wording

In `skills/engineering/feature-plan-aven/SKILL.md` (stage 6 planner task + fallback section) and `packages/pi-flow/README.md` if it describes open_in_pane: state that open_in_pane must be called only AFTER the plan.md write call has returned, never in parallel, and that the given absolute plan-path is reused verbatim (never recomputed).

Acceptance criteria:
- [ ] SKILL.md planner task text says write first, then open sequentially, reuse the path
- [ ] README consistent with the change
- [ ] `bun run test` and `bun run lint` pass

Commit: `docs(pi-flow): require sequential plan write then open_in_pane`

Out of scope: unifying helpers.ts vs plan/paths.ts; PMR-8XH9.
