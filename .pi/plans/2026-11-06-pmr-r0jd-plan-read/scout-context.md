# Scout context — PMR-R0JD: open_in_pane "File not found" for a plan that exists (race)

## Relevant files

- `packages/pi-flow/spec-review/open-in-pane.ts` — `openFileInPane` does `resolve(file)` then **`existsSync` check immediately**; missing file → `File not found: <abs>` with `ok:false`, never retries. This is the exact error surface.
- `packages/pi-flow/plan-tools/resolve-feature-path.ts` + `plan-tools/helpers.ts` (`resolveFeaturePath`) — computes canonical plan.md path: `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md` or `<git toplevel>/.pi/plans/<date>-<slug>/plan.md`. Date = `new Date()` (UTC) at tool-call time; slug from `slugify(summary)`; toplevel via `pi.exec('git', ['rev-parse','--show-toplevel'])`.
- `packages/pi-flow/plan/paths.ts` — pure mirror of the same contract (`resolvePlanDir`); two implementations of the same rule that can drift.
- `packages/pi-flow/plan/prompt.ts` — /plan phase delegates entirely to the feature-plan-aven skill by name; flow itself never opens the file.
- `skills/engineering/feature-plan-aven/SKILL.md` (stage 6) — planner subagent task says: "Write the final plan to: <absolute plan.md path>" then "**After writing** the plan file, call open_in_pane with that path". Parent then flips `plan-state=review` when planner finishes.

## How the path is produced and consumed

1. Parent session calls `resolve_feature_path` once, embeds the ABSOLUTE path into: (a) `aven edit REF --metadata plan-path=<abs>` (plan-state=draft), and (b) the planner subagent task text.
2. Planner writes plan.md, then calls `open_in_pane(file=<abs>)`.
3. `openFileInPane` checks `existsSync` synchronously — no retry, no wait.

## Plausible root causes (ranked)

1. **Write/read race (matches reported evidence).** The planner's file write (bash/write tool) and the `open_in_pane` tool call were observed to run in parallel. Tool calls can be issued in the same turn; `existsSync` runs before the write flushes/lands. Nothing in open-in-pane.ts or the skill prompt enforces ordering.
2. **Slug/date drift between resolver calls.** `resolveFeaturePath` derives `<date>-<slug>` from a summary at each call. If the path is recomputed (by planner or parent) with a different summary wording or across a UTC midnight boundary, two different directories result. The skill mitigates this by threading one literal path, but the planner regenerating it (e.g. calling resolve_feature_path itself) breaks it.
3. **Toplevel mismatch.** `git rev-parse --show-toplevel` runs via `pi.exec` in the calling session's cwd. Planner runs in the main checkout (skill line ~409: no worktree at plan time), so this should agree — but if the parent resolved the path from a different cwd (e.g. repo root vs nested dir is fine, but a worktree session is not), the absolute paths diverge. Also two implementations (`helpers.ts` exec-based vs `plan/paths.ts` pure) can disagree if inputs differ.
4. **Relative path stored/used.** If `plan-path` metadata or the planner task carried a relative path, `resolve(file)` resolves against open_in_pane's caller cwd, not where the file was written. (Related known bug class: PMR-8XH9 — bind stores relative path unresolved.)

## Minimal fix options

- **A (cheapest, root cause 1):** in `openFileInPane`, on missing file do a short bounded retry/poll (e.g. 5 × 200ms) before returning "File not found". No contract change, fixes the race.
- **B:** in the skill's planner task text, strengthen wording: "Write the plan file and WAIT for the write to complete before calling open_in_pane; pass the exact path given above — never recompute it."
- **C:** have open_in_pane consult `plan-path` metadata / re-resolve via `resolveFeaturePath` when the given path is missing — heavier, only worth it if drift (causes 2–4) is also observed.
- **D:** single source of truth: make `plan-tools/helpers.ts` reuse `plan/paths.ts` to eliminate the dual implementation drift risk.

Recommend A + B: minimal, addresses the reported race without changing the path contract.

## Gotchas

- `existsSync` happens before the herdr split, so a false "not found" also skips pane creation — the file never gets opened later.
- Date is UTC (`toISOString`), local-date plans written near midnight can land in a different date dir than the resolver returned earlier.
- `plan-state=review` was already set — resume ladder reads plan-path from ticket metadata, so the file itself matters only for human review; the failure is UX, not state corruption.
