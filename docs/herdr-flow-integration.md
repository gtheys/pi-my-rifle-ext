# Herdr integration for the RPIV flow

This document explains the Herdr integration shipped in this branch: what it
is, how every piece works, why it is built the way it is, and where it can go
next. It is written for a cold reader — no prior context on
[pi-workflows](https://github.com/osolmaz/pi-workflows) (the project whose
Herdr design we ported) or on Herdr plugin internals is assumed.

The canonical RPIV flow doc remains [`rpiv-flow.md`](rpiv-flow.md); this doc
extends it and does not change any contract stated there.

---

## 1. What this adds

Four user-visible things, all gated on actually running inside Herdr:

1. **`/herdr-sync`** — links this repository into Herdr as a plugin
   (idempotent, explicit, never automatic).
2. **`/flow-view <ref> [placement]`** — opens a live viewer pane for one
   flow run, or focuses the existing pane for that run if one is already
   open. Placements: `right` (default), `below`, `left`, `above`, `tab`.
3. **A flow run-state journal** — every `/flow` invocation now records what
   happened (phases started/completed, research skips) to
   `~/.pi/agent/pi-flow/runs/<ref>.json` plus an append-only
   `<ref>.journal.jsonl`.
4. **`plugins/herdr/flow-viewer.mjs`** — the pane program Herdr runs. It
   renders the run state and updates live. Zero dependencies, plain Node.

And one root-level manifest that makes the repository itself a Herdr plugin:

```toml
# herdr-plugin.toml (repo root)
id = "gtheys.pi-my-rifle-ext"
name = "pi-my-rifle-ext"
version = "0.1.0"           # must equal package.json version — /herdr-sync enforces this
min_herdr_version = "0.7.0"
platforms = ["linux", "macos"]

[[panes]]
id = "flow"
title = "flow"
placement = "split"
command = ["node", "plugins/herdr/flow-viewer.mjs"]
```

Nothing here changes the gate model: **aven labels remain the sole source of
truth for gating decisions** (see §4.3).

## 2. Why port this at all

The RPIV flow has one structural observability gap: its run state lives in
aven labels, which is elegant (zero infrastructure, resumable, visible in the
task manager) but invisible in-flight. During a long `/flow` run there was no
answer to "what phase is this in, what already completed, and when?" without
opening aven and reading labels by eye.

[pi-workflows](https://github.com/osolmaz/pi-workflows) solved the same class
of problem with two mechanisms worth taking:

- **Durable run state** — a projection file plus an append-only event journal,
  so viewers read recorded state without touching the engine.
- **A native Herdr viewer pane** — the flow's status rendered in a split pane
  you can keep open beside your agent, driven entirely by Herdr's public
  plugin/pane APIs.

We ported both, deliberately at ~10% of their size, because pi-workflows is a
general workflow engine (SQLite server, resource managers, recovery
contracts) while we only needed the two mechanisms above for a five-phase
linear flow.

## 3. How it works

### 3.1 The run-state journal (`packages/pi-flow/run-state.ts`)

Two files per flow ref under `getAgentDir()/pi-flow/runs/`:

- `<ref>.journal.jsonl` — append-only, one JSON event per line:
  `run-start`, `phase-start`, `phase-complete`, `phase-skip`, `note`.
- `<ref>.json` — the current projection (schema `gtheys.pi-flow.run.v1`):
  ref, mode, skipResearch, startedAt/updatedAt, completedPhases,
  currentPhase, researchSkipNote, notes.

Design rules, in order of importance:

1. **Aven labels stay the gate source of truth.** The journal is an *evidence
   record*, not a decision input. If the journal disagrees with aven, aven
   wins for gating; the journal wins for history.
2. **Journal writes are best-effort.** A failed write can never break a flow
   phase — `journal()` in `index.ts` swallows errors by design.
3. **The projection is rebuildable.** If `<ref>.json` is deleted or corrupt,
   `recordRunEvent` replays the journal to reconstruct it. Torn tail lines
   (a crash mid-append) are skipped.
4. **Refs are validated at the boundary.** `runFileName()` only accepts
   `[A-Za-z0-9][A-Za-z0-9._-]{0,99}` — a ticket ref can never traverse out
   of the runs directory.

`/flow` writes `run-start`, a `phase-skip` note when `--skip-research` is
active, and a `phase-start` for the phase it is about to invoke. Individual
`/research`, `/plan` etc. commands can journal their own events the same way
(future work, §6.2).

### 3.2 The viewer pane (`plugins/herdr/flow-viewer.mjs`)

When Herdr opens a plugin pane it runs the manifest's `command` with three
environment variables:

- `HERDR_PANE_ID` — set by Herdr itself.
- `PI_FLOW_REF` / `PI_FLOW_RUN_FILE` — set by `/flow-view` (§3.3).

The launcher's contract (ported from pi-workflows' `viewer.mjs`):

