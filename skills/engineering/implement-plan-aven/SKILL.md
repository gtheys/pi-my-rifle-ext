---
name: implement-plan-aven
description: Execute an aven feature tree created by feature-plan-aven. Given a feature ref (aven ref, e.g. PMR-ZTVG, or Jira ID of an aven-synced ticket, e.g. DP-71 — resolved via jira-key metadata), pull the phase/subtask tree from the ticket's epic children, read plan.md from the ticket's plan-path metadata, and execute phase by phase with a test/commit cycle closing each phase. Tickets with a self-sufficient description and no plan can instead be executed directly as oneshots (single worker, single commit). Use when the user says "implement PMR-ZTVG", "implement DP-71", "start work on <aven-ref>", "resume the aven feature", "oneshot <aven-ref>", or names an aven ticket or synced Jira ID whose tree was planned via feature-plan-aven. Do NOT use to author new plans — route those to feature-plan-aven.
---

# Implement Plan (Aven)

Aven is the source of truth for *what* to do and *in what order*; `plan.md`
is the source of truth for *how*. This skill marries the two: it walks the
feature ticket's **epic children**, reads plan.md, and executes phase by
phase. Each phase closes with the test/commit cycle — phases are testable
blocks (see "Phase discipline" in `feature-plan-aven`; this skill enforces
it, it does not redefine it).

## Input contract

The user provides a **feature ref** — an aven ref (e.g. `PMR-ZTVG`) or a Jira
ID (e.g. `DP-71`) of a synced ticket. Resolve Jira IDs to aven refs with the
two-step detection (shared wording with feature-plan-aven):

```bash
aven show <INPUT> --json || true                # aven ref? (ref lookup only — JSON omits metadata)
aven list --metadata jira-key=<INPUT> --json    # Jira ID? → item .ref
# unknown-ref + empty/`unknown-metadata-field` lookup → not synced → route to implement-plan
```

`unknown-metadata-field` means no ticket has ever carried `jira-key` (fields
register lazily) — treat as "not found", not a failure. Wrong workspace also
yields `unknown-ref`: run `aven doctor`, retry with `--workspace <name>`.

The feature ticket carries `plan-path` metadata and heads the phase/subtask
tree.

If no ref is given, discover candidates:

```bash
aven list --has-metadata plan-path --open   # features with plans, not yet executed
```

If several match, ask which one. If the ticket has no `plan-path` metadata
and no epic children, it is either unplanned or a **oneshot** — ask the user
which, then route to `feature-plan-aven` or follow "Oneshot execution"
below. If the ticket has `plan-state` metadata that is not `approved`, stop:
the plan is still in draft/review — route back to `feature-plan-aven` to
finish or approve it.

## Oneshot execution — ticket without a plan

For tickets whose description is already a complete spec: small, single-
commit changes that don't need a plan.md or a tree. Trigger: "oneshot
<REF>", or "implement <REF>" on a plan-less ticket after the user confirms
the oneshot route.

Synced tickets (jira-key metadata) can be oneshots too — but their description
is sync-owned: record clarifications and the outcome via `aven note`, never
via `--description` edits (sync overwrites them).

1. Sanity-check the description: it must state what to build and done-when.
   Vague → ask targeted questions and record answers via
   `aven note <REF> --stdin`. Grows legs → route to `feature-plan-aven`.
2. `aven edit <REF> --status active`
3. Load `/skill:coding-standards` + `/skill:tdd-workflow`. Spawn one `worker`
   subagent with the description as the spec (tests first, run them, show
   output; do NOT commit, do NOT touch aven). No worker tool → implement
   inline.
4. Review the diff; `run_tests({})`.
5. Present a commit message, wait for confirmation, commit.
6. Leave the outcome on the ticket and close it:

   ```bash
   aven note <REF> --stdin <<'EOF'
   Oneshot: <what was done>. Commit <hash>.
   EOF
   aven edit <REF> --status done
   ```

No plan.md, no tree, no phase gates. If the work balloons past one commit,
stop and route to `feature-plan-aven`.

## Aven data model — what to expect

