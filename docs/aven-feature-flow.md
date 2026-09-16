# Aven feature flow: plan → implement

How personal-project features move through aven: from ticket, through
planning (`feature-plan-aven`), to execution (`implement-plan-aven`).

Source skills:
- `~/.pi/agent/skills/aven/SKILL.md` — CLI primer
- `skills/engineering/explore/SKILL.md` — pre-ticket exploration
- `skills/engineering/feature-plan-aven/SKILL.md` — planning
- `skills/engineering/implement-plan-aven/SKILL.md` — execution
- `skills/engineering/debug/SKILL.md` — bug flow (step 0a)

---

## 1. Mental model

Two artifacts, two sources of truth:

| Artifact | Role | Lives in |
|---|---|---|
| Aven ticket tree | **What** to do, in **what order**, and progress ledger | aven (local DB) |
| `plan.md` | **How** to do it — design, constraints, acceptance criteria | filesystem (`resolve_feature_path`) |

Data model of a planned feature:

```text
Feature ticket  metadata: plan-path=<abs plan.md>, plan-state=draft|review|approved  is_epic=true
  └── Phase   title="1. Phase: <name>"  labels=[phase,impl]  epic child, plan-path
        └── Subtask  title="1.1 <title>"  labels=[impl]  epic child, plan-path, depends_on phase
  └── Phase   title="2. Phase: <name>"  labels=[phase,impl]  epic child, plan-path, depends_on phase 1
        └── Subtask  title="2.1 <title>"  labels=[impl]  epic child, plan-path, depends_on phase
```

**Plan gate**: the tree exists only after approval. `plan-state` on the
feature ticket: `draft` (interview done, plan.md incomplete) → `review`
(plan.md complete, awaiting user) → `approved` (tree may be created). Only
the user's explicit word ("approve <REF>") moves review → approved; the
agent runs the edit. Resume in a new session: `aven show <REF> --full` (parse
the `metadata … key=plan-state` block — `show --json` omits metadata on aven
0.1.39), branch on `plan-state`.

Three structural rules:

1. **Grouping = epic membership.** The feature ticket becomes an epic; every
   phase AND subtask is an epic child (`aven epic add <child> <feature>`).
   No extra metadata for grouping — `plan-path` is the only metadata written.
2. **Ordering = dependency chain.** Phase N depends on phase N−1
   (`aven dep add`), so `aven list --ready` exposes exactly one phase at a
   time. Subtasks depend on their phase (hidden from `--ready` until it
   finishes).
3. **Naming = `N.` / `N.M` title prefixes.** Aven does NOT sort by prefix —
   the skills sort client-side for presentation and resume. Prefixes are for
   humans.

Statuses used: `inbox → todo → active → done`. Labels: `phase`, `impl`.

### Jira-synced tickets

Tickets synced from Jira by `jira-aven-sync` carry `jira-key`, `jira-url`,
and `jira-status` metadata plus the `jira` label. They live in the Jira
project's aven project (`dp`, `imp`, `devops` in the `salaryhero` workspace)
— **not** in the repo the flow runs from. Work on a synced ticket happens
on a **local epic pulled into the repo's own aven project**, dep-linked to
the synced ticket. The synced ticket is context + upstream record; it is
never planned, edited, or re-parented.

**Pull-in (find-or-create)** — run from the repo root before the flow;
`<REF>` for the whole flow is the local epic:

```bash
KEY=DP-71
# 1) Synced ticket — search the WHOLE workspace (omit --project); synced
#    tickets live in their Jira project's aven project, not the repo's
JIRA_REF=$(aven list --metadata jira-key=$KEY --json 2>/dev/null \
  | jq -r '.[] | select(.is_epic != true) | .ref' | head -1)
# [] / `unknown-metadata-field` → never synced → not aven-managed
# (aven errors print on stderr — never merge 2>&1 into the jq pipe)

# 2) Repo's aven project — mapped? (projects infer from path mappings)
aven project path list --workspace salaryhero
# repo path unmapped → create + map in one shot (name = repo dir name)
aven project create "$(basename "$PWD")" --path "$PWD" --workspace salaryhero

# 3) Existing epic for THIS repo + ticket? (`jira-ref` marks pulled-in epics;
#    <repo-project-key> = the repo project's key from `aven project list`)
EPIC_REF=$(aven list --metadata jira-ref=$KEY --json 2>/dev/null \
  | jq -r --arg p <repo-project-key> '.[] | select(.project == $p) | .ref' | head -1)
# empty / `unknown-metadata-field` (lazy registration — no epic ever pulled
# in yet) → not found → create below

# 4) Missing → create the epic in the repo's project, dep-link the synced ticket
EPIC_REF=$(aven add "$KEY — <synced summary>" --epic --status todo \
  --metadata jira-ref=$KEY \
  --description "Jira $KEY — source of truth: synced ticket $JIRA_REF." \
  2>&1 | grep -oP 'created \K\S+')
aven dep add $EPIC_REF $JIRA_REF   # epic blocked-by synced ticket; deps survive sync
```

