---
name: feature-plan-aven
description: Plan a local feature tracked as an aven ticket — pickup the ticket, interview, scout, interactive planner agent, plan.md artifact, and — only after explicit user approval of the plan — an aven phase/subtask hierarchy. Plans carry a plan-state gate (draft → review → approved); re-triggering on the same ref resumes at the right stage. Trigger on an aven ref (e.g. PMR-ZTVG), a Jira ID of an aven-synced ticket (e.g. DP-71 — pulled into the repo's aven project as a local epic via the find-or-create pull-in, `jira-ref` metadata, dep-linked to the synced ticket), or phrases like "plan this aven ticket", "aven feature plan". Always plan in the aven workspace routed to the current directory (salaryhero / personal).
---

# Feature Plan (Aven)

Turn an aven ticket into an approved plan, then into an aven hierarchy a
worker can execute. Two stages, gated:

- **Stage 1 — author the plan**: context + interview + plan.md. Ends with the
  ticket in `plan-state=review`. NO aven tree yet.
- **Stage 2 — create the tree**: only after the user explicitly approves
  ("approve <REF>"). Runs the output contract: phases/subtasks as epic
  children, each carrying its own `plan-path` metadata.

Plan lifecycle (metadata on the feature ticket): `draft` (interview done,
plan.md incomplete — resume to finish), `review` (plan.md complete, awaiting
user approval), `approved` (tree may be created). The agent sets
draft → review when the planner finishes; **only the user's explicit approval
sets review → approved** — the agent calls `advance_plan_state`, but the word
must be the user's. `implement-plan-aven` (sibling) executes the resulting
tree.

Grouping is native aven **epic membership**: the feature ticket becomes the
epic container, phases and subtasks are its children.

Workspaces: personal projects live in the aven `personal` workspace, work in
`salaryhero`. Aven infers the workspace from the cwd via its config routes —
run aven commands from the repo root; pass `--workspace <name>` only when
targeting another workspace. Verify routing with `aven doctor` if refs fail
with `unknown-ref`.

## Flow

```mermaid
flowchart TD
  A[Ticket in aven inbox/todo] --> B["find_or_create_epic tool<br/>(Jira key -> local epic, or ref passthrough)"]
  B --> B2["aven show REF --full + aven context REF"]
  B2 --> C[scout subagent -> scout-context.md]
  C --> D[interview: one round<br/>Goal / Behavior / Done when / Out of scope]
  D --> E["resolve_feature_path tool -> plan.md path"]
  E --> F["aven note REF --stdin (interview answers)<br/>delivery_mode tool (action=set, user choice)"]
  F --> G[interactive planner subagent writes plan.md]
  G --> H["advance_plan_state tool: draft -> review"]
  H --> GATE{user approves?<br/>possibly a later session}  GATE -->|iterate| G
  GATE -->|"approve REF"| I["advance_plan_state tool: review -> approved"]
  I --> J["create_feature_tree tool<br/>(gated on plan-state=approved; writes phases+subtasks)"]
  J --> K["get_feature_tree tool  (verify)"]
  K --> L["implement-plan-aven: get_feature_tree resume pointer<br/>(first non-done phase)"]
  L -->|per phase| M["run tests -> commit<br/>then close_phase tool"]
  M -->|next phase| L
```

## Stage 1 — Author the plan

### 1. Pickup (~30s)

**Ticket lookup and Jira detection.** Input may be an aven ref (`PMR-ZTVG`) or
a Jira ID (`DP-71`) of a synced ticket. Call `find_or_create_epic` with the
input ref/key first, before any other pickup step — `<REF>` for the rest of
this skill is the returned `epicRef`:

- Existing local epic or plain aven ref → returned unchanged, `created: false`.
- Jira key with no local epic yet → the tool finds the synced ticket
  (searches the whole workspace by `jira-key` metadata), creates a local
  epic in the repo's aven project tagged `jira-ref=<KEY>`, and dep-links it
  to the synced ticket (deps survive sync). `created: true`.
- Jira key with no synced ticket found at all → tool throws
  `no synced ticket found for Jira key` → not aven-managed → plan it in Jira
  directly.

The epic is a local task — sync never touches it, so everything on it
(`plan-path`, `plan-state`, notes, even `--description`) is durable.

**Workspace → flow mapping.** aven's two workspaces map to the two origins:

- **personal** — local features; free-text `/plan` lands here. The aven
  ticket is the source of truth; no Jira involvement.
- **salaryhero** — Jira-synced tickets. Jira stays the system of record;
  execution happens on a **local epic in the repo's aven project**, pulled
  in and dep-linked to the synced ticket (above). The synced aven copy is
  context only.

The workspace resolves from the cwd route automatically (`aven doctor` to
verify). Never plan a salaryhero-routed feature into the personal workspace
or vice versa — the ref lookup is workspace-scoped. `unknown-ref` may mean
wrong workspace: run `aven doctor`, retry with `--workspace <name>`.

`aven show <REF> --full` + `aven context <REF>`. For a pulled-in epic, the
spec context comes from the synced ticket: its description + `jira-url`
metadata via `aven show $JIRA_REF --full` — parse the
`metadata field_id=… key=K` / `value<<EOF … EOF` blocks from `show --full`
text; `show --json` omits metadata on aven 0.1.39. No acli, no live Jira
reads — the synced aven copy is the source. Skim `README.md`,
`AGENTS.md`, `package.json`, and the area the feature touches — just enough to
brief the scout.

### 2. Scout

Spawn read-only scout subagent(s) — parallel is fine:

```
subagent({
  name: "scout: <area>",
  agent: "scout",
  task: "Feature context: <summary>\n\nMap the affected area: file structure, key modules, conventions, similar existing features. Focus on what a planner needs before designing this feature. Save findings to: <artifact-folder>/scout-context.md",
});
```

End your turn after spawning. Wait for the `subagent_result` steer message(s),
then read the scout context back.

### 3. Resolve the plan artifact path

- **Local ticket**: call `resolve_feature_path` with the feature summary (tool
  from pi-planning — taskwarrior-agnostic, reused as-is).
- **Jira-linked ticket** (`jira-ref` metadata on the epic): call
  `resolve_spec_path` with the Jira ID and summary — the plan lands in the
  specs dir (`<JIRA>__<slug>.md`).

Use the returned absolute `plan.md` path verbatim everywhere below — never
hand-roll it, never shorten it, never `mkdir notes/` yourself.

### 4. Interview — one focused round

Ask only what you can't infer from scout findings, grouped in a single message.
Aim for 3–6 questions (behavior, scope, trigger/UX, constraints, edge cases,
boundaries). Always offer the out: "...or say 'use your judgment' and I'll pick
sensible defaults." If the user defers, pick defaults and mark them as
assumptions.

**Delivery-mode tier check (tier 2 — investigate).** If the interview reveals
the ask is really a diagnostic/exploration ("why is X happening", "look into
Y") rather than a build, don't run the full plan → tree pipeline. Call
`delivery_mode` with `action=set, mode=investigate`, post findings + a short
mini-plan as an `aven note` on the ticket, then proceed with the
investigation unless the user interrupts — no plan.md, no tree, no approval
gate. Document this choice in the note itself so a later resume sees why the
ticket skipped stage 1/2.

### 5. Contract on the feature ticket

Aven tickets already carry a title + description, so no task creation. Record
the interview + plan location, then set the delivery mode:

```bash
aven note <REF> --stdin <<'EOF'
Goal: ...
Behavior: ...
Done when: ...
Out of scope: ...
EOF
```

`plan-state` is not set yet — it stays unset/`draft` until the planner
finishes and `advance_plan_state` is called with `state=review` in step 6
(that call also records `plan-path`). Nothing to write here beyond the note.

Call `delivery_mode` with `feature_ref=<REF>`, `action=set`. Ask the user
which mode applies (`oneshot`, `investigate`, `planned`) when it isn't
already obvious from the interview; default to `planned` whenever a tree
will be requested (the common case for this skill).

`<REF>` is the qualified ref (e.g. `PMR-ZTVG`). Epic membership groups the
tree — every phase and subtask becomes a child of `<REF>` via
`create_feature_tree` in stage 2 (`get_feature_tree` returns the whole tree
back).

**Sync-safety (Jira-linked tickets):** the local epic is invisible to
jira-aven-sync — `plan-path`/`plan-state` metadata, notes, and the tree are
durable as-is. Only the **synced ticket** is sync-owned: sync overwrites its
title, status, priority, description, labels, and `jira-status` on every
run — never plan against it or store planning data on it. The `dep` link
survives sync (deps are not in the overwrite list). The gate is
`plan-state` metadata only, never aven status.

### 6. Spawn the interactive planner

```
subagent({
  name: "💬 Planner: <summary>",
  agent: "planner",
  interactive: true,
  task: [
    "Plan: <request>",
    "",
    "Scout findings:",
    "<scout-context summary or path>",
    "",
    "Interview answers:",
    "<Goal/Behavior/Done when/Out of scope>",
    "",
    "Write the final plan to: <absolute plan.md path>",
    "",
    "After writing the plan file, call the open_in_pane tool with that path to open it with nvim in a review pane. Skippable if the user declines or the tool is unavailable — never block on it.",
    "",
    "Write plan.md only. Do NOT create aven phases/subtasks — the tree is",
    "created in stage 2, only after the user approves the plan.",
  ].join("\n"),
});
```

The planner runs its own methodology (requirements, approaches, premortem,
plan) with the user — don't re-specify that. Your job is context. The planner
designs the phase breakdown inside plan.md; the aven tree is materialized
later, in stage 2, by `create_feature_tree`. Design points the plan must
satisfy:

- Every phase AND subtask becomes an epic child of `<REF>` when the tree is
  created — epic membership is the grouping key.
- `N.` / `N.M` title prefixes are REQUIRED — `create_feature_tree` numbers
  them from array order, and `get_feature_tree` sorts/resumes by them.
- **Phases chain via deps automatically** — `create_feature_tree` adds
  `phase N depends on phase N-1` for every phase after the first, so
  `--ready` shows exactly one phase at a time. The plan only needs to list
  phases in execution order.
- Every phase AND subtask section in plan.md carries a self-contained ticket
  body: 1–3 sentences of implementation detail (what to change, where, how)
  plus an explicit **Acceptance criteria** checklist. Stage 2 passes this
  text verbatim as each phase/subtask's `summary`/`body` param to
  `create_feature_tree`, which becomes the ticket `--description`.
  Self-contained — a worker who never opens plan.md still knows exactly
  what to build and when it's done.
- **Phases must be testable blocks**: the planner designs each phase so the repo
  is left green at its end — tests pass, then one commit scoped to that phase.
  A phase that can't end with `tests → commit` is too big or too small; split
  or merge it.
- The planner must NOT commit code, must NOT create aven tasks, and must NOT
  set status beyond `todo`.

When the planner finishes and plan.md is complete, flip the gate:

Call `advance_plan_state` with `feature_ref=<REF>`, `state=review`,
`plan_path=<absolute plan.md path>`.

Stage 1 ends here. Present plan.md to the user and stop — the tree is
created only after explicit approval, possibly in a later session.

## Stage 2 — Create the tree (after approval)

Precondition: the user has explicitly approved the plan ("approve <REF>").
Check state first — if `plan-state` is `draft`/`review`, stop: the plan is
not approved; offer to iterate instead (back to stage 1's planner with the
existing plan.md). On approval:

Call `advance_plan_state` with `feature_ref=<REF>`, `state=approved`.

Then call `create_feature_tree` with `feature_ref=<REF>`, `plan_path=<abs
plan.md path>`, and `phases` built from plan.md — one entry per phase in
plan order, each with `title`, `summary` (verbatim implementation summary +
acceptance criteria from that phase's plan.md section), and `subtasks`
(same shape: `title`, `body`). The tool re-checks `plan-state=approved`
itself and rejects (zero writes) if it isn't — this is the enforcement
point, not a courtesy check. On success it creates every phase/subtask as an
epic child of `<REF>`, numbers titles `N.`/`N.M`, and chains phase
dependencies.

Finish with verification: call `get_feature_tree` with `feature_ref=<REF>`.
Present the returned phase/subtask list to the user and ask them to review
both `plan.md` and the tree. Fixups go through `aven edit`/`aven dep`
directly (no tool wraps ad-hoc corrections).

### Fallback — no `subagent` tool

Do the scout work in the main session (`fast_context_search` / `grep` /
`read`) and write `plan.md` yourself. The two-stage split still applies:
plan first, tree only after explicit user approval, using the identical
`advance_plan_state` / `create_feature_tree` / `get_feature_tree` tool calls
above. Everything else — interview, notes, metadata, verification — is
unchanged. Call `open_in_pane` with the plan path after writing (skippable
on request; tool failure never blocks).

## Resuming a plan in a later session

Given a ref, check state before doing anything:

```bash
aven show <REF> --full    # parse `metadata … key=plan-state` / `key=plan-path` blocks
# or filter: aven list --metadata plan-state=<state> --open
```

`aven show --json` / `list --json` omit metadata on aven 0.1.39 — never read
metadata from JSON output (upgrade to JSON when aven gains
`show --json --metadata`).

- No `plan-path` → start at stage 1, step 1.
- `plan-state=draft` → read the ticket note (interview answers), finish the
  plan with the planner, then call `advance_plan_state` with `state=review`.
- `plan-state=review` → read plan.md fully, load it for the user, iterate
  until they approve or discard.
- `plan-state=approved` → call `get_feature_tree`: empty tree → stage 2
  (`create_feature_tree`); non-empty tree → route to `implement-plan-aven`.

## Phase discipline (execution)

Every phase ends with the same cycle — this is what makes phases testable
blocks rather than arbitrary buckets:

1. Run the project's tests (repo-defined runner, e.g. `bun run check`).
2. Commit with a phase-scoped message (explain the why, conventional subject).
3. Call `close_phase` with `phase_ref=<PHASE_REF>`, `feature_ref=<REF>` — marks
   the phase done and returns the next open phase ref (or `null` when all
   phases are done).

Only then does the next phase start. If tests fail, the phase is not done —
fix forward inside the same phase. The commit is the phase's artifact; the
aven status (via `close_phase`) is its ledger entry.

## What We're NOT Doing

- No taskwarrior — no UUID plumbing, no `work_state` UDA, no `jiraid`. This
  skill is the aven sibling of `feature-plan`.
- No live Jira — no acli, no writes/transitions. Synced tickets are read from
  their aven copy (written by jira-aven-sync); Jira-linked work NOT synced to
  aven stays in Jira — there is no local mirror for it anymore.
- No branch automation.
- No worktree creation — the planner works in the main checkout; execution
  isolation is `implement-plan-aven`'s job (its Step 3 defaults to creating
  the worktree at implement time). Mention in the plan document when a
  feature should run in-place instead (oneshot, no Herdr) so implement's
  default doesn't surprise anyone.
- No extra metadata for grouping — epic membership covers it; `plan-path` is
  the only metadata this flow writes beyond `plan-state`/`delivery-mode`.

## Integration with Other Skills

- Jira-linked work NOT synced to aven: plan it in Jira directly. aven
  workspaces (`salaryhero` / `personal`) split the local execution queues —
  this skill always works in the aven workspace routed to the current
  directory (`aven doctor` to verify). Synced tickets execute on their
  pulled-in local epic, never on the synced task itself.
- `implement-plan-aven` — resumes this hierarchy via `get_feature_tree`
  (`resumeRef` = first non-done phase). With worktree mode, it also resumes
  the feature's worktree from the `worktree:` note this flow's contract left
  on the ticket.