```text
Feature ticket  labels=[...]  metadata: plan-path=<abs plan.md>, plan-state=approved  is_epic=true
  └── Phase task   title="1. Phase: <name>"  labels=[phase,impl]  epic child, plan-path  status: todo|active|done
        └── Subtask  title="1.1 <title>"     labels=[impl]        epic child, plan-path, depends_on phase  status: todo|active|done
  └── Phase task   title="2. Phase: <name>"  labels=[phase,impl]  epic child, depends_on phase 1  status: todo|active|done
        └── Subtask  title="2.1 <title>"     labels=[impl]        epic child, depends_on phase  status: todo|active|done
```

- Grouping: **epic membership** — phases and subtasks are children of the
  feature ticket (`aven epic list <FEATURE_REF> --json` returns the tree;
  the TUI epic view shows it too).
- Phase ordering: **hard guarantee** — each phase depends on the previous, so
  `--ready` exposes exactly one phase at a time. The `N.` prefix remains for
  humans and sorting.
- Subtask ordering: `N.M` title prefixes. **Aven does not sort by them — you
  do**, when presenting and when resuming.
- Statuses: `todo`, `active`, `done` (read and written via `aven edit`).

## Step 1 — Pull the execution plan

```bash
aven epic list <FEATURE_REF> --json     # whole tree, all children
aven epic list <FEATURE_REF>            # human-readable
aven list --ready --label phase         # exactly the unblocked phase (dep chain)
```

Sort children by the title prefix: phases by `N.`, subtasks by `N.M` (both
labels `impl`; phases also carry `phase`). Compute:
- **currentPhase** — first non-done phase in sorted order
- **currentSubtask** — first non-done subtask within it
- progress — `done subtasks / total subtasks`

Present the tree (✓ done / ▶ active / ○ todo) with the bold resume point:
"Resuming at Phase N, subtask N.M <name>".

## Step 2 — Read plan.md

```bash
aven show <FEATURE_REF> --full    # parse `metadata … key=plan-path` block
```

`aven show --json` / `list --json` omit metadata on aven 0.1.39 — never read
metadata from JSON output (upgrade to JSON when aven gains
`show --json --metadata`).

Read plan.md **completely** before touching code. Note `- [x]` marks; those
are done. If plan-path metadata is missing, stop and route to
`feature-plan-aven`.

Every phase and subtask carries its own `plan-path` metadata copy — a worker
handed only a subtask ref can still locate the plan. Resolve plan-path from
the subtask first, fall back to the feature ticket.

## Step 3 — Confirm branch

Check the `jira-key` metadata in the `aven show <FEATURE_REF> --full` output
from Step 2.

**Not synced** (no `jira-key`): no branch automation (personal features). If
on `main`/`master` and about to edit, suggest one branch name (e.g.
`feat/<feature-slug>`) — one sentence, no tool call. Otherwise stay put.

**Synced** (`jira-key` present): derive the branch with `jira_create_branch`
(from the `pi-planning` package), `cwd` set to the target repo root:

1. `jira_create_branch({ jira_id: "<jira-key>", cwd: "<repo root>", dry_run: true })` — `details.branch` is the expected branch (`<prefix>/<JIRA_ID>-<slug>`).
2. `git rev-parse --abbrev-ref HEAD` to check the current branch.
3. On the expected branch → continue. Branch exists but not checked out → `git checkout <branch>`. Missing → call `jira_create_branch` without `dry_run` (creates branch, sets git-town parent).

If the tool call fails (acli missing, etc.), report and ask before continuing.
Do not skip this even when resuming a partially complete feature.

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
     git add -u && git commit -m "feat(<scope>): <name> ..."

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

On synced tickets the aven status is sync-owned (jira-aven-sync remaps it from
Jira on every run) — the `aven note` is the durable close record; the status
edit is best-effort.

Report completion with the plan.md path and the commit list.

## Resuming

Step 1's first-non-done logic is the resume mechanism — done work is trusted
unless codebase evidence says otherwise; flag stale `done` items before
continuing.

## Boundaries — what this skill does NOT do

- **Authoring plans** → `feature-plan-aven`
- **Jira-linked but NOT aven-synced work** → `implement-plan`
  (taskwarrior/jira flow); synced tickets (jira-key metadata) are handled here
- **Debugging** → `/skill:debug`; oneshot execution is for described changes,
  not diagnosis
