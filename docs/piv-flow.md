# PIV flow: plan → implement → validate → feedback

The canonical doc for the PIV flow implemented in
[`packages/pi-flow`](../packages/pi-flow). It supersedes
[`aven-feature-flow.md`](aven-feature-flow.md) (kept for history); the aven
phase/subtask tree and Jira pull-in contracts it documents still apply inside
the plan and implement phases.

Six slash commands, one package. `/flow` chains the four phase commands;
aven labels on the ticket ARE the run state. `/brainstorm` is a standalone
command outside the lifecycle: it explores how/what to implement and ends at
a confirm-gated ticket creation. A cold reader should be able to run
`/flow DP-1234` (work) or `/flow <aven-ref>` (personal) end-to-end from
this doc alone.

Source of truth: `packages/pi-flow` — phase prompts in `<phase>/prompt.ts`,
pure gates in `gates.ts`, `implement/routing.ts`, `implement/retry.ts`,
`validate/gate.ts`, `validate/review-gate.ts`, `flow/orchestrate.ts`.

---

## 1. Mode detection & configuration

On every command, `resolveMode(pi)` runs `git rev-parse --show-toplevel` on
the session cwd. A toplevel under any configured `workRoots` prefix is
**work** mode; anything else is **personal**. Prefix matching is
path-segment aware (`/foo/bar` does not match `/foo/barbaz`; equality
counts).

Config: global JSON at `~/.pi/agent/pi-flow/config.json`
(schema: `packages/pi-flow/config.schema.json`):

```json
{
  "$schema": "https://raw.githubusercontent.com/gtheys/pi-my-rifle-ext/main/packages/pi-flow/config.schema.json",
  "workRoots": ["/home/geert/Code/salaryhero"],
  "avenWorkspace": "personal"
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workRoots` | `string[]` | `[]` | Absolute path prefixes; a git toplevel under any prefix is work mode |
| `avenWorkspace` | `string` | unset | Aven workspace name or key forced on every aven call pi-flow makes (skips cwd inference and the search fallback) |

### Aven ref resolution

Aven infers the workspace from the cwd via project path mappings. On a
checkout with no mapping, pi-flow resolves refs deterministically: plain
`aven show <ref> --json` first; on `unknown-ref`, an exact-ref
`aven search` in the active workspace; then a sweep of every workspace
from `aven workspace list` (search per workspace, then re-show with
`--workspace <ws>`). The resolved workspace is memoized per ref for the
process. If nothing matches, the failure message names the exact fix —
never a bare `unknown-ref`:

```sh
# one-time mapping (recommended)
aven project path add pi-my-rifle-ext /path/to/this/checkout

# or force a workspace via the avenWorkspace config key above
```

Consequences of mode: `/brainstorm` tickets land in Jira (work) vs aven
(personal); plan/implement route to the `feature-plan-aven` /
`implement-plan-aven` skills (work) vs pi-flow's own size-check flow
(personal); validate runs the cluster gate (work) vs human-as-test-env
(personal); landing is PR (work) vs push-to-main (personal).

## 2. Label lifecycle

`packages/pi-flow/phase-state.ts` — aven labels are the run state. The
extension creates them best-effort on `session_start`.

| Phase complete | Label |
| --- | --- |
| `/plan` | `planned` |
| `/implement` | `active` |
| `/validate` | `review-passed` |
| `/feedback` | `done` |

Type labels: `bug`, `oneshot`, `plan` — set during `/brainstorm`'s ticket
gate (bug flow) or plan (size check); they route `/implement`.

## 3. The standalone `/brainstorm` command

`/brainstorm <topic | symptom>` is NOT a lifecycle phase — it is a
standalone entry point that produces understanding and a ticket. The PIV
lifecycle (`/flow`) starts at plan and requires an existing ticket ref;
`/brainstorm` is how a bare topic becomes one.

1. **Feature flow**: ask the user one question at a time (ask_user_question
   loop) until mechanism, scope, constraints are clear; spawn parallel scout
   subagents to map the code. **Debug flow** (`--debug` or symptom input):
   drive the user's `debug` skill to a root cause, then optionally scout.
2. Write a markdown artifact to `notes/brainstorm/<date>-<slug>.md`
   (`$LLM_NOTES_ROOT/<repo>/notes/brainstorm/` when set, else
   `<git-toplevel>/notes/brainstorm/`). Feature sections: Questions,
   Findings, Diagrams, Ticket implications. Debug sections: Questions,
   Findings, Hypothesis chain, Evidence.
3. **Ticket-creation gate**: propose destination (work: Jira project via
   acli; personal: aven workspace + project) and wait for an explicit
   "Confirm". Only then create the ticket, set the type label
   (`bug` for debug flow), and record the confirmation. Declined →
   nothing is created.
