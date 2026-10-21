# RPIV flow: research → plan → implement → validate → feedback

The canonical doc for the RPIV flow implemented in
[`packages/pi-flow`](../packages/pi-flow). It supersedes
[`aven-feature-flow.md`](aven-feature-flow.md) (kept for history); the aven
phase/subtask tree and Jira pull-in contracts it documents still apply inside
the plan and implement phases.

Six slash commands, one package. `/flow` chains the five phase commands;
aven labels on the ticket ARE the run state. A cold reader should be able to
run `/flow DP-1234` (work) or `/flow <aven-ref>` (personal) end-to-end from
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
  "workRoots": ["/home/geert/Code/salaryhero"]
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workRoots` | `string[]` | `[]` | Absolute path prefixes; a git toplevel under any prefix is work mode |

Consequences of mode: research tickets land in Jira (work) vs aven
(personal); plan/implement route to the `feature-plan-aven` /
`implement-plan-aven` skills (work) vs pi-flow's own size-check flow
(personal); validate runs the cluster gate (work) vs human-as-test-env
(personal); landing is PR (work) vs push-to-main (personal).

## 2. Label lifecycle

`packages/pi-flow/phase-state.ts` — aven labels are the run state. The
extension creates them best-effort on `session_start`.

| Phase complete | Label |
| --- | --- |
| `/research` | `researched` |
| `/plan` | `planned` |
| `/implement` | `active` |
| `/validate` | `review-passed` |
| `/feedback` | `done` |

Type labels: `bug`, `oneshot`, `plan` — set during research (bug flow) or
plan (size check); they route `/implement`.

## 3. The five phases

### 3.1 `/research <topic | symptom>`

Questions first, code second, ticket only after confirmation — both modes.

1. **Feature flow**: ask the user one question at a time (ask_user_question
   loop) until mechanism, scope, constraints are clear; spawn parallel scout
   subagents to map the code. **Debug flow** (`--debug` or symptom input):
   drive the user's `debug` skill to a root cause, then optionally scout.
2. Write a markdown artifact to `notes/research/<date>-<slug>.md`
   (`$LLM_NOTES_ROOT/<repo>/notes/research/` when set, else
   `<git-toplevel>/notes/research/`). Feature sections: Questions, Findings,
   Diagrams, Ticket implications. Debug sections: Questions, Findings,
   Hypothesis chain, Evidence.
3. **Ticket-creation gate**: propose destination (work: Jira project via
   acli; personal: aven workspace + project) and wait for an explicit
   "Confirm". Only then create the ticket, set the type label
   (`bug` for debug flow), and record the confirmation as a note. Declined →
   nothing is created.
4. Set the `researched` label.

### 3.2 `/plan <ref>`

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

### 3.3 `/implement <ref>`

Gate (`gates.ts` + `implement/routing.ts`):

- No `planned` label → refuse ("run /plan first").
- No `researched` label → requires the explicit `--skip-research` flag; the
  skip is recorded durably as the `research-skipped` label (plus an aven
  note) before work starts, so later invocations never re-demand the flag.

Route by type label: `bug` → reproduce-first bug flow; `plan` →
`implement-plan-aven` skill BY NAME; default → oneshot single cycle.

Hard rules for every route:

- **Worktree isolation**: all implementation happens in an isolated git
  worktree; the main checkout is read-only. Branch: work mode →
  `jira_create_branch` for the ref; personal mode → conventional
  `feat/<slug>`.
- **Retry budget 3**: at most 3 attempts per task. Still red after 3 → STOP,
  write failure evidence as an aven note (commands, last error, hypothesis),
  status `blocked`, escalate to the human. Never silently continue past a
  red test.
- **Each task = implement → tests → commit** (conventional subjects). Done
  only when green AND committed.

On completion the ticket carries the `active` label.

### 3.4 `/validate <ref>`

**Work mode — ordered gate, never reorder or skip** (`validate/gate.ts`):
minikube (bounded poll: 12 attempts, 10s apart, then FAIL) →
connectivity script → SQS-queues script → deploy via the `devctl` skill →
manual tests collected from the human (one fail fails the gate) → Jira
evidence comment via acli. The phase passes ONLY after the Jira comment
lands. Any step failure: STOP, aven note with step + full output, never
advance.

**Personal mode — the human is the test environment** (`validate/personal.ts`):
no cluster tools, no devctl, no acli. Read the plan/research artifacts,
compose numbered runnable test steps + expected outcome from them (all
sections empty → STOP, never invent filler), present via ask_user_question
with pass/fail. Pass → aven note "validated by human, <date>". Fail → aven
note with the description, route back to `/implement`, retry budget resets.

**Review gate (both modes, after the env/human gate passes)** — review now
gates validate:

1. Run `/review` (fresh-context reviewer, pi-review) on the change.
2. Write the verdict as a machine-readable artifact: exactly one line
   `blockers_count: <N>` plus one `- blocker: <description>` line per
   blocker. Parsing is strict — missing, duplicated, or non-integer counts
   are errors; **never treat a malformed count as 0** (a silent 0 auto-lands
   broken code). Re-run `/review` instead.
3. `blockers_count: 0` → landing (§4).
4. `blockers_count > 0` → each blocker as an aven note on the ref, route
   back to `/implement` (retry budget applies), do not land.

On pass the ticket carries the `review-passed` label.

### 3.5 `/feedback <ref>`

- **Work mode**: run `/sonarqube` and `/pr-quality` (pi-review, BY NAME) on
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

## 4. Landing

| Mode | Landing |
| --- | --- |
| work | Push branch, create PR via pi-review's gh tooling, post a Jira comment on the ref linking the PR |
| personal | Push the branch straight to main — standing no-PR rule on own repos |

Landing happens only after the review gate reports `blockers_count: 0`.

## 5. `/flow <ref>` — the orchestrator

`/flow` runs the REMAINING phases through an **extension-owned loop**
(`flow/loop.ts`), not a driver agent: an agent cannot invoke slash commands,
so a prompt asking it to "run /research like a human" just made the agent
wander. The loop injects ONE phase prompt at a time via `flow/phase-prompts.ts`
(the exact builders the phase commands use), then advances on the
`agent_settled` event — code sequences the phases, never the model.

- **Resume = first missing label** (`flow/orchestrate.ts`): the first phase
  whose completion label is absent on the ref is the one to run. Label
  present → phase skipped; label absent → (re-)run it. Killing the flow
  mid-phase resumes cleanly at that phase. All labels present → done.
- `--skip-research`: the loop records the skip itself (deterministic) as the
  durable `research-skipped` label + aven note and starts at plan; the SAME
  satisfied-rule (researched OR research-skipped OR flag) governs both /flow
  start and loop advance, and implement's gate accepts the recorded skip —
  manual `/implement <ref>` works without retyping the flag.
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
  with the reason. The research topic stays the Jira ID; every aven label,
  journal, and halt note uses the epic ref. Personal mode refuses Jira IDs.
  The phase commands resolve read-only: an existing epic replaces the Jira
  ID (so `/implement DP-71` reads the epic's labels), a miss passes the ID
  through to the prompt unchanged — `/plan DP-71` cold still lets the
  feature-plan-aven skill do its own pull-in.

Example runs:

```text
/flow DP-1234            # work mode: research → plan → implement → validate → feedback
/flow PMR-ABC1           # personal mode, same phases against aven
/flow PMR-ABC1 --skip-research
```

## 6. Failure & escalation policy

- **Retry budget 3** per implement task (see §3.3); escalation = blocked
  status + evidence note + human.
- Gate failures freeze the gate: validate stops at the failed step; review
  blockers route back to implement.
- Every failure lands as an aven note on the ref — notes are the durable
  record for resume.
- Feedback findings that aren't mechanical become new tickets through the
  full flow — never silent fixes during feedback.

## 7. Script & artifact path resolution

| What | Rule |
| --- | --- |
| Devctl scripts (validate, work mode) | `<first workRoot>/sh-devctl/scripts` (`resolveDevctlScriptsDir`). No `workRoots` configured → config error surfaced to the user, never a guess. |
| Research artifacts | `$LLM_NOTES_ROOT/<repo>/notes/research/<date>-<slug>.md`, else `<git-toplevel>/notes/research/…` |
| Personal plan.md | `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`, else `<git-toplevel>/.pi/plans/<date>-<slug>/plan.md` |
| Branch (work) | `jira_create_branch` from the Jira ref |
| Branch (personal) | `feat/<slug>` from the ticket slug |

Slug rule: lowercase, strip non-alphanumeric, max 5 words, dashes.

## 8. Quick reference

| Purpose | Command |
| --- | --- |
| Full run, resume-aware | `/flow <ref> [--skip-research]` |
| Single phases | `/research <topic>` · `/plan <ref>` · `/implement <ref>` · `/validate <ref>` · `/feedback <ref>` |
| Skip research explicitly | `/implement <ref> --skip-research` (`research-skipped` label + note recorded) |
| Current run state | `aven show <ref> --full` — lifecycle labels are the phase ledger |
| Live run viewer (Herdr) | `/flow-view <ref> [right\|below\|left\|above\|tab]` — renders the run-state journal |
| Link the Herdr plugin | `/herdr-sync` (explicit, idempotent) |
| Jira-synced ticket pull-in (work) | handled inside `/plan` via `feature-plan-aven` — see [aven-feature-flow.md §1](aven-feature-flow.md) |
| Config | `~/.pi/agent/pi-flow/config.json` (`workRoots`) |

## See also

- [herdr-flow-integration.md](herdr-flow-integration.md) — the Herdr viewer
  plugin, `/flow-view` / `/herdr-sync`, and the run-state journal
  (`~/.pi/agent/pi-flow/runs/`) that renders in the viewer pane.
- `openwiki/workflows/planning-and-implementation.md` — summary map.
- [aven-feature-flow.md](aven-feature-flow.md) — superseded; retains the
  aven tree contract, plan-state gate, Jira pull-in script, and quick aven
  command reference still used by work-mode plan/implement.
- `packages/pi-flow/README.md` — configuration and package layout.
