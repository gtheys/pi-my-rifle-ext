# Context for: Jira-synced ticket support in aven planning skills

Feature: extend `feature-plan-aven` + `implement-plan-aven` so an aven ticket synced
from Jira (carrying `jira-key` metadata, written by `jira-aven-sync`) can be planned
and implemented like a local aven feature. Detection by ref or Jira ID; no live acli
fetch; plan.md path via `resolve_spec_path`; plan-state gate unchanged; epic tree
stays local-only; `implement-plan-aven` accepts Jira refs.

## Relevant Files

- `skills/engineering/feature-plan-aven/SKILL.md` — planning skill; primary edit target. Two-stage flow (author plan → create tree), plan-state gate, aven output contract, resume section, input contract lives in frontmatter description + "What We're NOT Doing" ("No Jira — routes to create-plan") — both must change.
- `skills/engineering/implement-plan-aven/SKILL.md` — execution skill; second edit target. Input contract ("user provides a feature ref"), oneshot path, data-model section, boundaries ("Jira-linked work → implement-plan") must change.
- `docs/aven-feature-flow.md` — the prose doc for both skills; currently states the boundary "Aven flow is personal projects only. Jira-linked → create-plan/implement-plan" and "No Jira metadata". Needs a Jira-synced section + boundary rewrite.
- `packages/pi-planning/plan-tools/resolve-spec-path.ts` + `plan-tools/helpers.ts` — `resolve_spec_path` tool. NO code change needed (task says use it as-is), but its path scheme is what the skills must call.
- `packages/pi-planning/plan-tools/resolve-feature-path.ts` (same helpers.ts) — `resolve_feature_path`, the local-feature path tool currently used by feature-plan-aven step 3.
- `~/Code/personal/jira-aven-sync/` (external repo, OUT OF SCOPE for changes) — the sync tool. Source of truth for synced-ticket shape. Read `src/aven.rs`, `src/sync.rs`, `README.md`.
- `skills/engineering/create-plan/SKILL.md` — Jira conventions to borrow (spec path discipline, no live acli in create-plan either — it reads from taskwarrior/bugwarrior sync).
- `openwiki/workflows/planning-and-implementation.md` — documents the TW planning flow; notes resolve_spec_path scheme. Only touch if planner wants cross-reference updates (openwiki has NO aven-flow page today; docs/aven-feature-flow.md is the aven doc).

## Project Structure

