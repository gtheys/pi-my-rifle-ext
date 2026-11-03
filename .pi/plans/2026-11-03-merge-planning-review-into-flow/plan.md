# Merge pi-planning and pi-review into pi-flow

Epic: PMR-E025. Single maintainer (solo user), so install boundaries and
deprecation notices are non-goals. Target end state: two packages.

- `pi-flow`: flow + planning + review + worktree. One install, one mental model.
- `pi-interactive-subagents`: shared substrate for pi-flow and pi-test-runner.

All by-name prompt references (`/review`, `/sonarqube`, `jira_create_branch`,
the `blockers_count` verdict contract) become compile-time imports.

## Tree and execution order

| Order | Ticket | Title | Blocked by |
|---|---|---|---|
| 1 | PMR-T22H | Reorganize pi-flow internals (aven client, tools, command factory, mode profile) | — |
| 2 | PMR-XCA9 | Absorb pi-planning into pi-flow | — |
| 3 | PMR-W8SG | Absorb pi-review into pi-flow | PMR-T22H, PMR-XCA9 |
| 4 | PMR-K0ZV | Resolve the pi-worktree cycle | PMR-W8SG |
| 5 | PMR-WJE3 | Readability cleanup pass and manifest sync | PMR-K0ZV |

PMR-T22H and PMR-XCA9 are independent and can run in either order (or
parallel). Everything after is a strict chain.

## Phase 1: Reorganize pi-flow internals (PMR-T22H)

Prereq so incoming code lands in a clean house.

1. `aven/client.ts`: single aven boundary. Move exec, workspace resolution
   (`resolvedRefWorkspaces`, `avenOverrideArg`, `avenArgsWithWorkspace`,
   `resolveSpecWorkspace`), and the label/note/plan-state/epic helpers out of
   index.ts. `jira-ref.ts`, `aven-resolve-exec.ts`, `aven-spec.ts` consume the
   client; the duplicate `AvenRunner` type dies.
2. `tools/`: one file per tool plus a shared `toolResult` shaping helper.
   Sheds ~400 lines from index.ts.
3. Phase-command factory for the 5 identical command skeletons
   (parse, resolveMode, resolvePhaseRef, buildPhasePrompt, sendOrNotify).
4. `mode-profile.ts`: data-only mode table (landing route, artifact-root env,
   branch rule, ref rules). Prompts read values from it; prose stays put.

Verify: `node --test test/*.test.ts` green, no behavior change, index.ts
under ~500 lines. Known risk: index.ts exports (`readAvenLabels`,
`specApprove`, ...) are used by tests; keep the export surface or update all
test imports in the same commit.

## Phase 2: Absorb pi-planning into pi-flow (PMR-XCA9)

1. Move `plan-tools/` (resolve_spec_path, resolve_feature_path, jira-branch)
   and `implement-plan/jira-branch-tool.ts` into pi-flow.
2. Dedupe collisions: pi-flow already has `spec-review/open-in-pane.ts` and
   `research/paths.ts` mirroring plan-tools helpers. One path module, one
   open_in_pane survives.
3. Kill pi-planning's `/implement` command. It conflicts with pi-flow's
   `/implement` today; pi-flow's routing wins.
4. Repoint pi-worktree's `@gtheys/pi-planning` import at pi-flow, or inline
   the helper it uses (check first, likely small).
5. Retire the package: remove from workspaces, root README table, lockfile.

Verify: all suites green, `npm pack --dry-run -w pi-flow` manifest updated,
fresh install of pi-flow alone registers every tool.

## Phase 3: Absorb pi-review into pi-flow (PMR-W8SG)

1. Move `review/`, `pr-quality/`, `sonarqube/` into pi-flow (drop the `pi-`
   prefixes, they live inside the package now).
2. Replace by-name prompt references with imports. The big one:
   `validate/review-gate.ts` parses `blockers_count` while `review/verdict.ts`
   emits it. One module owns the contract after the merge.
3. `review.ts` imports `@gtheys/pi-interactive-subagents` (stays external,
   fine) and `@gtheys/pi-worktree/herdr.ts` (the cycle trigger, resolved in
   phase 4).

Verify: review/sonarqube/pr-quality tests run under pi-flow's test script;
tools register once.

## Phase 4: Resolve the pi-worktree cycle (PMR-K0ZV)

Default: absorb pi-worktree (1.8k lines). It kills the
review → worktree → planning cycle outright. Alternative: repoint review's
herdr import. Cheaper now, keeps the cycle-prone shape.

Verify: same as phase 3 plus pi-worktree's tests.

## Phase 5: Readability cleanup pass (PMR-WJE3)

1. Root README table, package READMEs, config docs synced.
2. `bun run lint` / `bun run format` across the merged package.
3. Final structure check: index.ts is wiring only; every decision lives in a
   pure module with tests.

## Sequencing rationale

Phases 1 and 2 are independent of each other and both unblock 3. Phase 3 is
the only one with real coupling risk (the worktree cycle), which is why 4
exists as its own decision point.
