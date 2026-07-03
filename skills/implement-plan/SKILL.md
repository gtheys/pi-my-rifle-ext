---
name: implement-plan
description: Execute an approved implementation spec by driving the work from taskwarrior. Given a Jira ID, locate the spec task, parse its annotation for the spec file, then walk the phase tasks (+phase tag) and their subtask trees (depends:) in order. Use when the user says "implement DP-121", "start work on IMP-7070", "continue the spec for <JIRA-ID>", "resume implementing <JIRA-ID>", or names a Jira ticket that has an approved spec. Do NOT use to author new specs — route those to create-plan.
---

# Implement Plan

Taskwarrior is the source of truth for *what* to do and *in what order*. The spec file in `notes/specs/` is the source of truth for *how*. This skill marries the two: it walks the taskwarrior task tree for a Jira ID, reads the spec for design context, and executes phase by phase with verification gates.

## Input contract

The user provides a **Jira ID** (e.g. `DP-121`). That's the only entry point. You can also be invoked via `/implement <JIRA_ID>` — in that case the execution plan summary is pre-populated in the prompt; use it but still call `tw_execution_plan` to get the full structured data.

If no Jira ID is given:

> Which Jira ticket should I implement? I need the ID so I can pull the task tree from taskwarrior.

## Taskwarrior data model — what to expect

### The `work_state` UDA — canonical values

```
approved, review, draft, rejected, todo, inprogress, done, new
```

Never invent values outside this list. The states this skill writes are `inprogress` and `done` (via `tw_advance_task`). The states it reads are `approved` (spec), `todo` / `inprogress` / `done` (phases/subtasks).

### The task tree

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

## Step 1 — Pull the execution plan

Call `tw_execution_plan` with the Jira ID:

```
tw_execution_plan({ jira_id: "DP-121" })
```

This returns:
- `plan.phases[]` — sorted by N. prefix, each with `uuid`, `number`, `name`, `work_state`, `subtasks[]`
- `plan.currentPhase` — first non-done phase (resume target)
- `plan.currentSubtask` — first non-done subtask within that phase (resume target)
- `plan.doneSubtasks / plan.totalSubtasks` — progress counters

**Immediately after pulling the plan**, call `tw_get_ticket` to check the issue type — do this before evaluating whether impl tasks exist:

## Step 1b — Bug fast path check (runs before any "no impl tasks" guard)

```
tw_get_ticket({ jira_id: "<JIRA_ID>" })
```

If `jiraissuetype === "Bug"` (or the task has the `+bug` tag), **take the bug fast path** — do NOT require a spec or impl tasks:

> ⚠️ Do NOT show the "no impl tasks" warning for bugs — it is expected and irrelevant.

### Bug fast path

Ask the user one question:

> Is the fix already clear, or do you need to investigate first?

**Fix is clear** → Skip Steps 2–5 (spec, branch script is still required). Go directly to Step 6 (execution loop) with simplified tracking:
- No phase tasks needed — work directly, file by file.
- Write tests first per `tdd-workflow`, then implement.
- After tests pass, present a commit message and wait for confirmation.
- Mark the Jira task done after user confirms.

**Fix is NOT clear** → Load `/skill:debug` immediately:
- Run through the debug skill's investigation workflow (logs, DB state, git history).
- Once root cause is identified, ask the user: "Fix now clear — want me to implement it?" then take the **Fix is clear** path above.

> For bugs, never block on a missing spec. Speed over ceremony.

**For non-bugs only:** if no impl tasks found after the bug check, tell the user `bugwarrior-pull` may need to run, or suggest `/plan <JIRA_ID>` if the spec hasn't been created yet.

---

## Step 2 — Locate the spec file

*(Skip entirely for bugs — use the bug fast path above.)*

Call `tw_get_spec_task` to get the spec task and extract the spec file path:

```
tw_get_spec_task({ jira_id: "DP-121" })
```

Resolve the path against the workspace: if `$LLM_NOTES_ROOT` is set, the spec lives at `$LLM_NOTES_ROOT/<repo>/<specRelPath>`; otherwise it's relative to the workspace root.

Read the spec **completely** before touching code. Note any `- [x]` marks; those phases are done.

If the spec task's `work_state` is not `approved`, warn once and ask whether to proceed.

## Step 3 — Verify working branch

Before touching any code, confirm the workspace is on the correct feature branch.

### 3a — Derive the expected branch name