Deltas from the local flow:

- **Lookup**: a Jira ID resolves workspace-wide via `jira-key` (step 1),
  then to the repo's epic via `jira-ref` (step 3). One epic per repo per
  ticket — two repos pulling the same ticket get sibling epics, each
  filtered by its repo's project key.
- **Feature ticket = local epic**: `plan-path`, `plan-state`, notes, and
  the whole tree live on the epic. Title format `KEY — summary`.
- **Context + path**: context = synced description + `jira-url` (no live
  acli); plan.md path comes from `resolve_spec_path` (specs dir), not
  `resolve_feature_path`.
- **Sync-safety**: sync overwrites title, status, priority, description,
  labels, and `jira-status` on the **synced ticket** every run. The local
  epic is invisible to sync — everything on it (even `--description`) is
  durable. The `dep` link survives sync (deps aren't in the overwrite
  list). Legacy trees planned directly on a synced epic still work — step 1
  filters `is_epic` out of the synced lookup.

## 2. Lifecycle overview

```text
(optional) explore — chat Q&A about the codebase BEFORE any ticket exists:
  quick questions → direct search · broad mapping → scout subagents ·
  "why" questions → hindsight/cognee memory. No aven state until exit ramp:
  "create ticket" (oneshot) / "plan it" (→ stage 1, findings as ticket note)
  / nothing (understanding was the goal).

aven add "Add dark mode"            # ticket lands in inbox (or --status todo)
        │
Jira ID? pull-in first (§1): find synced ticket (jira-key, workspace-wide) →
find-or-create local epic in the repo's project (jira-ref) → dep add EPIC JIRA.
The flow then runs on the EPIC, never on the synced ticket.
        │
        ├─ oneshot? (description is a complete spec, single commit) ─┐
        │   "oneshot REF" → worker → tests → commit → done          │
        │                                                            │
        ▼  feature-plan-aven, stage 1 (author)                       │
pickup → scout → path → interview → planner writes plan.md           │
        → plan-state=review         ★ gate: NO tree yet              │
        │                                                            │
        ▼  user reviews (possibly a later session)                   │
"iterate plan REF" → load plan.md, iterate   |   "approve REF" → plan-state=approved
        │                                                            │
        ▼  feature-plan-aven, stage 2 (tree)                         │
aven output contract → phases/subtasks as epic children, each with plan-path
        │                                                            │
        ▼  implement-plan-aven                                       │
pull tree → read plan.md → branch → per-phase loop (active → subtasks →
test → verify gate → commit → done) → close feature                  │
```

## 3. Phase A: Planning (`feature-plan-aven`)

Trigger: an aven ref (e.g. `PMR-ZTVG`), a synced Jira ID (e.g. `DP-71`), or
"plan this aven ticket".
Re-triggering on a ref with existing `plan-state` resumes at the right stage
(draft → finish plan, review → iterate, approved → create tree).
Routing: Jira ID synced to aven (jira-key metadata) → planned here; Jira ID
NOT synced → `create-plan`; taskwarrior tree → `feature-plan` (legacy).

Workspaces: personal projects → `personal` workspace, work → `salaryhero`.
Run aven from the repo root; workspace is inferred from cwd. If refs fail
with `unknown-ref`, check routing with `aven doctor`.

### Steps

1. **Pickup** — Jira ID? Run the pull-in (§1) first; `<REF>` from here on
   is the local epic. Then `aven show <REF> --full` + `aven context <REF>`.
   Skim README/AGENTS.md/package.json enough to brief the scout.

