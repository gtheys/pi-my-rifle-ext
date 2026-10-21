# pi-flow

RPIV flow extension — `/research /plan /implement /validate /feedback`
phase commands plus the `/flow` orchestrator, routed over pi-planning,
pi-review, and pi-interactive-subagents (no cross-package runtime imports).
Canonical flow documentation: [`docs/rpiv-flow.md`](../../docs/rpiv-flow.md).

## Commands

| Command | What it does |
| --- | --- |
| `/research <topic \| symptom>` | Question loop + scouts → artifact in `notes/research/` → ticket-creation gate (explicit confirm; work: Jira, personal: aven). Debug symptoms route through the user's `debug` skill to a root cause. |
| `/plan <ref>` | Work: `feature-plan-aven` skill (epic tree, plan-state approval). Personal: size check → human-confirmed oneshot vs plan split; plan.md + epic/subtasks for plans. Ends with status `todo` + `planned` label — work mode: only after the approval-gated tree stage (premature `planned` would misroute `/implement`). |
| `/implement <ref>` | Gate: `planned` required; missing `researched` needs `--skip-research` (recorded durably as the `research-skipped` label — never asked twice). Routes bug / plan / oneshot. Worktree isolation, per-task implement→test→commit, retry budget 3 then blocked + escalate. |
| `/validate <ref>` | Work: ordered cluster gate (minikube → connectivity → queues → deploy → manual tests → Jira evidence comment). Personal: human runs the test. Then the review gate: `/review` → `blockers_count` artifact; 0 → land, >0 → back to `/implement`. |
| `/feedback <ref>` | Work: `/sonarqube` + `/pr-quality` triage (mechanical fixes committed, behavioral findings become new tasks). Personal: re-review + outcome summary note; only then `done`. |
| `/flow <ref> [--skip-research]` | Extension-owned loop: injects one phase prompt at a time (same builders the phase commands use, gates intact), then advances when the phase turn settles and its completion label has landed; missing label → halt note + stop. Resume = first phase whose completion label is missing. Work mode + Jira ID: find-or-create the local epic (`jira-ref` metadata, dep-linked to the synced ticket) and run on the epic ref. |

Lifecycle labels on the aven ticket are the run state:
`researched → planned → active → review-passed → done`; type labels
`bug` / `oneshot` / `plan` route `/implement`.

## Configuration

Global config lives at `~/.pi/agent/pi-flow/config.json` (schema:
[`config.schema.json`](config.schema.json)).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workRoots` | `string[]` | `[]` | Absolute path prefixes; a git toplevel under any prefix is `work` mode |

```json
{
  "$schema": "https://raw.githubusercontent.com/gtheys/pi-my-rifle-ext/main/packages/pi-flow/config.schema.json",
  "workRoots": [
    "/home/geert/Code/salaryhero"
  ]
}
```
