# PMR-PKSS — Delta re-review on validate fix rounds

## Goal
Stop paying a full fresh-context review when validate re-enters after a fix round for already-recorded blockers. Keep the fail-closed invariant: `review-passed` only from a fresh `blockers_count: 0` verdict against the current tree.

## Decision
Policy (a): delta re-review. First entry = full review. Fix-round re-entry = delta review. No size threshold, no new config, no new run-state (detection is prompt-level via aven notes).

## Design
Edit `packages/pi-flow/validate/prompt.ts` (`buildReviewGateSection`, both personal and work/other branches; keep text shared via a helper to avoid drift):

1. Step 8/10 blocker recording: each blocker note also records `reviewed-at: <git rev-parse HEAD>` (the SHA that was reviewed).
2. Step 7 becomes a branch:
   - No prior review-blockers note on the ref -> full `/review` (unchanged).
   - Prior blockers note exists (fix round) -> run a DELTA review: `/review custom` with instructions containing the recorded blockers and the diff `git diff <reviewed-at>..HEAD`. Reviewer must (i) verify each recorded blocker is resolved, (ii) scan the fix diff for new blockers, (iii) emit the same `## Verdict` / `blockers_count` artifact (REVIEW_CONTRACT_PROMPT unchanged). Unresolved prior blocker counts as a blocker.
   - Missing/unparseable `reviewed-at` or empty diff -> fall back to full review (fail-closed toward more review, never less).
3. Steps 8–10 (strict parse, never treat malformed as 0, route on count, deviation gate, human code_review gate) unchanged. Human-pass validation is untouched.

## Out of scope
Dropping review from validate (PMR-MKG6, canceled); size thresholds; changes to `parseReviewArtifact` / review tool.

## Phase 1: Delta re-review prompt
Implementation: change `validate/prompt.ts` as above; extend `test/validate.test.ts` (or `test/review-gate.test.ts`) with prompt assertions.

Acceptance criteria:
- [ ] Both mode branches instruct full review when no prior blockers note exists, delta review when one does.
- [ ] Blocker note instruction includes `reviewed-at: <sha>`.
- [ ] Delta instructions require verifying prior blockers + scanning the fix diff and emitting the unchanged `blockers_count` contract; unresolved prior blocker counts as a blocker.
- [ ] Fallback to full review when `reviewed-at` is missing or the diff is empty.
- [ ] Human code_review / deviation gate text unchanged.
- [ ] `bun run lint` and the pi-flow tests pass (e.g. `bun test packages/pi-flow`).

### 1.1 Prompt change + tests
Single subtask covering the above (prompt edit and its tests ship in one commit).