1. **Validate everything before acting.** Ref and run-file against strict
   regexes, absolute path required, pane id format checked. Invalid → exit 1
   with the reason on stderr.
2. **Label its own pane first**: `herdr pane rename <id> "flow · <ref>"`.
   This label is the dedupe key — Herdr's public snapshot does not expose
   plugin metadata, but it does expose pane labels.
3. **Render the projection file**, then `fs.watchFile` it and re-render on
   change (1s poll interval inside `watchFile`; no external polling loop, no
   server, no aven dependency).
4. **Fail visible.** Missing run file renders "No run-state file — start the
   flow first: /flow <ref>" instead of a blank pane. The pane process stays
   alive either way.

It resolves nothing from `PATH`, never starts a server, and its only shell
outs are the single `pane rename`. Plain Node, no dependencies — it must run
in any environment Herdr can.

### 3.3 The opener (`packages/pi-flow/herdr/viewer.ts`)

`FlowHerdrViewer` is the Pi-side adapter. `/flow-view`:

1. Validates the ref and placement, and requires the run-state file to
   already exist (`/flow <ref>` must have run at least once).
2. `probe()` — `HERDR_ENV === "1"` plus a successful `herdr pane current
   --current`. Outside Herdr the command explains that and does nothing.
3. `open(ref, placement)`:
   - **Dedupe first**: scan `herdr api snapshot` for a pane labeled
     `flow · <ref>`; if found, `herdr plugin pane focus <id>` and done.
     This survives Pi reloads because the label lives in Herdr's own state,
     not ours. (In-memory `knownPanes` is just a fast path; stale entries are
     discarded on focus failure.)
   - Otherwise resolve the caller pane, then
     `herdr plugin pane open --plugin gtheys.pi-my-rifle-ext --entrypoint flow
     --env PI_FLOW_REF=<ref> --env PI_FLOW_RUN_FILE=<abs> --focus` with
     `--placement split --target-pane <caller>` (`right`/`below`) or
     `--placement tab --workspace <caller workspace>`.
   - `left`/`above` are emulated: open a `right`/`down` split, then
     `herdr pane swap` with the caller; if the swap fails, close the pane we
     opened and surface the error (no orphan panes).
   - Concurrent opens of the same ref share one promise — no duplicate panes
     from double keystrokes.

All herdr invocations go through `pi.exec` with a 5s timeout and bounded
output parsing (1MB JSON cap), mirroring pi-workflows' adapter discipline.

### 3.4 Plugin sync (`packages/pi-flow/herdr/sync.ts` + `/herdr-sync`)

`syncHerdrPlugin(repoRoot)` is a deliberate simplification of pi-workflows'
483-line setup:

- **Preflight** validates `herdr-plugin.toml` against `package.json`:
  plugin id, version equality (both must bump together), platform support,
  command shape, and that the launcher file exists. Any mismatch → clear
  error, nothing touched.
- Then the state machine against `herdr plugin list --json`:
  - herdr not installed (`ENOENT`) → `unavailable`, graceful skip.
  - no registration → `herdr plugin link <repo root>` → verify → `linked`.
  - registration matches (root + version + enabled) → `unchanged`.
  - matches but disabled → `herdr plugin enable` → verify → `enabled`.
  - stale (wrong root or version) → `unlink` then `link` → verify →
    `relinked`.
- Every mutation is verified by listing afterward; verification failure is a
  loud error, never a silent success.
- The result always reminds that running Pi processes need a reload to pick
  up plugin panes.

What we deliberately dropped from pi-workflows' version: the full rollback
machinery (restore-previous-registration on failure). Our plugin has exactly
one consumer (this repo) and one pane; a failed relink just means re-running
`/herdr-sync`. If this ever becomes multi-pane or published, port the
rollback too.

