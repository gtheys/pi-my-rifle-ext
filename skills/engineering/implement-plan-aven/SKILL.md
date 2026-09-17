---
name: implement-plan-aven
description: Execute an aven feature tree created by feature-plan-aven. Given a feature ref (aven ref, e.g. PMR-ZTVG, or Jira ID of an aven-synced ticket, e.g. DP-71 — pulled into the repo's aven project as a local epic via the find-or-create pull-in), pull the phase/subtask tree from the ticket's epic children, read plan.md from the ticket's plan-path metadata, and execute phase by phase with a test/commit cycle closing each phase. Optional worktree mode — the feature executes in an isolated Herdr worktree (worktree create → workers spawn into it → finish/PR → remove). Tickets with a self-sufficient description and no plan can be executed directly as oneshots (single worker, single commit). Use when the user says "implement PMR-ZTVG", "implement DP-71", "start work on <aven-ref>", "resume the aven feature", "implement <REF> in a worktree", "oneshot <aven-ref>", or names an aven ticket or synced Jira ID whose tree was planned via feature-plan-aven. Do NOT use to author new plans — route those to feature-plan-aven.
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
ID (e.g. `DP-71`) of a synced ticket.

**Aven ref**: `aven show <INPUT> --json` (ref lookup only — JSON omits
metadata). `unknown-ref` may mean wrong workspace: run `aven doctor`, retry
with `--workspace <name>`.

**Jira ID**: run the **Jira pull-in (find-or-create epic)** from the repo
root FIRST — shared wording with feature-plan-aven. The epic is the feature
ref for the rest of this skill:

```bash
KEY=DP-71
# 1) Synced ticket — search the WHOLE workspace (omit --project); synced
#    tickets live in their Jira project's aven project (dp/imp/devops),
#    not the repo's. Filter out legacy epics planned directly on the ticket.
JIRA_REF=$(aven list --metadata jira-key=$KEY --json 2>/dev/null \
  | jq -r '.[] | select(.is_epic != true) | .ref' | head -1)
# [] / `unknown-metadata-field` → never synced → Jira-only work; no local execution
# (aven errors print on stderr — never merge 2>&1 into the jq pipe)

# 2) Repo's aven project — mapped? (projects infer from path mappings)
aven project path list --workspace salaryhero
# repo path unmapped → create + map in one shot (name = repo dir name)
aven project create "$(basename "$PWD")" --path "$PWD" --workspace salaryhero

# 3) Existing epic for THIS repo + ticket? (`jira-ref` marks pulled-in epics;
#    <repo-project-key> = the repo project's key from `aven project list`;
#    empty / `unknown-metadata-field` (lazy registration — no epic ever
#    pulled in) → not found → create below)
EPIC_REF=$(aven list --metadata jira-ref=$KEY --json 2>/dev/null \
  | jq -r --arg p <repo-project-key> '.[] | select(.project == $p) | .ref' | head -1)

# 4) Missing → create the epic in the repo's project, dep-link the synced ticket
EPIC_REF=$(aven add "$KEY — <synced summary>" --epic --status todo \
  --metadata jira-ref=$KEY \
  --description "Jira $KEY — source of truth: synced ticket $JIRA_REF." \
  2>&1 | grep -oP 'created \K\S+')
aven dep add $EPIC_REF $JIRA_REF   # epic blocked-by synced ticket; deps survive sync
```

The epic is a local task — sync never touches it. The synced ticket is
context + upstream record only.

### Workspace selection — personal vs salaryhero

The ref's workspace decides the flavor of the run, not the mechanics:

| | **personal** | **salaryhero** |
|---|---|---|
| Comes from | free-text `/plan` (local feature) | Jira ticket pulled in as a local epic (`jira-ref` metadata, dep-linked to the synced ticket) |
| Source of truth | the aven ticket itself | Jira; execution on the local epic (sync never touches it), spec context from the synced ticket |
| Branch | suggested `feat/<slug>` (no automation) | `jira_create_branch` from the epic's `jira-ref` value |
| PR | optional (pushing to a personal remote directly is fine) | required — PR review is the gate |

Both workspaces run the same execution loop; only branch/PR behavior differs.
The workspace comes from aven's cwd routing — verify with `aven doctor` if a
lookup unexpectedly misses.

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

Jira-linked epics (`jira-ref` metadata) can be oneshots too — the spec lives
on the SYNCED ticket's description (read it via the dep link / `$JIRA_REF`);
record clarifications and the outcome via `aven note` on the epic.

1. Sanity-check the description: it must state what to build and done-when.
   For a Jira-linked epic, that check runs against the synced ticket's
   description (`aven show $JIRA_REF --full`). Vague → ask targeted questions
   and record answers via `aven note <REF> --stdin`. Grows legs → route to
   `feature-plan-aven`.
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
handed only a subtask ref can still locate the plan — and its own
implementation summary + acceptance criteria in `--description`, so the
ticket alone is the executable spec. Resolve plan-path from
the subtask first, fall back to the feature ticket.

## Step 3 — Workspace: worktree (default) or in-place

Decide **where** this feature executes before touching any branch.

**Worktree mode is the default.** Run it unless one of these holds:

- the user explicitly asked for in-place work
- `herdr` is unavailable / not inside Herdr (`pi-worktree` can't run)
- the feature is a oneshot (single worker, single commit)

**Never silently fall back to in-place.** If `worktree list`/`create` fails,
report the error and ask the user before creating a plain branch instead.
All `pi-worktree` requirements apply (inside Herdr, `herdr` on PATH):

1. Check for an existing open worktree first — resume, don't duplicate:

   ```bash
   worktree({ action: 'list' })
   ```

   A worktree whose branch matches this feature (slug or Jira ID) → reuse it
   as `WORKTREE_PATH` and skip creation.

2. Create it (one feature = one worktree):

   ```bash
   worktree({
     action: 'create',
     jira_id: '<jira-ref value>',  // Jira-linked epics: branch derives from Jira
     name: '<feature-slug>',       // personal features: slug from the epic title
   })
   ```

   The create action derives the branch, bootstraps dependencies by lockfile,
   and copies `.env*` from the main checkout — it returns only after the
   install finishes, so tests can run immediately.

3. Record the worktree on the feature ticket so any session can resume:

   ```bash
   aven note <FEATURE_REF> --stdin <<'EOF'
   worktree: <WORKTREE_PATH> branch: <branch>
   EOF
   ```

4. Set `WORKTREE_PATH` for the rest of this skill: every git command,
   `run_tests`, and worker spawn targets the worktree. **The main checkout
   is read-only from here on** — the orchestrator never edits code there.

**In-place mode** — the exception, not the default: only for oneshots,
explicit user request, or when `pi-worktree` is unavailable. Behaves exactly
like the pre-worktree flow:

Check the `jira-ref` metadata in the `aven show <FEATURE_REF> --full` output
from Step 2 (Jira-linked epic pulled in from a synced ticket).

**Not Jira-linked** (no `jira-ref`): no branch automation (personal features).
If on `main`/`master` and about to edit, suggest one branch name (e.g.
`feat/<feature-slug>`) — one sentence, no tool call. Otherwise stay put.

**Jira-linked** (`jira-ref` present): derive the branch with
`jira_create_branch` (from the `pi-planning` package) using the `jira-ref`
value as the Jira ID, `cwd` set to the target repo root:

1. `jira_create_branch({ jira_id: "<jira-ref value>", cwd: "<repo root>", dry_run: true })` — `details.branch` is the expected branch (`<prefix>/<JIRA_ID>-<slug>`).
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
2. Read the subtask ticket's own description (`aven show <SUBTASK_REF>
   --full`) — feature-plan-aven wrote the implementation summary +
   acceptance criteria into it. Read the matching plan.md section only for
   wider context; skim the files it touches — enough to write a precise
   worker task.
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
     cwd: "<WORKTREE_PATH>",   // worktree mode: workers are born in the worktree
     task: [
       "Subtask: <N.M> <title>",
       "Ticket description (the spec — implement to this, verify against its acceptance criteria):",
       "<subtask ticket description verbatim: summary + acceptance criteria>",
       "",
       "Plan file: <absolute plan.md path> — read the section for this subtask for wider context only.",
       "",
       "Files: <files to create/modify>",
       "",
       "Write tests first, then implementation. Run the relevant tests via bash and show real output.",
       "Do NOT commit. Do NOT touch aven. Report changed files and test results in your final message.",
     ].join("\n"),
   })
   ```

   In worktree mode, omit `cwd` only when running in-place. The worker's
   `cwd` pins it to the worktree — it picks up the worktree's own `.pi/`
   config, deps, and `.env` snapshots, and physically cannot touch the main
   checkout. Parallel workers (if you consciously split disjoint-file
   subtasks) all get the same worktree `cwd`.

   The `subagent` tool returns immediately — **end your turn** and wait for
   the `subagent_result` steer. **Workers run sequentially: one subtask at a
   time, never two workers in the same repo at once.**

5. On result: resolve missing context with the user (never let the worker
   guess); review the diff (`git -C <WORKTREE_PATH> diff` / read files);
   run `run_tests({})` (worktree mode: with cwd = worktree) and wait.
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
     git -C <WORKTREE_PATH> add -u && git -C <WORKTREE_PATH> commit -m "feat(<scope>): <name> ..."

   Confirm to commit, or edit the message.
   ```

   Conventional subject with the repo's scope; explain the why in the body.
   Worktree mode: every git command carries `-C <WORKTREE_PATH>` (or runs
   with the worktree as cwd). In-place mode: plain git in the repo root.
4. Commit, then close the phase in aven:

   ```bash
   aven edit <PHASE_REF> --status done
   ```

Only then start the next phase. If the user said "implement all phases" /
"run end-to-end", skip inter-phase pauses and stop only at the end.

## Step 6 — Close the feature

Worktree mode — finish the feature (the workmux `merge` moment):

1. Push the branch and open the PR (manual GitHub flow, `pr-description`
   skill for the body):

   ```bash
   git -C <WORKTREE_PATH> push -u origin <branch>
   gh pr create --head <branch> ...
   ```

2. Leave the durable record on the feature ticket:

   ```bash
   aven note <FEATURE_REF> --stdin <<'EOF'
   PR: <pr-url> branch: <branch> worktree: <WORKTREE_PATH>
   EOF
   ```

3. Ask the user whether to remove the worktree now:
   - Yes → `worktree({ action: 'remove', cwd: '<WORKTREE_PATH>' })`.
     Removal is dirty-checked; `delete_branch` is gated on the PR being
     MERGED on GitHub — the branch survives until the PR is merged.
   - No → leave it; `worktree({ action: 'list' })` shows it on the
     dashboard and a later session resumes it via the aven note.

In-place mode — after the final phase is committed:

```bash
aven edit <FEATURE_REF> --status done
```

Jira-linked epics are local — `aven edit <FEATURE_REF> --status done` is
durable. The synced ticket's status stays sync-owned (jira-aven-sync remaps
it from Jira on every run): never edit it; the epic + its `aven note` are
the close record.

Report completion with the plan.md path and the commit list.

## Resuming

Step 1's first-non-done logic is the resume mechanism — done work is trusted
unless codebase evidence says otherwise; flag stale `done` items before
continuing. Worktree mode adds one resume source: the `worktree:` note on the
feature ticket (and `worktree list`) locates the existing workspace — reuse
it, never create a second worktree for the same feature.

## Boundaries — what this skill does NOT do

- **Authoring plans** → `feature-plan-aven`
- **Jira-linked but NOT aven-synced work** → work happens in Jira directly;
  synced Jira tickets execute here only as their pulled-in local epic
  (`jira-ref`), never as the synced task itself
- **Merging PRs** → stays human/manual; this skill pushes and opens the PR,
  never merges
- **Debugging** → `/skill:debug`; oneshot execution is for described changes,
  not diagnosis