4. On aven tickets (personal mode), link the artifact as
   `research-path=<absolute path>` metadata (the key predates the
   `/brainstorm` rename and is kept for compatibility), so a later
   `/validate` can read the findings from the ticket itself. Jira tickets
   keep the artifact-header marker convention instead.

`/brainstorm` does NOT land a lifecycle label — completion is the artifact
plus the answered gate. The lifecycle starts when you run `/flow <ref>` or
`/plan <ref>` on the created ticket.

Ticket brainstorming (`/brainstorm ID=DP-71`, or a jira-shaped topic in work
mode) skips the creation gate: the ticket already exists. Resolution ladder:
local epic (`jira-ref` metadata, read the dep-linked synced ticket for the
description) → synced aven ticket (`jira-key` metadata) → `acli jira
workitem view` fallback.

## 4. The four phases

### 4.1 `/plan <ref>`

- **Work mode**: invoke the `feature-plan-aven` skill BY NAME and follow its
  workflow exactly (interview, scout, planner, plan.md, aven phase/subtask
  epic tree, plan-state approval gate — see
  [aven-feature-flow.md](aven-feature-flow.md) for those contracts
  unchanged). Jira IDs get the pull-in there. Afterwards: status `todo` +
  `planned` label — and only THEN: `planned` lands after the approval-gated
  tree stage (stage 2), not after plan.md alone. `/implement` routes
  oneshot vs plan from the type labels, so a premature `planned` would
  misroute the run. If approval does not happen during the phase, the
  ticket stays at plan-state `review` without `planned`; the flow halts at
  plan and `/flow` resumes there once the tree exists.
- **Personal mode**: size check then human-confirmed decomposition.
  1. Fetch the aven ticket + its notes; run the size heuristic: single-file /
     one-module change with one test surface → `oneshot`; data-model,
     cross-package, or multi-step-test change → `plan`.
  2. Present the verdict with reasons; the human CONFIRMS the split — never
     decompose without explicit confirmation.
  3. `oneshot`: type label `oneshot`, no epic — the ticket description IS
     the plan.
  4. `plan`: create the epic + subtasks (`aven epic add`), label `plan`,
     write `plan.md` to `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`
     (env fallback) or `<git-toplevel>/.pi/plans/<date>-<slug>/plan.md`.
  5. Status `todo` + `planned` label either way.

Gate precondition for later phases: the `planned` label.

**Completion labels are the advance gate.** Every phase prompt instructs the
agent to set its lifecycle label on completion — `planned`, `active`,
`review-passed`, `done` — because the /flow loop advances by reading
labels, never status. Implement additionally FORCES the plan route when the
ref is an epic with open children, even if the type labels say
oneshot: an oneshot prompt over an open tree batches the whole tree into one
cycle with no per-task workers.

### 4.2 `/implement <ref>`

Gate (`gates.ts` + `implement/routing.ts`): no `planned` label → refuse
("run /plan first").

Route by type label: `bug` → reproduce-first bug flow; `plan` →
`implement-plan-aven` skill BY NAME; default → oneshot single cycle.

Hard rules for every route:

- **Worktree isolation**: all implementation happens in an isolated git
  worktree; the main checkout is read-only. Branch: work mode →
  `jira_create_branch` for the ref; personal mode → conventional
  `feat/<slug>`.
- **Retry budget 3**: at most 3 total attempts per task (2 retries). Still
  red after the 3rd attempt → STOP, write failure evidence as an aven note
  (commands, last error, hypothesis), status `blocked`, escalate to the
  human. Never silently continue past a red test.
- **Each task = implement → tests → commit** (conventional subjects). Done
  only when green AND committed.

On completion the ticket carries the `active` label.

### 4.3 `/validate <ref>`

**Work mode — ordered gate, never reorder or skip** (`validate/gate.ts`):
minikube (bounded poll: 12 attempts, 10s apart, then FAIL) →
connectivity script → SQS-queues script → deploy via the `devctl` skill →
manual tests collected from the human (one fail fails the gate) → Jira
evidence comment via acli. The phase passes ONLY after the Jira comment
lands. Any step failure: STOP, aven note with step + full output, never
advance.

**Personal mode — the human is the test environment** (`validate/personal.ts`):
no cluster tools, no devctl, no acli. Read the plan and brainstorm artifacts
(located via the ticket's `research-path` metadata when present — absence
is normal and tolerated; a ticket that never went through `/brainstorm` has
no artifact to link), compose numbered runnable test steps + expected
outcome from them (all sections empty → STOP, never invent filler), present
via ask_user_question with pass/fail. Pass → aven note "validated by human,
<date>". Fail → aven note with the description, route back to `/implement`,
retry budget resets.

**Review gate (both modes, after the env/human gate passes)** — review now
gates validate:

