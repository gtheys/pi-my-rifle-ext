---
name: implement-plan-aven
description: Execute an aven feature tree created by feature-plan-aven. Given a feature ref (e.g. PMR-ZTVG), pull the phase/subtask tree via the feature=<suffix> metadata, read plan.md from the ticket's plan-path metadata, and execute phase by phase with a test/commit cycle closing each phase. Use when the user says "implement PMR-ZTVG", "start work on <aven-ref>", "resume the aven feature", or names an aven ticket whose tree was planned via feature-plan-aven. Do NOT use to author new plans — route those to feature-plan-aven.
---

# Implement Plan (Aven)

Aven is the source of truth for *what* to do and *in what order*; `plan.md`
is the source of truth for *how*. This skill marries the two: it walks the
aven tree grouped by `feature=<suffix>` metadata, reads plan.md, and executes
phase by phase. Each phase closes with the test/commit cycle — phases are
testable blocks (see "Phase discipline" in `feature-plan-aven`; this skill
enforces it, it does not redefine it).

## Input contract

The user provides a **feature ref** (e.g. `PMR-ZTVG`) — the aven ticket that
carries `plan-path` metadata and heads the phase/subtask tree.

If no ref is given, discover candidates:

```bash
aven list --has-metadata plan-path --open   # features with plans, not yet executed
```

If several match, ask which one. If the ticket has no `plan-path` metadata,
stop: it hasn't been planned — route to `feature-plan-aven`.

## Aven data model — what to expect

```text
Feature ticket   labels=[aven,planning]   metadata: plan-path=<abs plan.md>
  └── Phase task   title="1. Phase: <name>"  labels=[phase,impl]  metadata: feature=<SUFFIX>  status: todo|active|done
        └── Subtask  title="1.1 <title>"     labels=[impl]        metadata: feature=<SUFFIX>  status: todo|active|done
```

- Grouping: `feature=<SUFFIX>` metadata on every phase and subtask
  (`<SUFFIX>` = the feature ref suffix, e.g. `ZTVG`).
- Ordering: `N.` / `N.M` title prefixes. **Aven does not sort by them — you
  do**, when presenting and when resuming.
- Statuses: `todo`, `active`, `done` (read and written via `aven edit`).

## Step 1 — Pull the execution plan

```bash
aven list --json --metadata feature=<SUFFIX>          # full tree (all statuses)
aven list --metadata feature=<SUFFIX> --open          # human-readable, open only
```

Sort the JSON by title prefix: phases by `N.`, subtasks by `N.M`. Compute:
- **currentPhase** — first non-done phase in sorted order
- **currentSubtask** — first non-done subtask within it
- progress — `done subtasks / total subtasks`

Present the tree (✓ done / ▶ active / ○ todo) with the bold resume point:
"Resuming at Phase N, subtask N.M <name>".

## Step 2 — Read plan.md

```bash
aven show <FEATURE_REF> --json    # metadata.plan-path
```

Read plan.md **completely** before touching code. Note `- [x]` marks; those
are done. If plan-path metadata is missing, stop and route to
`feature-plan-aven`.

## Step 3 — Confirm branch

No branch automation (personal features). If on `main`/`master` and about to
edit, suggest one branch name (e.g. `feat/<feature-slug>`) — one sentence, no
tool call. Otherwise stay put.

## Step 4 — Load companion skills

Before the first edit, load `/skill:coding-standards` and
`/skill:tdd-workflow`. If either fails to load, surface it before proceeding.

The loop spawns `worker` subagents via the `subagent` tool. If unavailable,
implement directly in the main session — the flow is otherwise identical.

## Step 5 — The execution loop

For each phase from currentPhase, in order:

### Mark phase active

```bash
aven edit <PHASE_REF> --status active
```

### For each subtask (from currentSubtask):

**Trivial-subtask escape hatch**: ≤2 lines, no logic change → implement
inline; same steps otherwise. When in doubt, spawn the worker.

1. `aven edit <SUBTASK_REF> --status active`
2. Read the plan.md section for this subtask fully; skim the files it
   touches — enough to write a precise worker task.
3. Reconcile plan with reality. On mismatch, **stop** and report:

   ```
   Plan mismatch in Phase <N>, subtask <N.M>:
     Plan assumes: <what plan.md says>
     Codebase shows: <what's actually there>
     Options: a) ... b) ...
   How should I proceed?
   ```

4. Spawn a `worker` subagent:

   ```
   subagent({
     name: "worker: <N.M> <title>",
     agent: "worker",
     task: [
       "Subtask: <N.M> <title>",
       "Plan file: <absolute plan.md path> — read the section for this subtask fully before editing.",
       "",
       "<Plan excerpt: changes required, constraints, anti-patterns>",
       "",
       "Files: <files to create/modify>",
       "Acceptance criteria: <from the plan>",
       "",
       "Write tests first, then implementation. Run the relevant tests via bash and show real output.",
       "Do NOT commit. Do NOT touch aven. Report changed files and test results in your final message.",
     ].join("\n"),
   })
   ```

   The `subagent` tool returns immediately — **end your turn** and wait for
   the `subagent_result` steer. **Workers run sequentially: one subtask at a
   time, never two workers in the same repo at once.**

5. On result: resolve missing context with the user (never let the worker
   guess); review the diff (`git diff` / read files); run
   `run_tests({})` and wait.
6. Tick the matching item in plan.md (`- [ ]` → `- [x]`).
7. `aven edit <SUBTASK_REF> --status done`

### Phase close — the test/commit cycle

1. Run the project's full check once more (`run_tests({})` / repo runner).
2. Post the verification gate and **wait for human confirmation**:

   ```
   Phase <N> complete — ready for verification.

   Automated checks passed:
     - <check 1>

   Manual verification (from the plan):
     - <item 1>

   Reply when done and I'll close the phase (commit + aven status).
   ```

3. After confirmation, present a phase-scoped commit message and **wait
   again**:

   ```
   Ready to commit:
     git add -u && git commit -m "feat(<scope>): Phase <N> - <name> ..."

   Confirm to commit, or edit the message.
   ```

   Conventional subject with the repo's scope; explain the why in the body.
4. Commit, then close the phase in aven:

   ```bash
   aven edit <PHASE_REF> --status done
   ```

Only then start the next phase. If the user said "implement all phases" /
"run end-to-end", skip inter-phase pauses and stop only at the end.

## Step 6 — Close the feature

After the final phase is committed:

```bash
aven edit <FEATURE_REF> --status done
```

Report completion with the plan.md path and the commit list.

## Resuming

Step 1's first-non-done logic is the resume mechanism — done work is trusted
unless codebase evidence says otherwise; flag stale `done` items before
continuing.

## Boundaries — what this skill does NOT do

- **Authoring plans** → `feature-plan-aven`
- **Jira-linked work** → `implement-plan` (taskwarrior/jira flow)
- **Ad-hoc bugs with no plan** → handle directly or `/skill:debug`; this
  skill needs a plan.md + tree to drive from