2. **Scout** — read-only `scout` subagent maps the affected area (file
   structure, modules, conventions, similar features) into
   `scout-context.md`. Parallel scouts OK. Main session ends turn and waits
   for the `subagent_result` steer.

3. **Resolve plan path** — `resolve_feature_path(summary)` returns the
   canonical absolute `plan.md` path
   (`$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`, else
   `.pi/plans/<date>-<slug>/plan.md`). Use verbatim; never hand-roll.

4. **Interview** — one focused round, 3–6 questions (Goal / Behavior / Done
   when / Out of scope). Always offer "use your judgment" → defaults marked
   as assumptions.

5. **Contract on the ticket** — record the interview and promote the ticket
   (`plan-state=review` when plan.md is complete, `draft` if interrupted):

   ```bash
   aven label create phase 2>/dev/null || true
   aven label create impl  2>/dev/null || true
   aven note <REF> --stdin <<'EOF'
   Goal: ...
   Behavior: ...
   Done when: ...
   Out of scope: ...
   EOF
   aven edit <REF> --epic on --status todo \
     --metadata plan-path=<abs path> --metadata plan-state=review
   ```

6. **Interactive planner subagent** — runs its own methodology
   (requirements, approaches, premortem, plan) with the user, writes
   `plan.md`. It does NOT create aven tasks — the tree is stage 2.
   Stage 1 ends here: present plan.md, wait for the user.

   ```bash
   # Phase (capture ref from "created PMR-XXXX"; \S+ not \w+ — dash breaks \w)
   PHASE_REF=$(aven add "N. Phase: <name>" --label phase --label impl --metadata plan-path=<abs> 2>&1 | grep -oP 'created \K\S+')
   aven epic add $PHASE_REF <REF>
   if [ -n "$PREV_PHASE_REF" ]; then aven dep add $PHASE_REF $PREV_PHASE_REF; fi
   PREV_PHASE_REF=$PHASE_REF

   # Subtask (epic child, gated on its phase)
   SUBTASK_REF=$(aven add "N.M <title>" --label impl --metadata plan-path=<abs> 2>&1 | grep -oP 'created \K\S+')
   aven epic add $SUBTASK_REF <REF>
   aven dep add $SUBTASK_REF $PHASE_REF
   ```

   Planner constraints:
   - Phases must be **testable blocks** — repo left green at phase end, one
     commit per phase. Too big/small → split/merge.
   - Planner must NOT commit code, create aven tasks, or set status beyond
     `todo`.

7. **Stage 2 — create the tree (after approval)** — user says
   "approve <REF>" → `aven edit <REF> --metadata plan-state=approved`, then
   run the contract verbatim, one phase at a time: `aven epic list <REF> --json`, sort by prefix, present tree
   + plan.md to the user for review. Fixups via the contract commands.

8. **Fallback (no subagent tool)** — do scout work in-session
   (`fast_context_search`/`grep`/`read`), write plan.md yourself, run the
   identical contract commands.

## 4. Phase B: Implementation (`implement-plan-aven`)

**Oneshot shortcut**: a ticket whose description is already a complete spec
(small, single-commit) skips planning entirely — "oneshot <REF>": status
active → one worker with the description as spec → tests → commit → note +
done. No plan.md, no tree. Vague description → clarify or route to planning.

**Bug shortcut**: `--label bug` tickets skip planning too — diagnosis replaces
it. "debug <REF>" runs the debug skill with an aven wrapper: status active,
findings/root cause land as ticket notes (durable resume), fix + regression
test → note with commit hash → done. Root cause reveals a design flaw →
route to `feature-plan-aven`. Triage queue: `aven list --ready --label bug`.

Trigger: "implement PMR-ZTVG", "implement DP-71" (synced Jira ID — pull-in
first, §1), "resume the aven feature". Discovery when no
ref given: `aven list --has-metadata plan-path --open`. No `plan-path`
metadata → not planned → route back to `feature-plan-aven`. `plan-state`
present but not `approved` → plan still in draft/review → route back to
`feature-plan-aven`.

### Steps

1. **Pull execution plan** — `aven epic list <REF> --json`; sort by
   `N.`/`N.M`; compute:
   - currentPhase = first non-done phase
   - currentSubtask = first non-done subtask in it
   - progress = done subtasks / total

   Present tree with ✓/▶/○ and the resume point. This first-non-done logic
   IS the resume mechanism — done work is trusted unless codebase evidence
   contradicts it.