Skills are pure markdown under `skills/engineering/<name>/SKILL.md` (frontmatter
`name`/`description` doubles as the trigger/routing contract). Tools live in
`packages/pi-planning` (taskwarrior-backed, published npm package with `files`
allowlist). Aven state lives in the `aven` CLI (v0.1.39, local SQLite), not in this
repo. The live feature ticket is `PMR-FAFX` (pi-my-rifle-ext project, epic, todo,
`plan-path` → this folder's plan.md, `plan-state=draft`, full feature note attached).

## jira-aven-sync — exact synced-ticket shape (from ~/Code/personal/jira-aven-sync)

Metadata written per synced task (`src/aven.rs` add()):
- `jira-key=<JIRA KEY>` (identity — e.g. `jira-key=DP-71`)
- `jira-url=<browse URL>`
- `jira-status=<raw Jira status name>`
Plus the `jira` label and the issue's Jira labels.

Sync overwrites on every run (README + `edit()`): **title, status (mapped),
priority (mapped), description, labels (add/remove), jira-status metadata**.
Everything else — epic flag, notes, other metadata (plan-path, plan-state), deps,
epic children — is untouched. Verified live 2026-09-13 (DPX-S42H test, recorded on
PMR-FAFX note): plan-path/plan-state/notes survive sync runs.

Lookup patterns the sync tool itself uses (copy these in the skills):
- Find by Jira key: `aven list --metadata jira-key=<KEY> --json` → list item has `ref`.
- All synced: `aven list --has-metadata jira-key --json`.
- **Gotcha:** if no task ever carried `jira-key`, aven errors `unknown-metadata-field`
  (fields register lazily) — treat as "not found".
- **Gotcha:** `aven list --json` and `aven show <ref> --json` do NOT include metadata
  (verified on aven 0.1.39; the sync tool parses `show --full` text blocks
  `metadata field_id=… key=K` / `value<<EOF … EOF` for this reason, with an explicit
  ponytail note to upgrade if aven ever gains `show --json --metadata`).

## resolve_spec_path contract (no change needed)

`pi.registerTool({ name: 'resolve_spec_path', parameters: { jira_id, summary } })` →
returns absolute path `<specDir>/<JIRA>__<slug>.md` where:
- `specDir` = `$LLM_NOTES_ROOT/<repo>/notes/specs` if `LLM_NOTES_ROOT` set, else
  `<git-toplevel>/notes/specs` (repo-local fallback).
- `repo` = basename of `git rev-parse --show-toplevel`; `slug` = lowercase, non-alnum
  stripped, first 5 words, dash-joined (shared `slugify` in helpers.ts).
- Feature context said `$LLM_NOTES_ROOT/<repo>/specs/…` — **actual code emits
  `notes/specs/`**. Planner should treat the tool's returned path as the contract
  (call it, use verbatim) and not hardcode the dir.
- `LLM_NOTES_ROOT` was unset in my shell; create-plan SKILL.md carries a loud warning
  never to hand-roll or mkdir repo-local `notes/` — borrow that wording.
- Contrast: `resolve_feature_path(summary)` → `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`
  or `<toplevel>/.pi/plans/<date>-<slug>/plan.md` (what local features use today).

## create-plan conventions worth borrowing

- Spec path discipline: "use the `resolve_spec_path` returned path verbatim — never
  shorten, never fall back to repo-relative, never mkdir `notes/` yourself".
- Ticket context comes from the SYNCED copy only (create-plan reads taskwarrior via
  bugwarrior; the aven flow reads aven via jira-aven-sync) — no live acli fetch.
  Neither skill ever shells out to acli for ticket content.
- Plan file references the Jira URL as `[$JIRA_ID]($jiraurl)` in its header/template.

## Where Jira detection/branching slots in

### feature-plan-aven
- **Routing sentence in description + "Integration" section**: today "Jira-linked work
  routes to create-plan". New rule: aven ticket WITH `jira-key` metadata → this skill
  (Jira branch); Jira-linked but not synced to aven → still create-plan.
- **Input contract (description + Pickup step)**: ref forms = aven ref (PMR-XXXX) OR
  Jira ID (DP-71). Detection: try `aven show <INPUT> --json` first; on `unknown-ref`
  try `aven list --metadata jira-key=<INPUT> --json` → ref; both fail → ask/route.
- **Stage 1 changes**: skip nothing structural. Step 5 contract (`aven edit --epic on
  --metadata plan-path/plan-state`) works on a synced ticket as-is. Path step switches
  on detection: jira-key → `resolve_spec_path(jira_id, title-or-summary)`;
  local → `resolve_feature_path(summary)`. Context = synced description + `jira-url`
  (from `show --full` text parse — NOT `show --json`, see gotcha). Interview/probably
  still useful (synced description is the Jira prose).
- **Stage 2**: unchanged verbatim — phases/subtasks are fresh local tasks, never
  synced (no jira-key metadata on them).
- **Resume section**: branches on plan-state exactly as today; only the metadata
  read mechanism needs fixing (see gotchas).
- **"What We're NOT Doing"** bullets "No Jira" / "taskwarrior" need rewording; keep
  "no live Jira writes".

### implement-plan-aven
- **Input contract**: extend ref forms with Jira ID (same two-step detection, shared
  wording with feature-plan-aven so both docs match).
- Everything downstream (epic tree walk, plan-path resolution, phase loop) is
  Jira-agnostic already — the feature ticket ref is just obtained differently.
- **Boundaries** bullet "Jira-linked work → implement-plan" → becomes "Jira-linked
  but NOT aven-synced → implement-plan; synced tickets are handled here".
- Oneshot path: a synced ticket could be a oneshot too — decision for planner
  (description overwrite by sync makes oneshot-from-description still valid).

## Conventions (repo style rules that bind the planner)

- Biome lint/format; strict TS ESM with `.ts` import suffixes — but these skills are
  markdown-only, so the deliverable is prose + frontmatter. Keep the existing skill
  voice: imperative steps, fenced `bash`/`subagent` blocks, "What We're NOT Doing",
  "Integration with Other Skills" sections.
- No ternaries rule etc. only applies if any TS changes (none expected — task says
  tools stay as-is).
- Conventional Commits, sentence-case titles (matches aven list output style).
- G-1: add `AIDEV-NOTE:` anchors only if non-trivial code is touched (probably none).

## Dependencies

- `aven` CLI 0.1.39 — external, version-sensitive JSON gaps (metadata missing from
  `--json` outputs).
- `resolve_spec_path` / `resolve_feature_path` — registered by `@gtheys/pi-planning`
  (`packages/pi-planning`), loaded via `pi.extensions` manifest.
- `jira-aven-sync` — external binary, produces the tickets; out of scope.
- Tests: `packages/pi-planning/test/test.ts` (node --test, covers slugify +
  resolveFeaturePath). Skills have NO tests — nothing to update there. Docs are the
  only companion artifacts: `docs/aven-feature-flow.md` (+ README root package table
  untouched — skills aren't packages).

## Key Findings

1. **No code changes are strictly required** — detection is plain aven CLI queries
   both skills can express in bash; `resolve_spec_path` already exists. The feature is
   almost entirely skill-doc work + docs/aven-feature-flow.md, unless the planner
   chooses to add a tiny detection helper.
2. **Sync overwrite surface is exactly**: title, status, priority, description,
   labels, jira-status metadata. plan-path/plan-state/notes/epic/deps survive
   (verified live, DPX-S42H). Consequence: the interview note (via `aven note`) is a
   safe place for decisions; `--description` edits are NOT.
3. **Feature ticket status can drift**: sync remaps aven status from Jira every run,
   so the gate never relies on aven status — it already only uses `plan-state`
   metadata. Keep it that way (skills currently edit `--status todo` in step 5;
   harmless, but planner should note status is sync-owned for synced tickets).
4. **Phase/subtask tree is inherently safe**: created via `aven add` without
   jira-key metadata → sync's `list --has-metadata jira-key` never sees them.
5. Both skills already state `aven show <REF> --json # metadata.plan-path` — **that
   is wrong on aven 0.1.39** (JSON output omits metadata). The Jira work must fix the
   read mechanism: `show --full` text-parse (like jira-aven-sync does) or
   `aven list --metadata plan-state=<state> --open` filters (used in
   docs/aven-feature-flow.md quick reference).

## Gotchas

- `unknown-metadata-field` error on `--metadata`/`--has-metadata` filters before the
  first sync run — must be handled as "no synced ticket found", not a hard failure
  (jira-aven-sync already treats it that way; skills should match).
- `show --json` / `list --json` omit metadata — any new prose telling the agent to
  read `metadata.jira-key` from JSON will silently fail. Use `--full` parse or
  `list --metadata` filters.
- Jira ID ≠ aven ref (`DP-71` vs `PMR-XXXX`): "plan DP-71" must resolve through the
  jira-key lookup; conversely a user pasting an aven ref needs the `show` path. Both
  forms must appear in the input contract.
- Workspace routing: synced tickets can land in any workspace (`project_map`,
  cwd-inferred). From the wrong cwd refs fail with `unknown-ref`; skill already
  points at `aven doctor` — extend with `--workspace` hint for the Jira branch.
- `$LLM_NOTES_ROOT` may be unset → `resolve_spec_path` falls back to repo-local
  `notes/specs/` (the thing create-plan warns loudly against mkdir-ing). Planner
  should decide: borrow the warning verbatim, or force tool-output-verbatim language.
- Don't touch: `jira-aven-sync` repo, `create-plan`/`feature-plan`/`implement-plan`
  (taskwarrior siblings), live Jira writes, `resolve_spec_path` code.
- PMR-FAFX (the live ticket for this feature) is itself a synced-style epic with
  plan-state=draft — after implementation, the flow should be dogfooded on it.
