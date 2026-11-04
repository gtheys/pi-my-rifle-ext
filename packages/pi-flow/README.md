# pi-flow

RPIV flow extension — `/research /plan /implement /validate /feedback`
phase commands plus the `/flow` orchestrator, routed over
pi-interactive-subagents (pi-planning, pi-review and pi-worktree were
absorbed into this package — plan-tools, jira_create_branch, `/review`,
`/sonarqube`, `/pr-quality`, `/pr-watch`, the `worktree` tool and their
agent tools now live here).
Canonical flow documentation: [`docs/rpiv-flow.md`](../../docs/rpiv-flow.md).

## Commands

| Command | What it does |
| --- | --- |
| `/research <topic \| ID=<jira-id> \| symptom>` | Question loop + scouts → artifact in `notes/research/` → ticket-creation gate (explicit confirm; work: Jira, personal: aven). `ID=<jira-id>` (or a bare jira-shaped topic in work mode) researches the existing ticket instead: aven local epic first (`jira-ref` metadata), `acli jira workitem view` fallback; no creation gate, `researched` label lands on the epic. Debug symptoms route through the user's `debug` skill to a root cause. |
| `/plan <ref>` | Work: `feature-plan-aven` skill (epic tree, plan-state approval). Personal: size check → human-confirmed oneshot vs plan split; plan.md + epic/subtasks for plans. Ends with status `todo` + `planned` label — work mode: only after the approval-gated tree stage (premature `planned` would misroute `/implement`). |
| `/implement <ref>` | Gate: `planned` required; missing `researched` needs `--skip-research` (recorded durably as the `research-skipped` label — never asked twice). Routes bug / plan / oneshot. Worktree isolation, per-task implement→test→commit, retry budget 3 then blocked + escalate. |
| `/validate <ref>` | Work: ordered cluster gate (minikube → connectivity → queues → deploy → manual tests → Jira evidence comment). Personal: human runs the test. Then the review gate: `/review` → `blockers_count` artifact; 0 → land, >0 → back to `/implement`. |
| `/feedback <ref>` | Work: `/sonarqube` + `/pr-quality` triage (mechanical fixes committed, behavioral findings become new tasks). Personal: re-review + outcome summary note; only then `done`. |
| `/spec-review [--workspace <name>]` | Lists every spec at `plan-state=review` (aven metadata query), batch-picks them, opens each plan.md in a herdr nvim pane, and injects a review prompt: the session fixes spec issues in place; transitions to approved only via explicit "approve <REF>" (pins `plan` label, plan-state=approved, status todo). |
| `/spec-publish <ref>` | Launches a worker subagent that publishes the approved plan.md to the ticket's notes repo (plan-state gate). |
| `/review-spec <path>` | Opens a plan/spec in a herdr nvim `spec-review` pane (absorbed from pi-planning). |
| `/review [target]` | Code review via a fresh-context `reviewer` subagent — PR / branch / commit / uncommitted / folder / custom; optional ocr second opinion; emits a machine-readable `blockers_count: <N>` verdict the `/validate` review gate consumes (absorbed from pi-review). |
| `/sonarqube [pr]` | SonarCloud coverage gaps + quality issues for a PR, analysis-only (absorbed from pi-review). Requires `SONARQUBE_TOKEN`. |
| `/pr-quality [pr]` | Unresolved GitHub review threads + SonarCloud issues in one triage pass (absorbed from pi-review). |
| `/pr-watch` | Background-polls PR checks; auto-triggers `/pr-quality` when they complete (absorbed from pi-review). |
| `/herdr-sync` | Links this repo as a Herdr plugin (idempotent, explicit-only). |
| `/flow-view <ref> [placement]` | Opens/focuses a Herdr pane rendering the run-state journal for a ref. |
| `/flow <ref> [--skip-research]` | Extension-owned loop: injects one phase prompt at a time (same builders the phase commands use, gates intact), then advances when the phase turn settles and its completion label has landed; missing label → halt note + stop. Resume = first phase whose completion label is missing. Work mode + Jira ID: find-or-create the local epic (`jira-ref` metadata, dep-linked to the synced ticket) and run on the epic ref. |

Lifecycle labels on the aven ticket are the run state:
`researched → planned → active → review-passed → done`; type labels
`bug` / `oneshot` / `plan` route `/implement`.

## Tools

Agent-callable tools registered by pi-flow:

| Tool | What it does |
| --- | --- |
| `flow_phase_complete` | The ONLY way to write lifecycle labels — re-checks the phase gates before exec'ing aven; direct `aven edit --label` mutations are blocked at the bash tool_call boundary. |
| `flow_land` | Gates landing behind the `review-passed` label (+ optional `blockers_count` artifact); authorizes `git push` / `gh pr create` for the ref, which are otherwise blocked while a flow is active. |
| `flow_run_attempt` | Owns the implement-phase retry budget: 3 total attempts, the 3rd failure escalates and further attempts are refused. |
| `spec_approve` | Only path from plan-state `review` → `approved` (pins the `plan` label, moves the ticket to todo). |
| `resolve_spec_path` / `resolve_feature_path` | Canonical spec/plan.md path resolution for a Jira ticket or personal feature (absorbed from pi-planning). |
| `open_in_pane` | Opens a file with nvim in a herdr pane for review (absorbed from pi-planning). |
| `jira_create_branch` | Derives and creates a git branch from a Jira issue (absorbed from pi-planning). Requires `acli` + `git-town`. |
| `review` | Starts a code review of uncommitted changes / branch / commit / PR / folder / custom instructions (absorbed from pi-review). |
| `sonarqube` | Fetches SonarCloud coverage gaps + quality issues for a PR as an actionable report (absorbed from pi-review). |
| `pr_quality` | Gathers unresolved PR review threads + SonarCloud issues into a triage prompt (absorbed from pi-review). |
| `worktree` | Creates, lists, and removes Herdr-managed git worktree workspaces (absorbed from pi-worktree). |

## Configuration

Global config lives at `~/.pi/agent/pi-flow/config.json` (schema:
[`config.schema.json`](config.schema.json)).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workRoots` | `string[]` | `[]` | Absolute path prefixes; a git toplevel under any prefix is `work` mode |
| `avenWorkspace` | `string` | unset | Aven workspace name or key forced on every aven call pi-flow makes (skips cwd inference and the search fallback) |

```json
{
  "$schema": "https://raw.githubusercontent.com/gtheys/pi-my-rifle-ext/main/packages/pi-flow/config.schema.json",
  "workRoots": [
    "/home/geert/Code/salaryhero"
  ],
  "avenWorkspace": "personal"
}
```

### Aven ref resolution

Aven resolves refs against the workspace inferred from the current
directory via project path mappings. On a checkout without such a mapping,
pi-flow falls back automatically: `aven show <ref> --json` first, then an
exact-ref `aven search` in the active workspace, then a sweep of every
workspace from `aven workspace list`; the resolved workspace is pinned for
all later calls on that ref. If nothing matches, the failure names the
fix. Two one-time remedies:

```sh
# map this checkout to its aven project (recommended)
aven project path add pi-my-rifle-ext /path/to/this/checkout

# or pin the workspace explicitly in pi-flow config.json (see avenWorkspace)
```