2. **Read plan.md completely** (`plan-path` from `aven show <REF> --full` —
   parse the metadata block; `--json` omits metadata on aven 0.1.39).
   `- [x]` items are done.

3. **Branch** — no automation; if on main, suggest `feat/<slug>` in one
   sentence.

4. **Load companion skills** — `coding-standards` + `tdd-workflow` before
   first edit. Surface failure if either won't load.

5. **Execution loop**, per phase from currentPhase:

   ```
   aven edit <PHASE_REF> --status active
   ```

   Per subtask (from currentSubtask):
   - ≤2 lines, no logic change → implement inline (trivial escape hatch).
   - Otherwise:
     1. `aven edit <SUBTASK_REF> --status active`
     2. Read plan section fully; skim touched files.
     3. Plan/reality mismatch → **stop**, report `Plan assumes / Codebase
        shows / Options`, ask user.
     4. Spawn `worker` subagent: plan path, excerpt, files, acceptance
        criteria; "tests first, run them, show output; do NOT commit, do
        NOT touch aven".
     5. **Workers sequential — never two in the same repo.** End turn, wait
        for `subagent_result`.
     6. Review diff, `run_tests({})`.
     7. Tick plan.md `- [ ]` → `- [x]`.
     8. `aven edit <SUBTASK_REF> --status done`

   **Phase close — the test/commit cycle** (this is what makes phases
   testable blocks, not buckets):
   1. Full project check once more.
   2. Post verification gate (automated checks + manual verification items
      from the plan) — **wait for human confirmation**.
   3. Present phase-scoped conventional commit message — **wait again**.
   4. Commit, then `aven edit <PHASE_REF> --status done`.

   "Implement all phases" / "run end-to-end" skips inter-phase pauses.

6. **Close feature** — after final commit:

   ```bash
   aven edit <FEATURE_REF> --status done
   ```

## 5. Quick command reference

| Purpose | Command |
|---|---|
| Choose work | `aven list --ready` (excludes blocked + epics) |
| Bug triage queue | `aven list --ready --label bug` |
| Inspect before acting | `aven context <REF>` / `aven show <REF> --full` |
| Find planned features | `aven list --has-metadata plan-path --open` |
| Plans awaiting approval | `aven list --metadata plan-state=review --open` |
| Unfinished plans | `aven list --metadata plan-state=draft --open` |
| Approved, ready for tree | `aven list --metadata plan-state=approved --open` |
| Find ticket by Jira key | `aven list --metadata jira-key=<KEY> --json` |
| Find pulled-in epic by Jira key | `aven list --metadata jira-ref=<KEY> --json` |
| Repo ↔ project mappings | `aven project path list --workspace salaryhero` |
| Create + map a repo project | `aven project create <repo> --path <repo> --workspace salaryhero` |
| Blockers + dependents of a task | `aven dep list <REF> [--json]` |
| All Jira-synced tickets | `aven list --has-metadata jira-key --json` |
| See the tree | `aven epic list <REF> [--json]` |
| Next unblocked phase | `aven list --ready --label phase` |
| Start / finish work | `aven edit <REF> --status active\|done` |
| Durable handoff context | `aven note <REF> --stdin` |
| Order guarantee | `aven dep add <blocked> <blocker>` |
| Group into tree | `aven epic add <child> <feature-epic>` |
| Workspace sanity | `aven doctor` |

`unknown-metadata-field` on a metadata filter means no ticket has ever carried
that field (fields register lazily) — read it as "not found". `show --json`
and `list --json` omit metadata on aven 0.1.39 — read metadata via
`show --full` text or `--metadata` filters.

## 6. Boundaries

- Aven flow covers **aven tickets** — local (personal projects) or
  Jira-linked (synced ticket + pulled-in epic, §1). Jira-linked but NOT
  synced → `create-plan` / `implement-plan` (taskwarrior + Jira). Legacy TW
  trees → `feature-plan`.
- No branch automation, no taskwarrior UUID plumbing, no live Jira
  interaction (no acli, no writes/transitions).
- `implement-plan-aven` never authors plans; ad-hoc bugs without a plan →
  direct fix or `/skill:debug`.
- Task refs stay local — never in commit messages, PR descriptions, or
  external systems.
- Titles: sentence case (first word + proper nouns capitalized).