**Explicit-only**: nothing links during Pi startup. `/herdr-sync` is the only
path to registration, matching the repo's config rules (no implicit writes).

### 3.5 What was already there

The repo already had Herdr surface (title renamer, the subagents' verb layer
with `herdrPreflight`/version gate, the desktop-notify Herdr channel). This
integration adds the missing half — a pane the repo *owns* — and does not
touch the existing pieces. `pi-herdr-title` renames Pi panes `Pi - <cwd>`;
our viewer labels its own pane `flow · <ref>`; no overlap.

## 4. Design rules (stolen wholesale, on purpose)

These come from pi-workflows' `2026-08-18-herdr-piw-plan.md` and are now
this integration's invariants. If a future change violates one of these, the
change is wrong:

1. **No polling, no daemon, no state store.** The only periodic thing in the
   system is `fs.watchFile` inside the pane process itself. The Pi session
   holds no viewer state beyond a best-effort pane-id cache.
2. **Never construct commands from run data.** Ticket refs and file paths
   travel as `--env` values and argv entries, never interpolated into shell
   strings. Refs are charset-validated before they become filenames.
3. **Public APIs only.** `pane current`, `api snapshot`, `plugin pane
   open/focus/close`, `pane swap`, `pane rename`, `plugin list/link/unlink/
   enable`. No internals, no scraping, no fabricated commands.
4. **Bounded everything.** 5s command timeouts, 1MB JSON cap, 300-char
   error snippets, 60-char pane labels.
5. **Fail visible, fail closed.** Parsers throw on malformed herdr output
   rather than guessing. A dead pane shows its error; a dead opener closes
   the pane it opened.
6. **Ownership stays put.** aven gates, the journal records, the pane
   renders, Herdr manages topology. No component reaches into another's job.

## 5. Using it

```text
# once per machine (and after version bumps / repo moves):
/herdr-sync

# during a flow run:
/flow PMR-ABC123
/flow-view PMR-ABC123          # opens right split, focuses existing if reopened
/flow-view PMR-ABC123 below    # or left / above / tab
```

Outside Herdr, `/flow-view` prints "Pi is not running in Herdr." and
`/herdr-sync` reports "Herdr is not installed; plugin synchronization was
skipped." Both are no-ops, never errors.

## 6. Future improvements & features

Roughly in dependency order; each is small enough to be one ticket.

### 6.1 Journal phase-completion events (immediate)

Currently `/flow` journals `run-start` and the first `phase-start`, because
the orchestrator hands off to phase commands as chat prompts and completion
is observed by *aven labels changing* — which the extension doesn't watch.
Two options:

- **Cheap**: have each phase command (`/research` etc.) journal its own
  `phase-start` on invocation, and have `/flow` journal `phase-complete`
  for phases whose labels were already present at resume time. The viewer
  then shows "resumed past N phases" correctly.
- **Right**: a label-watch — after a phase command hands off, poll `aven
  show <ref> --json` labels on a bounded schedule (say 30s, 10min cap) until
  the completion label appears, journal `phase-complete`, and stop. This
  closes the loop and gives per-phase wall-clock timing, which the journal
  schema already records via event timestamps.

### 6.2 A `flow_status` tool for the agent (immediate)

Expose `readRunState` as a model-visible tool so the agent can answer "what
phase are we in" without shelling out to aven. Read-only; consistent with
pi-workflows' decision to *not* expose viewer control to the model.

### 6.3 `--prune` for the journal (short-term)

Run files accumulate forever. `/herdr-sync --prune` (or a `/flow-journal
prune`) could drop runs older than N days and list survivors. Keep the
journal-append-only within a run; pruning is whole-run deletion.

### 6.4 Widget line in Pi's status bar (short-term)

pi-workflows shows a `Ctrl+Shift+R piw` hint inside its workflow widget.
Equivalent: when `probe()` says Herdr is available and a run is active, show
`/flow-view <ref>` on the session's status line. Needs a Pi widget API
surface; investigate `pi-herdr-title`'s session hooks for the right event.

### 6.5 Workspace placement + multi-run dashboard (medium)

Two viewer extensions:

