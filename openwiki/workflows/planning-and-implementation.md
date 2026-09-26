# Planning & Implementation Workflow

How a feature — local personal or Jira-linked — becomes a written plan, then a
phased, resumable implementation across the `feature-plan-aven` /
`implement-plan-aven` skills, the aven orchestration tools in `pi-planning`
(`aven-tools` entrypoint), and the `worktree open` session handoff in
`pi-worktree`.

**This page is the map.** The canonical, detailed flow doc is
[`docs/aven-feature-flow.md`](../../docs/aven-feature-flow.md) (tool reference,
state diagrams, step-level detail) — keep that file authoritative; this page
summarizes and links.

## Tools own mechanics, skills own judgment

Deterministic orchestration (epic pull-in, tree creation, state gates, tree
reads, worktree session launch) lives in typed tools — see the
tool reference below. The skills keep only judgment prose: interview,
planner/worker prompts, mismatch triage, user gates.

## Aven replaces taskwarrior

Planning state moved from taskwarrior to **[aven](https://aven.raine.dev)** (a
local-first task manager; CLI primer lives in the global `aven` skill at
`~/.pi/agent/skills/aven/`). The aven-era changes dropped every `tw_*` tool and
the create-plan / feature-plan / iterate-plan / implement-plan taskwarrior
skills; what remains of `pi-planning` is path resolution + branch derivation +
`/implement` routing. Legacy taskwarrior trees still work via the legacy
`feature-plan` skill path documented in aven-feature-flow's boundaries, but all
new planning goes through aven.

Two artifacts, two sources of truth:

| Artifact | Role | Lives in |
|---|---|---|
| Aven ticket tree | **What** to do, in **what order**, and progress ledger | aven (local DB) |
| `plan.md` | **How** to do it — design, constraints, acceptance criteria | filesystem (`resolve_feature_path`) |

Aven infers workspace and project from cwd: personal projects → `personal`
workspace, work repos → `salaryhero`. `aven doctor` when routing looks wrong.

## The three delivery tiers

Every ticket executes in one mode, recorded as `delivery-mode` metadata
(classify via the `delivery_mode` tool; metadata wins over inference,
`investigate` is never inferred):

| Tier | Mode | What happens |
|---|---|---|
| 1 | `oneshot` | description is the spec → worker → tests → commit → done. No plan.md, no tree |
| 2 | `investigate` | findings + mini-plan posted as an aven note, then execute like a oneshot — proceed unless the user interrupts (no formal gate) |
| 3 | `planned` | full flow: scout → interview → plan.md → approval gate → tree → phased execution |

Escalation is one-way up (oneshot → investigate → planned), recorded via
`delivery_mode action=set` + a note. Tier-2 notes feed the tier-3 interview
when escalated.

## Entry points

- **`/plan <anything>`** — registered by `pi-interactive-subagents`, dispatch
  aven-first: Jira-shaped args and free text **both** inject the
  `feature-plan-aven` skill (it handles aven refs, aven-synced Jira IDs, and
  local features). Standalone installs fall back to the bundled generic
  `plan-skill.md`.
- **`/implement <AVEN-REF | JIRA-ID>`** — registered by
  `pi-planning/implement-plan`, routes to the `implement-plan-aven` skill.
- **`/skill:explore`** — pre-ticket codebase Q&A; no aven state until an
  explicit exit ramp ("create ticket" oneshot / "plan it" / nothing).

## The plan gate