1. Run `/review` (fresh-context reviewer, pi-flow) on the change.
2. Write the verdict as a machine-readable artifact: exactly one line
   `blockers_count: <N>` plus one `- blocker: <description>` line per
   blocker. Parsing is strict — missing, duplicated, or non-integer counts
   are errors; **never treat a malformed count as 0** (a silent 0 auto-lands
   broken code). Re-run `/review` instead.
3. `blockers_count: 0` → landing (§5).
4. `blockers_count > 0` → each blocker as an aven note on the ref, route
   back to `/implement` (retry budget applies), do not land.

On pass the ticket carries the `review-passed` label.

### 4.4 `/feedback <ref>`

- **Work mode**: run `/sonarqube` and `/pr-quality` (pi-flow, BY NAME) on
  the PR. Triage every finding: mechanical severities (`minor`, `style`,
  `naming`) that don't touch behavior/architecture/data/migrations/schema/API
  contracts are fixed and committed immediately; everything else — and any
  finding of undeterminable severity — becomes a NEW ticket through the flow
  gates. Nothing is fixed silently, nothing ignored. Also address unresolved
  GitHub review comments under the same rules. Completion: every finding is
  fix-and-commit or a new task; report final counts.
- **Personal mode**: if validate produced post-review fixes, re-run
  `/review` and address blockers under the same rules. Then write the
  outcome summary aven note ("## Outcome summary" with "What shipped", "Test
  evidence", "Review verdict"). The ticket goes `done` ONLY once that note
  exists.

## 5. Landing

| Mode | Landing |
| --- | --- |
| work | Push branch, create PR via pi-flow's gh tooling, post a Jira comment on the ref linking the PR |
| personal | Push the branch straight to main — standing no-PR rule on own repos |

Landing happens only after the review gate reports `blockers_count: 0`.

## 6. `/flow <ref>` — the orchestrator

`/flow` requires an existing ticket ref (aven ref, or a Jira ID in work
mode): a bare topic is refused with a pointer to `/brainstorm`, which is
how a topic becomes a ticket. `/flow` runs the REMAINING phases through an
**extension-owned loop** (`flow/loop.ts`), not a driver agent: an agent
cannot invoke slash commands, so a prompt asking it to "run /plan like a
human" just made the agent wander. The loop injects ONE phase prompt at a
time via `flow/phase-prompts.ts` (the exact builders the phase commands
use), then advances on the `agent_settled` event — code sequences the
phases, never the model.

- **Resume = first missing label** (`flow/orchestrate.ts`): the first phase
  whose completion label is absent on the ref is the one to run. Label
  present → phase skipped; label absent → (re-)run it. Killing the flow
  mid-phase resumes cleanly at that phase. All labels present → done.
- After each settled phase turn, the loop re-reads the ref's labels
  (`aven show`) and only advances when the phase's completion label has
  landed. Blocking gates (`ask_user_question`) keep the run in flight, so
  they are never raced.
- **Stop-on-fail as code**: label missing after settle, a blocked phase
  gate (e.g. implement without `planned`), or aven unreadable → the loop
  writes the aven note "flow halted at <phase>: <reason>", leaves labels
  untouched (ref stays at its last good label), and stops. No
  phase-skipping, no gate bypass. The user re-runs `/flow`; it resumes at
  the failed phase.
- Gates stay with the human — each phase prompt asks for its own
  confirmations; the loop never answers on the user's behalf.
- Run state is per-session (in-memory) + the journal on disk
  (`~/.pi/agent/pi-flow/runs/`); labels remain the durable state, so a
  session killed mid-flow just re-runs `/flow`.
- **Jira IDs (work mode)**: `/flow DP-71` resolves the local epic first
  (`flow/jira-ref.ts`): `jira-ref=DP-71` metadata lookup — one hit → run on
  that epic ref; none → find-or-create pull-in (`aven add --epic` +
  `--metadata jira-ref=…`, dep-linked to the synced ticket found via
  `jira-key=…`); ambiguous (multiple epics) or not aven-managed → abort
  with the reason. Every aven label, journal, and halt note uses the epic
  ref. Personal mode refuses Jira IDs. The phase commands resolve
  read-only: an existing epic replaces the Jira ID (so `/implement DP-71`
  reads the epic's labels), a miss passes the ID through to the prompt
  unchanged — `/plan DP-71` cold still lets the feature-plan-aven skill do
  its own pull-in.

Example runs:

```text
/flow DP-1234            # work mode: plan → implement → validate → feedback
/flow PMR-ABC1           # personal mode, same phases against aven
```

## 7. Failure & escalation policy

- **Retry budget 3** per implement task (see §4.2); escalation = blocked
  status + evidence note + human.
- Gate failures freeze the gate: validate stops at the failed step; review
  blockers route back to implement.
- Every failure lands as an aven note on the ref — notes are the durable
  record for resume.
- Feedback findings that aren't mechanical become new tickets through the
  full flow — never silent fixes during feedback.

## 8. Script & artifact path resolution

| What | Rule |
| --- | --- |
| Devctl scripts (validate, work mode) | `<first workRoot>/sh-devctl/scripts` (`resolveDevctlScriptsDir`). No `workRoots` configured → config error surfaced to the user, never a guess. |
| Brainstorm artifacts | `$LLM_NOTES_ROOT/<repo>/notes/brainstorm/<date>-<slug>.md`, else `<git-toplevel>/notes/brainstorm/…` |
| Personal plan.md | `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`, else `<git-toplevel>/.pi/plans/<date>-<slug>/plan.md` |
| Branch (work) | `jira_create_branch` from the Jira ref |
| Branch (personal) | `feat/<slug>` from the ticket slug |

Slug rule: lowercase, strip non-alphanumeric, max 5 words, dashes
(`packages/pi-flow/slugify.ts`).

## 8a. Attribution & observability env (PMR-HFK1)

Every `/flow` run stamps the **main process env** with attribution vars
(`flow/attribution.ts`, pure — charset-validated before they enter env, same
rule as the journal filename):

| Var | Set by | Meaning |
| --- | --- | --- |
| `PI_FLOW_REF` | `/flow` loop at run start | the ticket ref — per-ticket cost key |
| `PI_FLOW_PHASE` | re-stamped on every phase transition | research / plan / implement / validate / feedback |
| `PI_FLOW_TRACEPARENT` | run start (fresh W3C root per invocation) | children join the flow's trace tree |
| `PI_FLOW_SUBTASK` | the `subagent` spawn tool (`subtask` param) | plan-task ref for 1:1 worker spawns; omitted for scouts |

Mechanics:

- The subagents package forwards `PI_FLOW_REF/PHASE/TRACEPARENT` from the
  parent env into every child's `tab create --env` block (`flow-env.ts`,
  pure) and adds `PI_FLOW_SUBTASK` when the spawn carries a `subtask` param.
  Values failing the charset regex are dropped fail-closed, never forwarded
  mangled; with no active flow run nothing is stamped and plain subagent use
  is untouched.
- Terminal transitions (halt, plan-approval pause, done) **clear** all flow
  keys — a child spawned after a run ends cannot misattribute to it.
- Every spawn/resume/reattach is journaled as a `note` event in the run
  journal (child id + subtask mapping), so cost attribution survives even if
  env stamps are lost; reassignments attribute to whoever actually took over.
- The `subtask` ref is also persisted on the durable assignment record
  (`assignments.ts`), so takeovers after parent death keep the mapping.

## 9. Quick reference

| Purpose | Command |
| --- | --- |
| Topic → understanding + ticket (standalone) | `/brainstorm <topic>` · `/brainstorm --debug <symptom>` |
| Full run, resume-aware | `/flow <ref>` |
| Single phases | `/plan <ref>` · `/implement <ref>` · `/validate <ref>` · `/feedback <ref>` |
| Current run state | `aven show <ref> --full` — lifecycle labels are the phase ledger |
| Live run viewer (Herdr) | `/flow-view <ref> [right\|below\|left\|above\|tab]` — renders the run-state journal |
| Link the Herdr plugin | `/herdr-sync` (explicit, idempotent) |
| Jira-synced ticket pull-in (work) | handled inside `/plan` via `feature-plan-aven` — see [aven-feature-flow.md §1](aven-feature-flow.md) |
| Config | `~/.pi/agent/pi-flow/config.json` (`workRoots`) |

## See also

- [piv-flow-personal.md](piv-flow-personal.md) — personal-mode deep dive:
  every transition, status change, and auto-advance vs wait-for-human point,
  with diagrams.
- [piv-flow-work.md](piv-flow-work.md) — work-mode deep dive: the Jira↔aven
  epic mirror, Jira-ID resolution, the ordered cluster gate, PR landing, and
  the same auto-advance vs wait-for-human analysis.
- [herdr-flow-integration.md](herdr-flow-integration.md) — the Herdr viewer
  plugin, `/flow-view` / `/herdr-sync`, and the run-state journal
  (`~/.pi/agent/pi-flow/runs/`) that renders in the viewer pane.

pi-flow's only runtime dependency is `@gtheys/pi-interactive-subagents`
(spawn/watch substrate for the review and publish workers). A missing package
fails pi-flow's startup load loudly; a missing herdr mux degrades gracefully
per call site. Details: pi-flow README, "Dependencies".
- `openwiki/workflows/planning-and-implementation.md` — summary map.
- [aven-feature-flow.md](aven-feature-flow.md) — superseded; retains the
  aven tree contract, plan-state gate, Jira pull-in script, and quick aven
  command reference still used by work-mode plan/implement.
- `packages/pi-flow/README.md` — configuration and package layout.
