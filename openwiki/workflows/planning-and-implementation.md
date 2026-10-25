# Planning & Implementation Workflow

**Map page.** The canonical, detailed flow doc is
[`docs/rpiv-flow.md`](../../docs/rpiv-flow.md) (packages/pi-flow:
`/research /plan /implement /validate /feedback /flow`) — read that for
step-level detail, gates, and config. This page only orients.

## The flow in one screen

Five phases, chained by the `/flow` orchestrator, tracked as **aven labels
on the ticket** (`researched → planned → active → review-passed → done` —
labels ARE the run state; resume = run the first phase whose label is
missing). Labels and landings are written **only** through pi-flow's
extension-owned gate tools — direct `aven edit --label`, `git push`, and
`gh pr create` calls are blocked while a flow is active:

- `flow_phase_complete` — the only way to apply a lifecycle label; refuses
  out-of-order completion.
- `flow_land` — verifies `review-passed` (and the `blockers_count` artifact
  when given) before authorizing a push (personal) or PR creation (work).
- `flow_run_attempt` — records each test attempt against the retry budget.
- `spec_approve` — the only path from plan-state `review` → `approved`
  (explicit "approve <REF>" only); a `/flow` run pauses gracefully while a
  spec awaits approval instead of halting.

1. **Research** — question loop + scouts → artifact in `notes/research/` →
   ticket-creation gate (explicit human confirm; work: Jira via acli,
   personal: aven) → `researched`.
2. **Plan** — work: `feature-plan-aven` skill (epic/dep tree, plan-state
   approval gate); personal: size check → human-confirmed oneshot-vs-plan
   split, plan.md + epic tree → `planned`.
3. **Implement** — gate: `planned` required; worktree isolation; routes
   bug / plan / oneshot; retry budget **3 total attempts** (the 3rd failure
   escalates and refuses further attempts) → blocked + escalate →
   `active`.
4. **Validate** — work: ordered cluster gate (minikube → connectivity →
   queues → deploy → manual tests → Jira evidence comment); personal: the
   human runs the test. Then the **review gate**: `/review` →
   `blockers_count` artifact; 0 → land, >0 → back to implement →
   `review-passed`.
5. **Feedback** — work: `/sonarqube` + `/pr-quality` triage (mechanical
   fixes committed; anything behavioral → new task through the gates);
   personal: re-review + outcome summary note → `done`.

Landing: work = PR + Jira comment; personal = push straight to main.

Mode comes from `workRoots` in `~/.pi/agent/pi-flow/config.json`: git
toplevel under a prefix → work mode, else personal.

## Skill-level contracts (work mode)

The work-mode plan and implement phases delegate BY NAME to the
`feature-plan-aven` / `implement-plan-aven` skills. Their aven epic-tree
contract, plan-state approval gate, Jira-synced pull-in, and quick aven
command reference live in the superseded-but-still-accurate
[`docs/aven-feature-flow.md`](../../docs/aven-feature-flow.md).

## See also

- `docs/rpiv-flow.md` — canonical flow doc (gates, retry budget, resume
  semantics, config, script-path resolution).
- `openwiki/workflows/code-review.md` — the review commands; review now
  gates validate.
- [Extension reference](../architecture/extensions.md#pi-planning-plan-tools--implement-plan)
  for pi-planning source pointers.