- **`workspace` placement** — transactional `workspace create` → open pane →
  close bootstrap tab, with rollback on failure (port `openWorkspace` from
  pi-workflows verbatim; it's the trickiest 60 lines they have).
- **A runs-list mode** — `flow-view` with no ref renders the `runs/`
  directory: every ref, phase progress, last update. Makes the journal
  double as a flow portfolio view. The launcher already renders from files;
  this adds directory enumeration + a table view.

### 6.6 Journal → flow-level execution tracing (medium, strategic)

This is the bridge to the observability goal recorded on 2026-10-19:
*"flow-level execution tracing — what steps were done, where a flow failed,
where I had to intervene manually."* The journal is already the right shape
(append-only events with timestamps). Next steps in order:

1. Add event kinds: `intervention` (user steered mid-phase), `retry`
   (implement retry.ts fires), `gate-refusal` (a phase command refused).
2. A small exporter that tails the runs directory into the homelab (the
   ClickHouse/Postgres on chicken) — one table, one row per event. No SaaS,
   no per-token noise, exactly the "in-harness event log" conclusion.
3. Dashboards on top: phase duration distributions, intervention frequency
   per ticket, where flows stall. This is the data that answers "how do my
   flows actually run" — which was the whole point.

### 6.7 Recovery contracts for `/implement` (medium)

Port pi-workflows' `idempotentEffect` / `manualEffect` idea as a declaration
in implement outputs: when the implement phase reports its work, it must
classify each side effect (commits pushed, migrations run, deploys) as
idempotent-safe-to-retry or manual-recovery-required. Store as journal
`note` events first (zero engine change), promote to structured fields once
the shapes settle. `/flow` resume after a mid-implement crash then has a
record of what was already done.

### 6.8 Missing-submission watchdog (medium)

If a phase command dies without completing (session killed, model wandered
off), nothing notices today. A session-start check comparing
`currentPhase !== null` + label absence could emit a bounded reminder —
"PMR-ABC123 implement started 2h ago, no `active` label — resume with
`/implement PMR-ABC123`?" Port of pi-workflows' "missing-submission
reminders" at flow granularity.

### 6.9 Herdr plugin marketplace (long-term, only if this goes public)

pi-workflows qualifies for Herdr's public plugin marketplace via a root
`herdr-plugin.toml` and the `herdr-plugin` GitHub topic. If this repo ever
publishes as an npm package for others: add the topic, keep manifest/package
versions in lockstep (already enforced by preflight), and port the rollback
machinery from pi-workflows' setup before strangers run `/herdr-sync`.

### 6.10 Viewer polish (long-term)

- ANSI colors keyed to phase health (green complete, yellow running, red
  stalled — where "stalled" = currentPhase set but updatedAt > 30min old;
  the data is already in the projection).
- Keybindings inside the pane (r = re-render, q = request close via
  `herdr plugin pane close`).
- Phase timing column from journal timestamps (needs 6.1).

## 7. Testing

- `packages/pi-flow/test/run-state.test.ts` — projection semantics, journal
  append + rebuild-from-journal, ref validation, idempotent completions.
- `packages/pi-flow/test/herdr-viewer.test.ts` — placement parsing, label
  construction, all three herdr JSON parsers including fail-closed cases.
- `packages/pi-flow/test/herdr-sync.test.ts` — fixture-repo preflight
  (version mismatch, wrong id, missing launcher) and the full sync state
  machine against a fake spawn (link/unchanged/enable/relink/unavailable/
  list-failure).

All pure — no herdr, aven, or Pi needed. Live verification checklist for a
real Herdr session: `/herdr-sync` → `/flow <ref>` → `/flow-view <ref>` →
re-run `/flow-view <ref>` (expect "Focused existing…") → `/reload` Pi →
`/flow-view <ref>` again (expect focus, not a duplicate pane) → `herdr
plugin list` shows `gtheys.pi-my-rifle-ext` at the repo version.

## 8. References

- pi-workflows' plan that this design is ported from:
  `docs/2026-08-18-herdr-piw-plan.md` in osolmaz/pi-workflows.
- Their client-contract doc (why panes resolve nothing themselves):
  `docs/2026-09-21-piw-client-resolution-plan.md` in the same repo.
- Our base flow contract: [`rpiv-flow.md`](rpiv-flow.md).