Run the script in dry-run mode to get the canonical branch name without creating anything:

```bash
bash scripts/jira-branch.sh <JIRA_ID> --dry-run
```

Parse the `Branch:` line from the output — format is `<prefix>/<JIRA_ID>-<slug>`.

### 3b — Check the current branch

```bash
git rev-parse --abbrev-ref HEAD
```

### 3c — Act on the result

| Situation | Action |
|-----------|--------|
| Current branch == expected branch | ✓ Proceed |
| Expected branch exists locally (`git show-ref --verify refs/heads/<branch>`) | `git checkout <branch>` |
| Expected branch does not exist | `bash scripts/jira-branch.sh <JIRA_ID>` — creates branch and sets git-town parent |

If the script fails (e.g. `acli` not available or repo is a personal project with no Jira), report the error and ask the user how to proceed before continuing.

Do **not** skip this step even when resuming a partially complete spec — always confirm the branch.

## Step 4 — Build and present the execution plan

Using the `plan` from Step 1, present the full task tree to the user before starting:

- Phases with ✓ `done`, ▶ `inprogress`, or ○ `todo`
- Subtasks under each phase with the same icons
- Bold resume point: "Resuming at Phase N, subtask N.M <name>"

Skip phases already `work_state:done` — trust them unless codebase evidence suggests otherwise.

## Step 5 — Load companion skills

Before the first edit, load:

- `/skill:coding-standards` — style, naming, error handling, React patterns.
- `/skill:tdd-workflow` — tests first, ≥80% coverage.

These are mandatory. If either fails to load, surface it before proceeding.

## Step 6 — The execution loop

For each phase (starting from `plan.currentPhase`), in order:

### 5a — Mark phase inprogress

```
tw_advance_task({ uuid: "<phase-uuid>", state: "inprogress", description: "1. Phase: Setup" })
```

### 5b — For each subtask under that phase (starting from `plan.currentSubtask`):

1. `tw_advance_task({ uuid: "<subtask-uuid>", state: "inprogress", description: "1.1 ..." })`
2. Read all files the subtask touches — fully, not partial reads.
3. Reconcile spec with reality. If they disagree, **stop** and report (template below).
4. Write tests first (per `tdd-workflow`), then implementation.
5. Run tests: `run_tests({})` — wait for results before continuing.
6. Check off the matching item in the spec file (`- [ ]` → `- [x]`).
7. `tw_advance_task({ uuid: "<subtask-uuid>", state: "done", description: "1.1 ..." })`

### 5c — When all subtasks are done

Run `run_tests({})` once more to confirm the full phase result.

### 5d — Verification gate

Post this and **wait for human confirmation** before closing the phase:

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

Reply when manual testing is done and I'll close the phase and commit.
```

Do **not** close the phase or commit until the user confirms.

### 5e — Phase checkpoint

After user confirms:

```
tw_phase_checkpoint({
  jira_id: "DP-121",
  phase_uuid: "<uuid>",
  phase_number: 1,
  phase_name: "Setup"
})
```

This marks the phase done in taskwarrior and returns a `commitMessage`. Present it to the user:

```
Ready to commit:
  git add -u && git commit -m "<commitMessage>"

Confirm to commit, or edit the message.
```

Wait for confirmation, then run the git commit command.

### 5f — Move to next phase

Proceed to the next phase in `plan.phases` where `work_state !== "done"`.

If the user explicitly said "implement all phases" or "run end-to-end", skip inter-phase pauses and only stop at the end.

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

## Step 7 — Close the spec

After the final phase is committed and verified:

```
tw_get_spec_task({ jira_id: "DP-121" })
// then:
tw_advance_task({ uuid: "<spec-uuid>", state: "done", description: "SPEC: DP-121 ..." })
```

The parent Jira task is closed in Jira, not taskwarrior — leave it alone and report completion to the user with the Jira URL for their final transition.

## Resuming a partially complete spec

`tw_execution_plan` already handles this: `currentPhase` and `currentSubtask` point to the first non-done items. Start there. If `done` work looks stale relative to the codebase (renamed files, missing functions), flag it before continuing.

## Boundaries — what this skill does NOT do

- **Authoring specs** → `/skill:create-plan`
- **Modifying approved specs** → `/skill:iterate-plan`
- **Finding existing notes** → `/skill:notes-locator`
- **General taskwarrior workflow / state taxonomy** → `/skill:taskwarrior-plan`
