---
name: implement-plan
description: Execute an approved implementation spec by driving the work from taskwarrior. Given a Jira ID, locate the spec task, parse its annotation for the spec file, then walk the phase tasks (+phase tag) and their subtask trees (depends:) in order. Use when the user says "implement DP-121", "start work on IMP-7070", "continue the spec for <JIRA-ID>", "resume implementing <JIRA-ID>", or names a Jira ticket that has an approved spec. Do NOT use to author new specs — route those to create-plan.
---

# Implement Plan

Taskwarrior is the source of truth for *what* to do and *in what order*. The spec file in `notes/specs/` is the source of truth for *how*. This skill marries the two: it walks the taskwarrior task tree for a Jira ID, reads the spec for design context, and executes phase by phase with verification gates.

## Input contract

The user provides a **Jira ID** (e.g. `DP-121`). That's the only entry point. If they hand you a spec path directly, ask for the Jira ID so the taskwarrior tree is in scope — implementation without ticking off tasks breaks the workflow.

If no Jira ID is given:

> Which Jira ticket should I implement? I need the ID so I can pull the task tree from taskwarrior.

## Taskwarrior data model — what to expect

### The `work_state` UDA — canonical values

The `work_state` UDA is the per-task lifecycle field. It is **string-typed with an enumerated set**:

```
approved, review, draft, rejected, todo, inprogress, done, new
```

**Never invent values outside this list** — taskwarrior will accept the string but the color rules and downstream tooling expect exact matches. The states this skill writes are `inprogress` and `done`. The states it reads are `approved` (spec), `todo` (phases/subtasks pending), `inprogress` (in flight), `done` (complete). Other values (`new`, `draft`, `review`, `rejected`) appear on other task types but this skill doesn't transition them.

### The task tree

For a single Jira ID, taskwarrior holds a small tree:

```
Jira task         status:pending  tags:[jira]            work_state:new
  └── Spec task   status:pending  tags:[spec]            work_state:approved
        annotation: "Spec(repo=<repo>): <repo>/notes/specs/<file>.md"
  └── Phase task  status:pending  tags:[impl, phase]     work_state:todo
        description: "1. Phase: <title>"
        └── Subtask   status:pending  tags:[impl]        work_state:todo
              description: "1.1 <title>"
              depends: [<phase-uuid>]
        └── Subtask   "1.2 ..."  depends: [<phase-uuid>]
  └── Phase task  "2. Phase: ..."
        └── Subtask "2.1 ..."   depends: [<phase-uuid>]
```

Key facts:

- **All tasks share `jiraid:<JIRA-ID>`**. That's the join key.
- **Phase tasks** carry both `+impl` and `+phase`. Their description starts with `N. Phase:`.
- **Subtasks** carry `+impl` only. Their description starts with `N.M`. They link to their phase via `depends:[<phase-uuid>]`.
- **Order is encoded in the description prefix** (`1.`, `1.1`, `2.`, `2.1` …), not in `urgency` or `entry`.
- **Spec path lives in an annotation** on the spec task: `Spec(repo=<repo>): <repo>/notes/specs/<file>.md`.
- **work_state progression for impl tasks:** `todo` → `inprogress` → `done`. Move it as you go.

## Step 1 — Pull the tree

```bash
JIRA_ID="DP-121"   # from the user

# Everything for this Jira ID, in one shot
task jiraid:"$JIRA_ID" status:pending export > /tmp/tw.json
```

Sanity check the result:

```bash
jq 'length' /tmp/tw.json   # should be >= 3 (jira + spec + at least one phase)
```

If empty: tell the user `bugwarrior-pull` may need to run, or the Jira ID is wrong, and stop.

## Step 2 — Locate the spec file

Parse the spec task's annotation:

```bash
spec_rel=$(jq -r '
  .[] | select(.tags // [] | index("spec")) |
  .annotations[]?.description |
  capture("Spec\\(repo=(?<repo>[^)]+)\\): (?<path>.+)") | .path
' /tmp/tw.json)
# e.g. "ewa-api/notes/specs/DP-121__e2e-db-tests-dual-read.md"
```

Resolve the path against the workspace. If `$LLM_NOTES_ROOT` is set, the spec lives at `$LLM_NOTES_ROOT/$spec_rel`; otherwise it's relative to the workspace root. If the file isn't found at either location, stop and report — do not guess.

Read the spec **completely** before touching code. Note any `- [x]` marks already present; those phases are done.

If the spec task's `work_state` is not `approved`, warn once and ask whether to proceed.

## Step 3 — Build the execution plan

Extract phases in numeric order from their description prefix:

```bash
jq -r '
  [ .[] | select((.tags // []) as $t | ($t | index("phase")) and ($t | index("impl"))) ]
  | sort_by(.description | capture("^(?<n>[0-9]+)\\.").n | tonumber)
  | .[] | "\(.uuid)\t\(.description)\t\(.work_state)"
' /tmp/tw.json
```

For each phase, enumerate its subtasks by walking `depends:`:

```bash
PHASE_UUID="a5524e87-988d-4b6e-b5fb-fd9138856940"
jq -r --arg p "$PHASE_UUID" '
  [ .[] | select((.depends // []) | index($p)) ]
  | sort_by(.description | capture("^(?<a>[0-9]+)\\.(?<b>[0-9]+)").b | tonumber)
  | .[] | "\(.uuid)\t\(.description)\t\(.work_state)"
' /tmp/tw.json
```

Present this plan to the user as your todo list before starting. Skip phases already marked `work_state:done` (don't re-do completed work — trust it unless something looks visibly broken).

## Step 4 — Load companion skills

Before the first edit, load:

- `/skill:coding-standards` — style, naming, error handling, React patterns.
- `/skill:tdd-workflow` — tests first, ≥80% coverage.

These are mandatory. If either fails to load, surface it before proceeding.

## Step 5 — The execution loop

For each phase, in order:

1. **Mark the phase `inprogress`:**

   ```bash
   task <phase-uuid> modify work_state:inprogress
   ```

2. **For each subtask under that phase, in `N.M` order:**
   a. `task <subtask-uuid> modify work_state:inprogress`
   b. Read all files the subtask touches — fully, not partial reads.
   c. Reconcile spec with reality. If they disagree, **stop** and report (template below).
   d. Write tests first (per `tdd-workflow`), then implementation.
   e. Run the phase's success criteria from the spec (usually `make check test` or `yarn test`).
   f. Check off the matching item in the spec file (`- [ ]` → `- [x]`).
   g. `task <subtask-uuid> modify work_state:done && task <subtask-uuid> done`

3. **When all subtasks are done, run the phase's full success criteria once more** to confirm the integrated result.

4. **Pause for human verification** (see gate below). Do not advance until the user confirms.

5. **Mark the phase done:**

   ```bash
   task <phase-uuid> modify work_state:done
   task <phase-uuid> done
   ```

6. **Move to the next phase.**

If the user explicitly said "implement all phases" or "run end-to-end", skip the inter-phase pause and only stop at the end. Default is phase-by-phase.

### Verification gate

After automated checks pass for a phase, post:

```
Phase <N> complete — ready for manual verification.

Taskwarrior progress:
  - Subtasks marked done: <N.1>, <N.2>, ...
  - Phase task: <phase-uuid> ready to close

Automated checks passed:
  - <check 1>
  - <check 2>

Manual verification (from the spec):
  - <item 1>
  - <item 2>

Reply when manual testing is done and I'll close the phase task and start Phase <N+1>.
```

Do **not** check off manual-verification items in the spec, and do **not** mark the phase task `done`, until the user confirms.

### Spec mismatch template

```
Spec mismatch in Phase <N>, subtask <N.M>:
  Spec assumes: <what the spec says>
  Codebase shows: <what's actually there>
  Why it matters: <impact>
  Options:
    a) <option>
    b) <option>
How should I proceed?
```

## Step 6 — Close the spec

After the final phase is verified and closed:

```bash
# Close the spec task
task jiraid:"$JIRA_ID" +spec modify work_state:done
task jiraid:"$JIRA_ID" +spec done
```

The parent Jira task is closed in Jira, not taskwarrior — leave it alone and report completion to the user with the Jira URL for their final transition.

## Resuming a partially complete spec

If some tasks are already `work_state:done`:

- Trust them. Skip their work.
- Pick up from the first phase or subtask that isn't `done`.
- If `done` work looks stale relative to the current codebase (renamed files, missing functions), flag it before continuing.

## Starting a branch (optional)

If the user hasn't created a working branch yet, offer `scripts/jira-branch.sh <JIRA_ID>`. It derives the branch name from the issue type and summary, creates it, and sets `develop` as the git-town parent. Use `--dry-run` to preview. Requires `acli`, `jq`, `git`, `git-town`.

## Boundaries — what this skill does NOT do

- **Authoring specs** → `/skill:create-plan`
- **Modifying approved specs** → `/skill:iterate-plan`
- **Finding existing notes** → `/skill:notes-locator`
- **General taskwarrior workflow / state taxonomy** → `/skill:taskwarrior-plan`

If a request lands here that belongs elsewhere, name the right skill and hand off — don't half-do another skill's job.
