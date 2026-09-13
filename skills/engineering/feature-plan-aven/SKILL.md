---
name: feature-plan-aven
description: Plan a local feature tracked as an aven ticket — pickup the ticket, interview, scout, interactive planner agent, plan.md artifact, and — only after explicit user approval of the plan — an aven phase/subtask hierarchy. Plans carry a plan-state gate (draft → review → approved); re-triggering on the same ref resumes at the right stage. Trigger on an aven ref (e.g. PMR-ZTVG), a Jira ID of an aven-synced ticket (e.g. DP-71 — resolved via jira-key metadata), or phrases like "plan this aven ticket", "aven feature plan" for a personal project. Aven tickets carrying jira-key metadata (from jira-aven-sync) are planned here too — always in the aven workspace routed to the current directory (salaryhero / personal).
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
sets review → approved** — the agent runs the `aven edit`, but the word must
be the user's. `implement-plan-aven` (sibling) executes the resulting tree.

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
  A[Ticket in aven inbox/todo] --> B["aven show REF --full + aven context REF"]
  B --> C[scout subagent -> scout-context.md]
  C --> D[interview: one round<br/>Goal / Behavior / Done when / Out of scope]
  D --> E["resolve_feature_path tool -> plan.md path"]
  E --> F[interactive planner subagent writes plan.md]
  F --> G["aven edit REF --epic on --status todo<br/>--metadata plan-path=ABS, plan-state=draft→review"]
  G --> GATE{user approves?<br/>possibly a later session}  GATE -->|iterate| F
  GATE -->|"approve REF → plan-state=approved"| H["aven add 'N. Phase: name' --label phase --label impl<br/>--metadata plan-path=ABS"]
  H --> H2["aven epic add PHASE REF"]
  H2 --> H2b["aven dep add PHASE PREV_PHASE<br/>(order guarantee: one phase ready at a time)"]
  H2b --> I["aven add 'N.M title' --label impl --metadata plan-path=ABS"]
  I --> I2["aven epic add SUB REF (+ dep add SUB PHASE for gating)"]
  I2 --> J["aven epic list REF  (verify)"]
  J --> K["implement-plan-aven: sort by N./N.M prefix,<br/>first non-done = resume pointer"]
  K -->|per phase| L["run tests -> commit<br/>then aven edit PHASE --status done"]
  L -->|next phase| K
```

## Stage 1 — Author the plan

### 1. Pickup (~30s)

**Ticket lookup and Jira detection.** Input may be an aven ref (`PMR-ZTVG`) or
a Jira ID (`DP-71`) of a synced ticket. Resolve to an aven ref:

```bash
aven show <INPUT> --json || true                # aven ref? (ref lookup only — JSON omits metadata)
aven list --metadata jira-key=<INPUT> --json    # Jira ID? → item .ref
# unknown-ref + empty/`unknown-metadata-field` lookup → not aven-managed → plan it in Jira directly
```

`unknown-metadata-field` means no ticket has ever carried `jira-key` (fields
register lazily) — treat as "not found", not a failure. Wrong workspace also
yields `unknown-ref`: run `aven doctor`, retry with `--workspace <name>`.

`aven show <REF> --full` + `aven context <REF>`. For a synced ticket (`jira-key`
metadata present), context = the synced description + `jira-url` metadata —
parse the `metadata field_id=… key=K` / `value<<EOF … EOF` blocks from
`show --full` text; `show --json` omits metadata on aven 0.1.39. No acli, no
live Jira reads — the synced aven copy is the source. Skim `README.md`,
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
- **Synced ticket** (`jira-key` metadata): call `resolve_spec_path` with the
  Jira ID and summary — the plan lands in the specs dir (`<JIRA>__<slug>.md`).

Use the returned absolute `plan.md` path verbatim everywhere below — never
hand-roll it, never shorten it, never `mkdir notes/` yourself.

### 4. Interview — one focused round

Ask only what you can't infer from scout findings, grouped in a single message.
Aim for 3–6 questions (behavior, scope, trigger/UX, constraints, edge cases,
boundaries). Always offer the out: "...or say 'use your judgment' and I'll pick
sensible defaults." If the user defers, pick defaults and mark them as
assumptions.

### 5. Contract on the feature ticket

Aven tickets already carry a title + description, so no task creation. Record
the interview + plan location:

```bash
# Labels must exist before use (repeat-safe: ignore "already exists" errors)
aven label create phase 2>/dev/null || true
aven label create impl 2>/dev/null || true

aven note <REF> --stdin <<'EOF'
Goal: ...
Behavior: ...
Done when: ...
Out of scope: ...
EOF

# Feature ticket becomes the epic container for the whole tree
# plan-state=draft now (plan.md not written yet); flip to review after the planner finishes
aven edit <REF> --epic on --status todo \
  --metadata plan-path=<absolute plan.md path> --metadata plan-state=draft
