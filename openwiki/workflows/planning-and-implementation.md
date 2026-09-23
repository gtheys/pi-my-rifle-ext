# Planning & Implementation Workflow

How a feature — local personal or Jira-linked — becomes a written plan, then a
phased, resumable implementation across the `feature-plan-aven` /
`implement-plan-aven` skills and the slim `pi-planning` extension.

**This page is the map.** The canonical, detailed flow doc is
[`docs/aven-feature-flow.md`](../../docs/aven-feature-flow.md) (source skills +
full aven command contracts) — keep that file authoritative for step-level
detail; this page summarizes and links.

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

The ticket tree exists **only after approval**. `plan-state` metadata on the
feature ticket: `draft` (interview done, plan.md incomplete) → `review`
(plan.md complete, awaiting user) → `approved` (tree may be created). Only the
user's explicit "approve <REF>" moves review → approved. Re-triggering the
planning skill on a ref branches on `plan-state`, which is what makes the flow
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

Statuses: `inbox → todo → active → done` (labels `phase`, `impl`).

## Planning (`feature-plan-aven`) — stage 1 author, stage 2 tree

1. **Pickup** — `aven show <REF> --full` + `aven context <REF>`; Jira ID →
   pull-in first (below); promote to `--epic on --status todo`.
2. **Scout** — read-only scout subagent maps the affected area into
   `scout-context.md`; main session ends turn, waits for the steer.
3. **`resolve_feature_path(summary)`** — canonical absolute plan.md path
   (`$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`, else
   `<git-toplevel>/.pi/plans/<date>-<slug>/plan.md`). Use verbatim.
4. **Interview** — one focused round (Goal / Behavior / Done when / Out of
   scope); contract recorded as an aven note; `plan-state=review`.
5. **Interactive planner subagent** — its own methodology (requirements,
   approaches, premortem, plan), writes plan.md; must NOT create aven tasks
   or commit.
6. **Stage 2, after "approve REF"** — `plan-state=approved`, then create the
   tree per the aven output contract (one phase at a time, dep-chained).

## Execution (`implement-plan-aven`)

Discovery (`aven list --has-metadata plan-path --open`) → pull tree
(`aven epic list <REF> --json`, sort by prefix) → **currentPhase /
currentSubtask = first non-done item** (the resume mechanism — re-running
picks up exactly where it left off) → read plan.md fully → per-subtask worker
subagents (sequential, never two in one repo; ≤2-line changes go inline) →
test → verification gate (wait for human) → phase-scoped commit message
(wait again) → commit → phase `done` → finally feature `done`.

Shortcuts:

- **Oneshot** — a ticket whose description is already a complete spec skips
  planning: worker → tests → commit → done. No plan.md, no tree.
- **Bug flow** — `--label bug` tickets skip planning; "debug <REF>" runs the
  `debug` skill wrapped in aven state (findings land as ticket notes; fix +
  regression test → done). Root-cause reveals design flaw → route to
  `feature-plan-aven`.

## Jira-synced tickets (pull-in)

Tickets synced from Jira by `jira-aven-sync` carry `jira-key` metadata and
live in the Jira project's aven project — never worked on directly. Before
the flow: find the synced ticket (workspace-wide `jira-key` filter) →
find-or-create a **local epic** in the repo's aven project (`jira-ref`
metadata) → `aven dep add <EPIC> <SYNCED>`. The whole flow then runs on the
epic; specs use `resolve_spec_path` instead of `resolve_feature_path`. The
synced ticket is context + upstream record only.

## `pi-planning` today (what's left)

| Piece | What |
|---|---|
| `resolve_spec_path` | `<notes-root-or-repo>/notes/specs/<JIRA_ID>__<slug>.md` (`$LLM_NOTES_ROOT` aware) |
| `resolve_feature_path` | `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md` or `.pi/plans/…` fallback |
| `open_in_pane` | opens a plan file with **nvim** in a herdr review pane (glow was replaced) |
| `jira_create_branch` | branch from Jira issue (type → prefix, summary → slug); optional git-town parent. Requires `acli` + `git-town` |
| `/implement` | routes to the `implement-plan-aven` skill |
| `/review-spec <path>` | open a spec/plan in a herdr review pane |

## See also

- `docs/aven-feature-flow.md` — the authoritative step-level flow + quick
  command reference (`aven list --ready`, metadata filters, plan-state gates).
- `skills/engineering/feature-plan-aven/SKILL.md`,
  `implement-plan-aven/SKILL.md`, `explore/SKILL.md` — the prose workflows.
- [Extension reference](../architecture/extensions.md#pi-planning-plan-tools--implement-plan)
  for source pointers.
