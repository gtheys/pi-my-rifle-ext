# Jira-synced ticket support in aven planning skills

**Date:** 2026-09-13
**Status:** Draft
**Directory:** /home/geert/Code/personal/pi-my-rifle-ext
**Aven ticket:** PMR-FAFX (this feature's own ticket — dogfood after implementation)

## Intent

Extend `feature-plan-aven` and `implement-plan-aven` so an aven ticket synced from
Jira by `jira-aven-sync` (identified by `jira-key` metadata) can be planned and
implemented exactly like a local aven feature — same plan-state gate, same
phase/subtask tree, same execution loop. Only the ticket lookup, context sourcing,
and plan.md path differ. Plus: fix existing wrong prose about reading metadata from
`--json` output (aven 0.1.39 omits metadata there).

## User Story

As a developer with Jira tickets synced into aven, I want to say "plan DP-71" or
"implement DP-71" and get the full gated aven flow — so synced tickets get the same
interview → plan.md → approval → tree → execution discipline as local features.

## Behavior

### Happy Path (planning a synced ticket)

1. User says "plan DP-71" (Jira ID, not an aven ref).
2. Skill resolves it: `aven show DP-71 --json` fails (`unknown-ref`) →
   `aven list --metadata jira-key=DP-71 --json` → returns the aven ref.
3. Context = synced ticket description + `jira-url` metadata (from `show --full`
   text). No live acli fetch, ever.
4. Interview + scout proceed identically to a local feature (synced description is
   the Jira prose — interview still runs).
5. plan.md path: `resolve_spec_path(jira_id=DP-71, summary=<title>)` → returned
   absolute path used verbatim (specs dir, NOT `.pi/plans/`).
6. Gate on the synced ticket: `aven edit <REF> --metadata plan-path=<abs>
   --metadata plan-state=draft→review` — metadata survives sync runs.
7. User approves → tree created exactly as for local features. Phase/subtask tasks
   are created without `jira-key` metadata → sync never touches them.

### Happy Path (implementing a synced ticket)

1. User says "implement DP-71" → same two-step lookup → epic tree walk, plan.md
   read, phase loop — all unchanged, feature ref obtained differently.
2. Synced tickets can also be oneshots — description (sync-owned) as spec; outcome
   recorded via `aven note`, never `--description` edits.

### Edge Cases & Error Handling

- `unknown-metadata-field` error from `--metadata jira-key=<KEY>` (fields register
  lazily — no ticket ever synced yet) → treat as "not found", not a failure.
- `unknown-ref` from a Jira ID AND empty jira-key lookup → ticket not synced →
  route to `create-plan` (Jira flow).
- Metadata reads: `aven show --json` / `list --json` OMIT metadata (aven 0.1.39
  verified). Read via `show --full` text parse (blocks `metadata field_id=… key=K`
  / `value<<EOF … EOF`) or `list --metadata <field>=<value>` filters.
- Sync overwrites only: title, status, priority, description, labels, jira-status.
  Consequences: planning data lives in notes + `plan-path`/`plan-state` metadata
  (survive); never edit `--description` for planning data; never rely on aven
  status for the gate (`plan-state` only — already true, keep it).
- Wrong workspace → `unknown-ref` on a known-synced ticket → `aven doctor`, and
  retry with `--workspace <name>` (synced tickets can land in any workspace).
- `$LLM_NOTES_ROOT` unset → `resolve_spec_path` falls back to repo-local
  `notes/specs/` — use the tool's returned path verbatim; never mkdir `notes/`
  by hand (create-plan's warning, borrowed).

## Scope

### In Scope

- `skills/engineering/feature-plan-aven/SKILL.md` — routing description, input
  contract + detection, path step switch, Jira context sourcing, metadata read fix,
  resume section fix, "What We're NOT Doing" + "Integration" rewrite.
- `skills/engineering/implement-plan-aven/SKILL.md` — routing description, input
  contract + detection, metadata read fix (step 2 `show --json` wrong), boundaries
  rewrite, oneshot sync-owned-description note.
- `docs/aven-feature-flow.md` — Jira-synced section, boundary rewrite,
  quick-reference additions.
- Metadata-read fix applies to existing local-feature prose too (it's wrong today).

### Out of Scope

- `jira-aven-sync` itself (external repo, untouched).
- Any live Jira writes/transitions/acli calls.
- `create-plan`, `feature-plan`, `implement-plan` (taskwarrior siblings).
- `resolve_spec_path` / `resolve_feature_path` code (used as-is).
- Any TS/package changes.

## Effort & Quality

- **Level:** production (these skills are the user's daily workflow contract).
- **Tests:** none new — skills are markdown; verification = grep-able prose checks
  + `bun run lint` (Biome) green + consistency cross-read.
- **Docs:** the skills ARE the docs; `docs/aven-feature-flow.md` updated in phase 3.

## Constraints

- Keep existing skill voice: imperative steps, fenced bash/subagent blocks,
  "What We're NOT Doing", "Integration with Other Skills" sections.
- Frontmatter `description` doubles as the routing contract — trigger phrases and
  do-not-use clauses must be updated with the same care as body prose.
- Sentence-case task titles (aven convention).
- aven CLI is 0.1.39 — all CLI claims verified against it; version-sensitivity
  (JSON metadata gap) should carry a short "upgrade when aven gains
  `show --json --metadata`" note (jira-aven-sync has the same note).

## Ideal State Criteria

### Core Functionality

- [x] ISC-1: feature-plan-aven description triggers on aven refs AND Jira IDs
- [x] ISC-2: Both skills document the two-step detection (show → unknown-ref →
      jira-key lookup; `unknown-metadata-field` = not found)
- [x] ISC-3: Jira branch uses `resolve_spec_path` returned path verbatim; local
      branch keeps `resolve_feature_path`
- [x] ISC-4: Jira ticket context = synced description + jira-url only; zero acli
      commands in either SKILL.md
- [x] ISC-5: No prose instructs reading metadata from `--json` output (grep
      `--json` near `metadata` in both files → all fixed to `--full`/filters)
- [x] ISC-6: Sync-overwrite rule stated: planning data in notes/metadata only,
      never `--description`; gate never relies on aven status
- [x] ISC-7: implement-plan-aven description + input contract accept Jira IDs
- [x] ISC-8: Boundaries say "Jira-linked but NOT aven-synced → create-plan /
      implement-plan"; synced tickets handled here
- [x] ISC-9: docs/aven-feature-flow.md has a Jira-synced subsection and updated
      boundary + quick-reference rows for jira-key lookup
- [x] ISC-10: plan-state gate (draft → review → approved) semantics unchanged

### Anti-Criteria

- [x] ISC-A-1: No changes outside the three in-scope files
- [x] ISC-A-2: No live Jira interaction (acli/REST) introduced anywhere
- [x] ISC-A-3: Phase/subtask tree contract unchanged (no jira-key on children,
      no new metadata fields)

## Approach

Skill-doc work only. No code: detection is two plain aven CLI queries the skills
express in bash; `resolve_spec_path` already exists and is called as-is.

### Key Decisions

- **Detection = two-step CLI probe, shared wording in both skills.**
  `aven show <INPUT> --json` first (catches aven refs; JSON fine here — only ref
  lookup, no metadata read). On `unknown-ref`: `aven list --metadata
  jira-key=<INPUT> --json` → take the item's `ref`. Both fail → Jira-linked but
  unsynced → route to create-plan/implement-plan. `unknown-metadata-field`
  error = same "not found" outcome.
- **Jira branch = local branch + three deltas**: context sourcing (synced
  description + jira-url), plan path (`resolve_spec_path`), and a sync-safety
  note. Everything else — interview, scout, gate, tree, execution — identical.
  Avoids forking the flow into two parallel recipes.
- **Metadata reads = `show --full` text parse + `list --metadata` filters.**
  Matches jira-aven-sync's own mechanism. Marked with an upgrade note for when
  aven grows `--json --metadata`.
- **Oneshot stays valid for synced tickets.** Description is sync-owned; outcome
  recorded via note (step already does). One sentence added, no flow change.

### Architecture

Three files, each one phase:

1. `skills/engineering/feature-plan-aven/SKILL.md` (planning side)
2. `skills/engineering/implement-plan-aven/SKILL.md` (execution side)
3. `docs/aven-feature-flow.md` (cross-cutting doc, last — references both)

Cross-file consistency is the coupling risk: detection wording, boundaries, and
the metadata gotcha must read identically in all three. Phase order 1→2→3 lets
phase 3 quote final wording; phase 2 must reuse phase 1's detection text.

### Data Flow (per skill)

```text
Input (ref or Jira ID)
  → detect: show --json → unknown-ref → list --metadata jira-key=<ID> --json
  → has jira-key?
      YES: context = synced description + jira-url (show --full)
           path = resolve_spec_path(jira_id, summary)
      NO:  context = ticket description (as today)
           path = resolve_feature_path(summary)
  → interview/scout/planner (unchanged)
  → gate: plan-state metadata on feature ticket (unchanged, survives sync)
  → tree: aven add children without jira-key (unchanged, invisible to sync)
```

## Phases (materialized as the aven tree in stage 2)

### Phase 1 — feature-plan-aven SKILL.md

Edit `skills/engineering/feature-plan-aven/SKILL.md`:

1. **Frontmatter description**: accept aven ref OR Jira ID ("plan DP-71");
   replace "Jira-linked work routes to create-plan" with "Jira-linked work that
   is NOT synced to aven routes to create-plan; aven tickets carrying jira-key
   metadata (from jira-aven-sync) are planned here".
2. **New "Ticket lookup and Jira detection" block** early in Stage 1 (after
   pickup intro), shared two-step:

   ```bash
   aven show <INPUT> --json || true        # aven ref? (ref lookup only — JSON omits metadata)
   aven list --metadata jira-key=<INPUT> --json   # Jira ID? → item .ref
   # unknown-ref + empty/`unknown-metadata-field` lookup → not synced → route to create-plan
   ```

3. **Step 1 pickup**: for synced tickets read `aven show <REF> --full` and parse
   the `metadata … key=jira-key` / `value<<EOF` blocks; context = synced
   description + jira-url. Explicit "no acli, no live Jira reads".
4. **Step 3 path**: branch — synced: `resolve_spec_path` with jira_id + summary,
   returned path verbatim, never mkdir notes/; local: `resolve_feature_path`
   unchanged.
5. **Step 5 contract**: add note that `--description` is sync-owned — planning
   data goes in `aven note` + `plan-path`/`plan-state` metadata (which survive
   sync; verified on aven 0.1.39 + jira-aven-sync). Status `--status todo` edit
   harmless but sync-owned — gate is plan-state only.
6. **Resume section**: replace `aven show <REF> --json # metadata.plan-state` with
   the `--full` parse / `aven list --metadata plan-state=<state>` filter; add the
   aven 0.1.39 JSON-metadata gotcha + upgrade note.
7. **"What We're NOT Doing"**: "No Jira" bullet becomes "No live Jira — no acli,
   no writes/transitions; synced tickets are read from their aven copy".
   Keep taskwarrior bullet.
8. **"Integration"**: create-plan = Jira-linked but NOT synced (or taskwarrior
   flows); implement-plan-aven accepts the same Jira-ID inputs.

Verify: `bun run lint`; grep both `--json.*metadata` and `acli` in the file →
zero hits; re-read for internal consistency. Commit 1.

### Phase 2 — implement-plan-aven SKILL.md

Edit `skills/engineering/implement-plan-aven/SKILL.md`:

1. **Frontmatter description**: ref forms = aven ref or Jira ID ("implement
   DP-71"); mirror phase-1 routing sentence.
2. **Input contract**: same two-step detection block as phase 1 (copy wording);
   synced-but-unplanned routes to feature-plan-aven as today.
3. **Step 2 metadata read**: replace `aven show <FEATURE_REF> --json  #
   metadata.plan-path` with `show --full` parse; gotcha note.
4. **Oneshot section**: one sentence — synced ticket description is sync-owned;
   clarifications + outcome go through `aven note`, never `--description`.
5. **Boundaries**: "Jira-linked work → implement-plan" becomes "Jira-linked but
   NOT aven-synced → implement-plan; synced tickets are handled here".
6. Step 6 close: feature status `--status done` is sync-owned on synced tickets —
   sync will remap from Jira; the note is the durable close record.

Verify: `bun run lint`; grep checks as phase 1; diff-read against phase-1 file for
shared wording. Commit 2.

### Phase 3 — docs/aven-feature-flow.md

Edit `docs/aven-feature-flow.md`:

1. **§1 mental model**: add short "Jira-synced tickets" subsection — jira-key
   detection, context from synced copy, resolve_spec_path path, sync-overwrite
   surface (title/status/priority/description/labels/jira-status vs
   notes/metadata/tree which survive), metadata-read gotcha.
2. **§3 trigger/routing line**: "Routing: Jira ID → create-plan" becomes the
   synced/un-synced split.
3. **§6 boundaries**: rewrite "personal projects only" bullet — aven flow covers
   aven tickets, local or Jira-synced; Jira-linked but unsynced →
   create-plan/implement-plan. Drop "no Jira metadata" clause (jira-key now
   meaningful).
4. **§5 quick reference**: add rows — find by Jira key
   (`aven list --metadata jira-key=<KEY> --json`), all synced
   (`aven list --has-metadata jira-key --json`), plus the
   `unknown-metadata-field`-means-not-found footnote.
5. Fix the two `show --json` metadata mentions (§1 gate resume, §4 step 2) to
   `--full`/filter mechanism.

Verify: `bun run lint`; consistency cross-read of all three files; then dogfood:
run "resume PMR-FAFX" against the updated skill prose mentally (its own ticket is
synced-style with plan-state=draft). Commit 3.

## Dependencies

- aven CLI ≥ 0.1.39 (external; JSON metadata gap is version-sensitive)
- `resolve_spec_path` / `resolve_feature_path` from `@gtheys/pi-planning` (as-is)
- `jira-aven-sync` (external, produces the tickets; read-only reference)

## Risks & Open Questions

- **aven CLI drift** (JSON gains metadata / errors change): accepted — skills
  carry the upgrade note; jira-aven-sync faces the same constraint.
- **Prose-only feature = no automated tests**: accepted — ISC items are
  grep-verifiable; phase verification runs them explicitly.
- **Dogfooding PMR-FAFX mid-implementation** (its tree would be created by the new
  prose): accepted — good first exercise; the tree is local-only regardless.
- Open question parked: whether `pi-aven-context` package should surface jira-key
  metadata in `aven-context` output — separate feature if ever needed.