```

`<REF>` is the qualified ref (e.g. `PMR-ZTVG`). Labels mark task kind
(`phase`/`impl`); **epic membership groups the tree** — every phase and
subtask is added as a child of `<REF>` (`aven epic list <REF>` returns the
whole tree, and the TUI epic view shows it).

**Sync-safety (synced tickets):** jira-aven-sync overwrites title, status,
priority, description, labels, and `jira-status` on every run — planning data
lives only in `aven note` and `plan-path`/`plan-state` metadata, which survive
sync (verified on aven 0.1.39 + jira-aven-sync). Never put planning data in
`--description`. The `--status todo` edit is harmless but sync-owned — the
gate is `plan-state` metadata only, never aven status.

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
later, in stage 2. Design points the plan must satisfy:

- Every phase AND subtask is an epic child of `<REF>` — epic membership is
  the grouping key (`aven epic add <CHILD> <REF>`).
- `N.` / `N.M` title prefixes are REQUIRED — the execution plan sorts by them.
- **Phases chain via deps** (`aven dep add <phase N> <phase N-1>`) — aven
  enforces execution order (`--ready` shows exactly one phase at a time); the
  prefix is for humans and sorting.
- Capture each phase ref from its `aven add` output (`created PMR-XXXX`) — subtasks don't depend on it unless you want `--ready` gating.
- **Phases must be testable blocks**: the planner designs each phase so the repo
  is left green at its end — tests pass, then one commit scoped to that phase.
  A phase that can't end with `tests → commit` is too big or too small; split
  or merge it.
- The planner must NOT commit code, must NOT create aven tasks, and must NOT
  set status beyond `todo`.

When the planner finishes and plan.md is complete, flip the gate:

```bash
aven edit <REF> --metadata plan-state=review
```

Stage 1 ends here. Present plan.md to the user and stop — the tree is
created only after explicit approval, possibly in a later session.

## Stage 2 — Create the tree (after approval)

Precondition: the user has explicitly approved the plan ("approve <REF>").
Check state first — if `plan-state` is `draft`/`review`, stop: the plan is
not approved; offer to iterate instead (back to stage 1's planner with the
existing plan.md). On approval:

```bash
aven edit <REF> --metadata plan-state=approved
```

Then materialize the tree by running the **Aven output contract** below
verbatim, one phase at a time. Finish with verification:

```bash
aven epic list <REF> --json
```

Sort children by the `N.`/`N.M` title prefix client-side. Present the list to
the user and ask them to review both `plan.md` and the tree. Fixups go
through the contract commands.

### Fallback — no `subagent` tool

Do the scout work in the main session (`fast_context_search` / `grep` /
`read`) and write `plan.md` yourself. The two-stage split still applies:
plan first, tree only after explicit user approval, using the identical
commands from the contract below. Everything else — interview, notes,
metadata, verification — is unchanged. Call `open_in_pane` with the
plan path after writing (skippable on request; tool failure never blocks).

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
  plan with the planner, then set `plan-state=review`.
- `plan-state=review` → read plan.md fully, load it for the user, iterate
  until they approve or discard.
- `plan-state=approved` → tree missing → stage 2; tree exists → route to
  `implement-plan-aven`.

## Aven output contract

Byte-identical commands for stage 2 and the fallback. `<REF>` is the
feature ref; `$PHASE_REF` is captured from each phase's `aven add` output.
Every task gets its own `plan-path` copy so any ref is self-contained.

```bash
# Phase — capture the ref inline; aven prints "created PMR-XXXX"
# (use \S+, not \w+ — the dash in refs breaks \w)
PHASE_REF=$(aven add "N. Phase: <name>" --label phase --label impl --metadata plan-path=<abs plan.md> 2>&1 | grep -oP 'created \K\S+')
aven epic add $PHASE_REF <REF>

# Hard order guarantee: phase N blocks on phase N-1. PREV_PHASE_REF starts
# empty for the first phase.
if [ -n "$PREV_PHASE_REF" ]; then
  aven dep add $PHASE_REF $PREV_PHASE_REF
fi
PREV_PHASE_REF=$PHASE_REF

# Subtask — epic child of the feature, gated on its phase (hidden from --ready
# until the phase is done)
SUBTASK_REF=$(aven add "N.M <title>" --label impl --metadata plan-path=<abs plan.md> 2>&1 | grep -oP 'created \K\S+')
aven epic add $SUBTASK_REF <REF>
aven dep add $SUBTASK_REF $PHASE_REF
```

Repeat per phase, incrementing `N` (`1.`, `2.`, ...); subtasks `1.1`, `1.2`,
`2.1`, ...

## Phase discipline (execution)

Every phase ends with the same cycle — this is what makes phases testable
blocks rather than arbitrary buckets:

```bash
# 1. Run the project's tests (repo-defined runner, e.g. `bun run check`)
# 2. Commit with a phase-scoped message (explain the why, conventional subject)
# 3. Close the phase in aven
aven edit <PHASE_REF> --status done
```

Only then does the next phase start. If tests fail, the phase is not done —
fix forward inside the same phase. The commit is the phase's artifact; the
aven status is its ledger entry.

## What We're NOT Doing

- No taskwarrior — no UUID plumbing, no `work_state` UDA, no `jiraid`. This
  skill is the aven sibling of `feature-plan`.
- No live Jira — no acli, no writes/transitions. Synced tickets are read from
  their aven copy (written by jira-aven-sync); Jira-linked work NOT synced to
  aven stays in Jira — there is no local mirror for it anymore.
- No branch automation.
- No worktree creation — the planner works in the main checkout; execution
  isolation is `implement-plan-aven`'s job (its Step 3 creates the worktree
  when the feature is implemented). If the user asks for the work to happen
  in a worktree, note that intent in the plan document so implement picks
  worktree mode.
- No extra metadata for grouping — epic membership covers it; `plan-path` is
  the only metadata this flow writes.

## Integration with Other Skills

- Jira-linked work NOT synced to aven: plan it in Jira directly. aven
  workspaces (`salaryhero` / `personal`) split the local execution queues —
  this skill always works in the aven workspace routed to the current
  directory (`aven doctor` to verify).
- `implement-plan-aven` — resumes this hierarchy via
  `aven epic list <REF> --json`; resume pointer = first non-done task in
  N./N.M title order. With worktree mode, it also resumes the feature's
  worktree from the `worktree:` note this flow's contract left on the ticket.