The ticket tree exists **only after approval** — and the gate is enforced in
code: `create_feature_tree` reads `plan-state` first and refuses with zero
aven writes unless it is `approved`. `plan-state` metadata on the feature
ticket: `draft` (interview done, plan.md incomplete) → `review` (plan.md
complete, awaiting user) → `approved` (tree may be created). Only the user's
explicit "approve <REF>" moves review → approved (the agent runs
`advance_plan_state`, the word is the user's). Re-triggering the planning
skill on a ref branches on `plan-state`, which is what makes the flow
resumable across sessions.

## Tree shape (structural rules)

```
Feature ticket  metadata: plan-path=<abs plan.md>, plan-state=...  is_epic=true
  └── Phase   title="1. Phase: <name>"  labels=[phase,impl]  epic child, plan-path
        └── Subtask  title="1.1 <title>"  labels=[impl]  epic child, plan-path, depends_on phase
  └── Phase 2  ...  depends_on phase 1
```

1. **Grouping = epic membership** — feature ticket becomes an epic; phases and
   subtasks are all epic children (`aven epic add`). `plan-path` is the only
   metadata written per node.
2. **Ordering = dependency chain** — phase N depends on phase N−1
   (`aven dep add`), so `aven list --ready` exposes exactly one phase at a
   time; subtasks depend on their phase.
3. **Naming = `N.` / `N.M` title prefixes** — aven doesn't sort by prefix;
   the skills sort client-side. Prefixes are for humans.

Statuses: `inbox` = unsorted landing zone; pipeline `backlog → todo → active → done` (labels `phase`, `impl`). Metadata:
`plan-path`, `plan-state`, `delivery-mode`.

## Planning (`feature-plan-aven`) — stage 1 author, stage 2 tree

1. **Pickup** — Jira ID → `find_or_create_epic` first (below); then
   `aven show <REF> --full` + `aven context <REF>`; promote to epic.
2. **Scout** — read-only scout subagent maps the affected area into
   `scout-context.md`; main session ends turn, waits for the steer.
3. **`resolve_feature_path(summary)`** — canonical absolute plan.md path
   (`$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`, else
   `<git-toplevel>/.pi/plans/<date>-<slug>/plan.md`). Use verbatim.
4. **Interview** — one focused round (Goal / Behavior / Done when / Out of
   scope); contract recorded as an aven note + `delivery_mode` set (user
   picks, default `planned`); `plan-state=review` via `advance_plan_state`
   when the plan is written.
5. **Interactive planner subagent** — its own methodology (requirements,
   approaches, premortem, plan), writes plan.md; must NOT create aven tasks
   or commit.
6. **Stage 2, after "approve REF"** — `advance_plan_state` → `approved`,
   then `create_feature_tree` materializes phases + subtasks + epic
   membership + dep chain in one call (derives `N.`/`N.M` prefixes).
   Verify with `get_feature_tree`.

## Execution (`implement-plan-aven`)

**Classify first**: `delivery_mode` classify right after pickup — everything
forks on the tier (planned / oneshot / investigate).

Planned tier: `get_feature_tree` (sorted tree + `resumeRef` = first non-done
item — the resume mechanism) → read plan.md fully → workspace mode →
per-subtask worker subagents (sequential, never two in one repo; ≤2-line
changes go inline) → test → verification gate (wait for human) →
phase-scoped commit (wait again) → `close_phase` (returns next phase ref) →
finally feature `done`.

Workspace modes (Step 3):

| Mode | When | What happens |
|---|---|---|
| **push** (default) | planning session driving | `worktree create` → `worktree open` starts a pi agent in the worktree's Herdr pane; that session is the worker — handoff done |
| **orchestrated-pull** | main session drives, or no Herdr | workers spawned with `cwd` = worktree |
| **born-in-worktree** | this session's cwd IS the worktree | skip create/branch; run in-place |

Shortcuts:

- **Oneshot** — a ticket whose description is already a complete spec skips
  planning: worker → tests → commit → done. No plan.md, no tree.
- **Bug flow** — `--label bug` tickets skip planning; "debug <REF>" runs the
  `debug` skill wrapped in aven state (findings land as ticket notes; fix +
  regression test → done). Root-cause reveals design flaw → route to
  `feature-plan-aven`.

## Jira-synced tickets (pull-in)

Tickets synced from Jira by `jira-aven-sync` carry `jira-key` metadata and
live in the Jira project's aven project — never worked on directly. The
`find_or_create_epic` tool does the pull-in idempotently: finds the synced
ticket (workspace-wide `jira-key` filter) → finds-or-creates a **local epic**
in the repo's aven project (`jira-ref` metadata) → dep-links epic → synced
ticket. The whole flow then runs on the epic; specs use `resolve_spec_path`
instead of `resolve_feature_path`. The synced ticket is context + upstream
record only.

## `pi-planning` tool surface

Planning helpers:

| Piece | What |
|---|---|
| `resolve_spec_path` | `<notes-root-or-repo>/notes/specs/<JIRA_ID>__<slug>.md` (`$LLM_NOTES_ROOT` aware) |
| `resolve_feature_path` | `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md` or `.pi/plans/…` fallback |
| `open_in_pane` | opens a plan file with **nvim** in a herdr review pane |
| `jira_create_branch` | branch from Jira issue (type → prefix, summary → slug); optional git-town parent |
| `/implement` | routes to the `implement-plan-aven` skill |
| `/review-spec <path>` | open a spec/plan in a herdr review pane |

Aven orchestration (`aven-tools` entrypoint):

| Tool | What |
|---|---|
| `find_or_create_epic` | aven ref or Jira key → local epic (idempotent pull-in) |
| `advance_plan_state` | write plan-state (+ plan-path) metadata |
| `create_feature_tree` | materialize phase/subtask tree — **gated on plan-state=approved** |
| `get_feature_tree` | sorted tree + resume pointer (first non-done) |
| `close_phase` | mark phase done, return next open phase ref |
| `delivery_mode` | classify/set delivery mode (oneshot / investigate / planned) |

`pi-worktree` gains the `open` action: splits a pane in the worktree's Herdr
workspace, starts a pi agent (`herdr agent start --kind pi`), optional first
prompt → `{ path, workspaceId, paneId, agentName }`.

## See also

- `docs/aven-feature-flow.md` — the authoritative step-level flow + quick
  command reference (`aven list --ready`, metadata filters, plan-state gates).
- `skills/engineering/feature-plan-aven/SKILL.md`,
  `implement-plan-aven/SKILL.md`, `explore/SKILL.md` — the prose workflows.
- [Extension reference](../architecture/extensions.md#pi-planning-plan-tools--implement-plan)
  for source pointers.
