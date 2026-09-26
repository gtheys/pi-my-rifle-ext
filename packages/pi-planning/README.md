# pi-planning

Pi extension with aven-era planning helpers. Task management lives in
[aven](https://aven.raine.dev) (see `feature-plan-aven` / `implement-plan-aven`
skills); this package keeps only the non-taskwarrior pieces:

- canonical plan/spec path resolution
- nvim-in-herdr-pane review of plan files
- Jira branch derivation for aven-synced tickets

## Extensions

| Entry | Description |
|---|---|
| `plan-tools/index.ts` | `resolve_spec_path`, `resolve_feature_path`, `open_in_pane` tools + `/review-spec` command |
| `implement-plan/index.ts` | `jira_create_branch` tool + `/implement <AVEN-REF | JIRA-ID>` command routing to `implement-plan-aven` |
| `aven-tools/index.ts` | `find_or_create_epic`, `advance_plan_state`, `create_feature_tree`, `get_feature_tree`, `close_phase`, `delivery_mode` tools |

## Tools

| Tool | Description |
|---|---|
| `resolve_spec_path` | Canonical spec file path for a Jira ticket (`$LLM_NOTES_ROOT/<repo>/notes/specs/…` or repo-local `notes/specs/`) |
| `resolve_feature_path` | Canonical feature `plan.md` path (`$PERSONAL_FEATURES/<repo>/<date>-<slug>/` or repo-local `.pi/plans/<date>-<slug>/`) |
| `open_in_pane` | Open a file with nvim in a new herdr pane (plan review) |
| `jira_create_branch` | Derive a git branch from a Jira issue (type → prefix, summary → slug); optional git-town parent |
| `find_or_create_epic` | Resolve an aven ref or Jira key to a local epic (idempotent pull-in) |
| `advance_plan_state` | Set plan-state metadata (draft → review → approved) |
| `create_feature_tree` | Materialize phase/subtask tree (gated on plan-state=approved) |
| `get_feature_tree` | Sorted phase/subtask tree + resume pointer |
| `close_phase` | Mark phase done, return next open phase ref |
| `delivery_mode` | Classify/set delivery mode (oneshot / investigate / planned) |

## Commands

| Command | Description |
|---|---|
| `/implement <AVEN-REF \| JIRA-ID>` | Route to the `implement-plan-aven` skill |
| `/review-spec <path>` | Open a spec/plan file with nvim in a herdr review pane |

## Requirements

- Optional: `acli` + `git-town` (for `jira_create_branch`), `nvim` + Herdr (for `open_in_pane`)
