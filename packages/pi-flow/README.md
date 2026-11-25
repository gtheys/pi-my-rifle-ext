# pi-flow

PIV flow extension — `/brainstorm /plan /implement /validate /feedback`
phase commands plus the `/flow` orchestrator, routed over
pi-interactive-subagents (pi-planning, pi-review and pi-worktree were
absorbed into this package — plan-tools, jira_create_branch, `/review`,
`/sonarqube`, `/pr-quality`, `/pr-watch`, the `worktree` tool and their
agent tools now live here).
Canonical flow documentation: [`docs/piv-flow.md`](../../docs/piv-flow.md).

## Dependencies

Runtime:

| Package | Why | Used by |
|---|---|---|
| `@gtheys/pi-interactive-subagents` (`workspace:*`) | Spawn-and-watch substrate: launches agent sessions into herdr panes, keeps durable assignment records, steers results back | `review/review.ts` (reviewer spawn), `spec-review/publish.ts` (publish worker), `index.ts` (`hasLiveAssignmentForParent` for the flow loop) |

Peers: `@earendil-works/pi-coding-agent` (host API), `@earendil-works/pi-tui`
(review UI), `typebox` (config schema validation).

Failure behavior:

- **Package not installed** — the imports are static ESM, so pi-flow fails to
  load at startup with a visible error. No partial registration, no silent
  fallback. Fix: install the package (declared dependency, automatic) and
  restart pi.
- **No mux** (herdr binary missing or server down) — graceful per call site:
  `/review` falls back to the in-session review path, `/spec-publish` prints
  the manual git recipe, the flow loop reads on-disk assignment records and
  is unaffected.
- **Spawn fails with a mux present** — the failure steers back as a visible
  `review_result` message; PR worktree cleanup is refcounted so a crashed
  reviewer cannot tear down a shared worktree.

## Commands

| Command | What it does |
| --- | --- |
| `/brainstorm <topic \| ID=<jira-id> \| --debug <symptom>>` | Standalone (not a lifecycle phase): question loop + scouts → artifact in `notes/brainstorm/` → ticket-creation gate (explicit confirm; work: Jira, personal: aven). `ID=<jira-id>` (or a bare jira-shaped topic in work mode) brainstorms the existing ticket instead: aven local epic first (`jira-ref` metadata), `acli jira workitem view` fallback; no creation gate; the brainstorm artifact path is stored on the ticket as `research-path` metadata. `--debug <symptom>` routes through the user's `debug` skill to a root cause. |
| `/plan <ref>` | Work: `feature-plan-aven` skill (epic tree, plan-state approval). Personal: size check → human-confirmed oneshot vs plan split; plan.md + epic/subtasks for plans. Ends with status `todo` + `planned` label — work mode: only after the approval-gated tree stage (premature `planned` would misroute `/implement`). |
| `/implement <ref>` | Gate: `planned` required. Routes bug / plan / oneshot. Worktree isolation, per-task implement→test→commit, retry budget 3 then blocked + escalate. |
| `/validate <ref>` | Work: ordered cluster gate (minikube → connectivity → queues → deploy → manual tests → Jira evidence comment). Personal: human runs the test. Then the review gate: `/review` → `blockers_count` artifact; 0 → land, >0 → back to `/implement`. |
| `/feedback <ref>` | Work: `/sonarqube` + `/pr-quality` triage (mechanical fixes committed, behavioral findings become new tasks). Personal: wrap-up phase after validate's local ff-only merge — verifies the merge landed, writes the outcome summary note, files review-feedback backlog tickets, then sets `done` and completes the phase (no `flow_land`, push stays blocked). |
| `/spec-review [--workspace <name>]` | Lists every spec at `plan-state=review` (aven metadata query), batch-picks them, opens each plan.md in a herdr nvim pane, and injects a review prompt: the session fixes spec issues in place; transitions to approved only via explicit "approve <REF>" (pins `plan` label, plan-state=approved, status todo). |
| `/spec-publish <ref>` | Launches a worker subagent that publishes the approved plan.md to the ticket's notes repo (plan-state gate). |
| `/review-spec <path>` | Opens a plan/spec in a herdr nvim `spec-review` pane (absorbed from pi-planning). |
| `/review [target]` | Code review via a fresh-context `reviewer` subagent — PR / branch / commit / uncommitted / folder / custom; optional ocr second opinion; emits a machine-readable `blockers_count: <N>` verdict the `/validate` review gate consumes (absorbed from pi-review). |
| `/sonarqube [pr]` | SonarCloud coverage gaps + quality issues for a PR, analysis-only (absorbed from pi-review). Requires `SONARQUBE_TOKEN`. |
| `/pr-quality [pr]` | Unresolved GitHub review threads + SonarCloud issues in one triage pass (absorbed from pi-review). |
| `/pr-watch` | Background-polls PR checks; auto-triggers `/pr-quality` when they complete (absorbed from pi-review). |
| `/flow-cost <ref> [--push]` | Per-ticket cost rollup: replays the run journal, attributes each spawned session's token usage and tool calls to agent/subtask, prints the table. `--push` additionally exports the rollup as Prometheus metrics to a Pushgateway (env-gated, see below); failures warn and never fail the command. Reruns any time — it replays the journal, so it doubles as the backfill path. The rollup also prints a per-phase step outputs section (advisory, never blocking) summarizing the `flow_submit` step-output submissions per phase.
| `/flow-reconcile-push [--dry-run]` | Runs the stale-liveness reconcile NOW instead of waiting for the daemon timer: tombstones the `pi_flow_run_status` liveness series of runs whose aven ticket is neither active nor todo, so halted/paused alerts stop firing on tickets that closed weeks ago. Takes **no ref** — one pass covers every run journal. `--dry-run` decides without pushing. Output is one summary line plus one line per stale ref (`PMR-X (ticket done) journal=halted → tombstoned`); gateway and aven failures come out as warnings. Details under [Reconcile](#reconcile-stale-run-tombstoning). |
| `/herdr-sync` | Links this repo as a Herdr plugin (idempotent, explicit-only). |
| `/flow-view <ref> [placement]` | Opens/focuses a Herdr pane rendering the run-state journal for a ref. |
| `/flow-diagram <ref> [run]` | Renders the per-ticket flow timeline as a self-contained HTML sequence diagram (one lane per subagent + orchestrator, phase markers, tool arrows with dashed returns, per-lane token totals). Writes to `pi-flow/diagrams/<ref>.run<k>.<stamp>.html` and best-effort opens it; the file path is always the deliverable. |
| `/flow <ref>` | Extension-owned loop: injects one phase prompt at a time (same builders the phase commands use, gates intact), then advances when the phase turn settles and its completion label has landed; missing label → halt note + stop. Resume = first phase whose completion label is missing. Work mode + Jira ID: find-or-create the local epic (`jira-ref` metadata, dep-linked to the synced ticket) and run on the epic ref. |
| `/flow` (bare) | Same gate picker as `/flow <ref>`, plus an extra "Start a flow on a ready ticket…" row; picking it opens the cwd-project's ready tickets from `aven list --ready` and Enter starts the flow exactly like `/flow <ref>`. Zero open gates skips the menu and goes straight to the ticket list. Esc cancels silently. |

Lifecycle labels on the aven ticket are the run state:
`planned → active → review-passed → done`; type labels
`bug` / `oneshot` / `plan` route `/implement`.

## Tools

Agent-callable tools registered by pi-flow:

| Tool | What it does |
| --- | --- |
| `flow_phase_complete` | The ONLY way to write lifecycle labels — re-checks the phase gates before exec'ing aven; direct `aven edit --label` mutations are blocked at the bash tool_call boundary. |
| `flow_land` | Gates landing behind the `review-passed` label (+ optional `blockers_count` artifact); authorizes `git push` / `gh pr create` for the ref, which are otherwise blocked while a flow is active. Also declares the run's side effects (see [Effect contracts](#effect-contracts) below). |
| `flow_run_attempt` | Owns the implement-phase retry budget: 3 total attempts, the 3rd failure escalates and further attempts are refused. |
| `flow_submit` | Advisory step-output journal: reports step evidence (plan written, test run, PR/gate check, merge outcome) per phase. Never gates completion — a warned submission never blocks a phase. |
| `spec_approve` | Only path from plan-state `review` → `approved` (pins the `plan` label, moves the ticket to todo). |
| `resolve_spec_path` / `resolve_feature_path` / `resolve_notes_path` | Canonical flow-document path resolution — spec/plan.md for a Jira ticket or personal feature, and generic notes paths via `resolve_notes_path` (`subdir` allowlist: `""` root, `prs`, `specs`, `research`, `tickets`). The single contract for every document path — never hand-roll (absorbed from pi-planning). |
| `open_in_pane` | Opens a file with nvim in a herdr pane for review (absorbed from pi-planning). Call it only after the file write returned; it polls ~1s for the file. Called from a subagent, it opens a durable `spec-review` tab instead so the pane survives subagent cleanup. |
| `jira_create_branch` | Derives and creates a git branch from a Jira issue (absorbed from pi-planning). Requires `acli` + `git-town`. |
| `review` | Starts a code review of uncommitted changes / branch / commit / PR / folder / custom instructions (absorbed from pi-review). |
| `sonarqube` | Fetches SonarCloud coverage gaps + quality issues for a PR as an actionable report (absorbed from pi-review). |
| `pr_quality` | Gathers unresolved PR review threads + SonarCloud issues into a triage prompt (absorbed from pi-review). |
| `worktree` | Creates, lists, and removes Herdr-managed git worktree workspaces (absorbed from pi-worktree). |

### Automatic worktree cleanup

Flow-created worktrees are cleaned up automatically at three trigger points:
loop-driven flows clean up via the done handler, a `/flow` rerun of a
harness-completed flow cleans up its bound worktree, and session start or
flow start sweeps run-journal refs whose flow is done. Deletion only happens
when the merge is provable (merge-base ancestor of main for personal flows,
PR MERGED state for work flows); dirty, in-flight, or unproven worktrees are
never deleted — they are deferred with an aven note and retried by a later
sweep.

## Effect contracts

Before a risky action runs, the agent declares it in the run journal. Six
actions are declared: push to remote, create PR via `gh`, the personal
merge-main (`git merge --ff-only` into your main checkout), worktree create,
worktree remove, and workspace-close (the `worktree` prune action, which only
ever closes a workspace proven dangling — checkout gone, no agents). Each
declaration carries a plain-language undo recipe.

How it holds:

- **Fail-closed**: if the journal write fails, the action is refused. No
  journal, no effect.
- **Worktree gating**: the create/remove actions are gated inside the
  `worktree` tool itself — the command must match exactly, not via regex.
- **Honest limit**: bash detection (push, PR create, merge) catches literal
  commands at command position only. Aliases, `sh -c '...'`, and
  variable-built commands are **not** detected. This is a guardrail against
  accidental effects, not a privilege boundary. Humans typing in their own
  terminal are out of scope.

## Configuration

Global config lives at `~/.pi/agent/pi-flow/config.json` (schema:
[`config.schema.json`](config.schema.json)). A project-local
`<repo>/.pi/pi-flow/config.json` is merged on top (project wins per key) —
handy for enabling telemetry per checkout, or for pinning a per-repo
`landTestCommand` (e.g. `"landTestCommand": ["cargo", "test"]` in a rust
checkout) instead of machine-wide.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workRoots` | `string[]` | `[]` | Absolute path prefixes; a git toplevel under any prefix is `work` mode |
| `avenWorkspace` | `string` | unset | Aven workspace name or key forced on every aven call pi-flow makes (skips cwd inference and the search fallback) |
| `yolo` | `boolean` | `false` | Run `/flow` phases without confirmation gates. Only applies when the `--yolo` flag is absent on the invocation — an explicit flag wins over config |
| `landTestCommand` | `string[]` | detected, else `["bun","run","test"]` | Argv of the test command `flow_land` runs itself before authorizing a landing — the gate never trusts a claimed-green suite. When unset, the command is detected from repo signals in a fixed order: `bun.lock`/`bunfig.toml` → `bun run test`, `Cargo.toml` → `cargo test`, `package-lock.json` → `npm test`, `pnpm-lock.yaml` → `pnpm test`. The summary of every run names the command and its source (config / detection / default) |
| `telemetry.enabled` | `boolean` | `false` | Master switch for OTLP telemetry. `false` or a missing `telemetry` block = the session probe subscribes to nothing, allocates nothing, makes no network calls |
| `telemetry.otlpEndpoint` | `string` | unset (required with `telemetry`) | OTLP/HTTP base URL (e.g. `https://host:4478`); spans POST to `<endpoint>/v1/traces` |
| `telemetry.headers` | `record<string, string>` | `{}` | Static extra headers for OTLP export. Secrets belong in env (`PI_FLOW_OTLP_TOKEN`), not config |
| `telemetry.captureContent` | `"off" \| "text" \| "tools" \| "all"` | `"off"` | Content layers added to spans (cumulative): `off` metadata only, `text` assistant text, `tools` + tool calls and tool input/output, `all` + model reasoning. See [Capturing content](#capturing-content-in-spans) |
| `telemetry.jiraBaseUrl` | `string` | unset | Base URL for Jira issue links, e.g. `https://example.atlassian.net/browse/`. Work-mode spans then carry `flow.url` = base + Jira key, so dashboards can link tickets to Jira. Unset = no links |
| `telemetry.maxContentChars` | `integer` (100–100000) | `2000` | Max characters per captured content attribute; longer values end with `…[truncated N chars]`. Tempo drops anything past its `max_attribute_bytes` (default 2048) silently, so raise both together |
| `telemetry.loki.enabled` | `boolean` | `false` | Push flow **transition-event** streams (`state-change` / `step-start` / `step-stop`) to Loki from the live session (PMR-ZV9Y 4.2). `false` or a missing `loki` block = zero Loki network calls. Session-side only — the daemon never pushes Loki. See [Loki transition events](#loki-transition-events) |
| `telemetry.loki.endpoint` | `string` | unset (required with `telemetry.loki.enabled`) | Loki **base** URL you provide yourself (e.g. `http://100.108.226.64:3100`); events POST to `<endpoint>/loki/api/v1/push` (the push path is appended for you) |
| `telemetry.loki.headers` | `record<string, string>` | `{}` | Static extra headers for the Loki push (e.g. a Bearer token in front of a reverse proxy). Secrets belong in env, not config |
| `notify.desktop.enabled` | `boolean` | `true` | Send a desktop notification on `waiting_human` / `halted` flow transitions through [`pi-desktop-notify`](../pi-desktop-notify/README.md) (PMR-ZV9Y 5.2). `false` turns the **flow-side page** off — the user's own channel toggles (desktop / herdr / ntfy) still live in pi-desktop-notify's config, and Grafana alerting is unaffected (independent channel). See [Notifications](#notifications) |
| `runServer.enabled` | `boolean` | `true` | Kill switch for the durable run server (PMR-XTQQ). `false` = never spawn the daemon; journal writers permanently use the full in-session path (runs don't survive a session exit) |
| `reconcile.enabled` | `boolean` | `true` | Reconcile stale run-liveness metrics — tombstone `halted`/`paused` Pushgateway series whose aven ticket is neither active nor todo, so the alerts only ever fire on runs that still need you. Setting it to `false` on a RUNNING daemon takes effect on the next tick; setting it to `true` again only takes effect at daemon start — a daemon that started with `enabled: false` armed no timer, so restart the daemon (or run `/flow-reconcile-push` once). See [Reconcile](#reconcile-stale-run-tombstoning) |
| `reconcile.intervalMinutes` | `integer` (≥ 1) | `360` | Daemon reconcile interval in minutes (6 h by default). An interval change applies on the next cycle — no daemon restart needed |
| `liveness.enabled` | `boolean` | `true` | Push full run bodies — `pi_flow_run_status{status="running"}` refresh — to the Pushgateway while runs are in flight, so the board shows running flows. See [Liveness](#liveness-running-flow-visibility) |
| `liveness.intervalMinutes` | `integer` (≥ 1) | `5` | Daemon liveness push interval in minutes (5 min by default). An interval change applies on the next cycle — no daemon restart needed |

```json
{
  "$schema": "https://raw.githubusercontent.com/gtheys/pi-my-rifle-ext/main/packages/pi-flow/config.schema.json",
  "workRoots": [
    "/home/dev/Code/salaryhero"
  ],
  "avenWorkspace": "personal",
  "yolo": false,
  "landTestCommand": ["bun", "run", "test"],
  "telemetry": {
    "enabled": false,
    "otlpEndpoint": "https://tempo.example.com:4478",
    "loki": {
      "enabled": false,
      "endpoint": "http://100.108.226.64:3100",
      "headers": {}
    }
  },
  "notify": {
    "desktop": {
      "enabled": true
    }
  },
  "runServer": {
    "enabled": true
  },
  "reconcile": {
    "enabled": true,
    "intervalMinutes": 360
  },
  "liveness": {
    "enabled": true,
    "intervalMinutes": 5
  }
}
```

### Durable run server

Since PMR-XTQQ, a small detached daemon (plain node, own event loop) makes
`/flow` runs survive a session exit. The extension ensures it is alive at
`/flow` start only (pidfile + liveness + protocol-version probe at
`<agentDir>/pi-flow/server.pid`; mismatch → kill + respawn). Reopening a
session does not spawn it — only the pending-record consumer runs then; a
dead daemon is respawned by the next `/flow`.

What it does: the daemon is the ONLY projection writer while alive — journal
writers route journal-only through `server/writer.ts` (per-write liveness
probe) and the daemon reprojects. Parked runs (awaiting an outcome at a phase
or human gate) are recorded in `pending/<ref>.json`; when a session with a
restored flow binding for that ref reopens, the record is consumed exactly
once (atomic rename) and `/flow <ref>` is re-presented automatically.
Loop state (blocker retries, validate cutoff), the attempt ledger, and the
human code-review pass receipt are all journaled and re-seeded on resume.

**Resume consent**: a parked run is never silently taken over by a different
session. A clean session that starts in a repo with live flow runs *asks*
first — one `Resume <ref> — <phase>, <status>, updated <age>` row per run
plus `None — leave this session clean` (a run whose owner session still looks
alive is labelled as such) — and only the run you pick is restored, healed
and re-presented. Declining (or Esc) leaves the session completely clean: no
binding, nothing injected, just one line naming the recovery command. A run
that parked *after* startup is caught by the same prompt on the next settle,
at most once per process. A session with no UI is never prompted at all — it
lists `recover with /flow <ref>` per parked run and stays clean. The session
that already owns the run (its binding came back with the session history)
still resumes automatically, no question asked.

On-disk layout under `<agentDir>/pi-flow/`: `server.pid`, `server.log`,
`pending/`, `runs/`.

- **Disable**: set `"runServer": { "enabled": false }` — the daemon is never
  spawned and writers permanently use the in-session full path.
- **Degrade**: daemon absent or dead = today's pre-PMR-XTQQ behavior. The
  journal stays the authority; the projection and pending records are
  rebuildable caches. Known limits: the projection lags ≤~1s while the daemon
  owns it (only `/flow-view` reads it — receipts and gates read the journal
  and aven directly), and a brand-new session in the same worktree without a
  restored binding is never auto-bound — it only gets the resume prompt above
  (or the `recover with /flow <ref>` lines when there is no UI).

**Binding self-heal after resume**: when a resumed session has no replayable
flow binding (cross-session resume, fork), the flow gate tools
(`code_review`, `deviation_review`, `flow_land`, `worktree` bind) re-derive
the worktree binding from durable state (aven `worktree:` note, herdr
worktree list, pending-run records) and re-arm it themselves — no manual
`/flow <ref>` re-arm needed. When derivation fails, every refusal names the
exact recovery command (`/flow <ref>`) for that ref.

### Telemetry (OTLP traces)

Optional and **disabled by default**. When enabled, every Pi session (the main session and each spawned worker, joined via the flow env stamps) exports spans to any OTLP/HTTP receiver (metadata only unless you opt in to content capture below) — Tempo, Alloy, the OTel collector, whatever speaks `/v1/traces`.

Enable it in the config file (no secrets in here):

```json
{
  "telemetry": {
    "enabled": true,
    "otlpEndpoint": "https://tempo.example.com:4478"
  }
}
```

Set the bearer token in the shell that starts Pi, never in config:

```sh
export PI_FLOW_OTLP_TOKEN=<token>   # sent as "Authorization: Bearer <token>"
```

**Disabling again**: set `"enabled": false`, or delete the `telemetry` block entirely. Either way the session probe subscribes to nothing and allocates nothing — telemetry leaves zero footprint until the next Pi restart, which fully forgets the settings.

Semantics (test-gated, see `telemetry/index.ts`):

- **Metadata only by default**: spans carry `flow.ref` / `phase` / `agent.name` / `subtask` and GenAI convention attributes (`gen_ai.usage.input_tokens`, `gen_ai.request.model`, ...). Prompt and completion bodies only appear when you set `telemetry.captureContent` (below).
- **Trace joining**: spans attach to the run's W3C trace via `PI_FLOW_TRACEPARENT`, so one `/flow` run is one trace in the backend. Find it in Tempo with TraceQL `{ .flow.ref = "<REF>" }`.
- **No-backend safety**: export is fire-and-forget with a 2.5s timeout. Failures write at most ONE journal note per process and then stay silent — no retry queue, no buffer growth, never a rejected promise into the host. Flows run identically with no receiver at all.

#### Work mode vs personal mode

Every run is tracked by a **tracking ref**: in **personal mode** the aven ref (as before); in **work mode** the **Jira key** — taken from the Jira ID you typed (`/flow DP-236`), else from the local epic's `jira-ref` metadata when you pass the aven epic, else the aven ref. The aven ref still drives the run journal and every aven operation; only telemetry and metrics are keyed by the tracking ref.

- Spans carry `flow.ref` (tracking ref), `flow.aven_ref` (when different), `flow.mode` (`work` | `personal`) and, with `telemetry.jiraBaseUrl` set, `flow.url` (work mode only).
- Cost metrics use the tracking ref as their `ref` label. Work-mode pushes go to a `mode="work"` Pushgateway group; personal pushes keep their original group (no mode label), so existing history is untouched.
- The Grafana dashboards have a **mode** switch (Personal / Work / All) and show an "Open in Jira ↗" link for work tickets.

#### Capturing content in spans

By default spans never carry what the model said or what the tools did. `telemetry.captureContent` opts in, in three **cumulative** layers — each level includes everything below it:

| Level | Adds | Span attributes |
| --- | --- | --- |
| `off` (default) | nothing — metadata only | — |
| `text` | what the model answered | `gen_ai.completion` on `gen <model>` spans |
| `tools` | + the tool calls the model made, + what each tool received and returned | `gen_ai.tool_calls` (JSON `[{name, arguments}]`) on gen spans; `tool.input` (JSON args) and `tool.output` (text result) on `tool <name>` spans |
| `all` | + the model's reasoning | `gen_ai.reasoning` on gen spans (redacted thinking is skipped) |

```json
{
  "telemetry": {
    "enabled": true,
    "otlpEndpoint": "https://tempo.example.com:4478",
    "captureContent": "tools",
    "maxContentChars": 2000
  }
}
```

Find the content in Grafana by opening a trace and clicking a span (Span attributes), or search it with TraceQL, e.g. `{ .gen_ai.completion =~ ".*migration.*" }` or `{ .tool.output =~ ".*ENOENT.*" }`.

Things to know before turning it on:

- **It can leak secrets.** Tool inputs/outputs and reasoning contain file contents, env dumps, tokens and personal data, and they land in the trace backend (Tempo keeps 14 days on the homelab) and everyone who can open Grafana can read them. There is **no redaction** — the level is the control. Start with `text`, and use `tools`/`all` only on a backend you trust.
- **Per-attribute cap.** Each value is cut at `maxContentChars` (default 2000) and ends with `…[truncated N chars]`. Tempo truncates attribute values beyond its `max_attribute_bytes` (default 2048) **silently**, so a larger `maxContentChars` only helps if you raise Tempo's limit too (Tempo exposes `tempo_distributor_attributes_truncated_total` to see it happening).
- **Per span, not per run.** Content is on the individual gen/tool spans. Phase, root and worker-session spans stay metadata-only.
- **Applies to every process.** Workers read the same config, so a worker's gen and tool spans carry content at the same level.
- **Restart Pi** after changing the setting; the config is read once per session.

#### Loki transition events

Alongside OTLP traces, pi-flow can push the **v2 state-machine transitions**
(`state-change`, `step-start`, `step-stop`) it journals to a Loki log stream,
so Grafana can show a per-run timeline and the Waiting-on-me queue can read
*what is waiting on me* straight from the events. This is a separate, opt-in
transport nested under the same `telemetry` block; it has its own
`loki.enabled` switch and ships **disabled by default**, so turning Loki on or
off is independent of whether OTLP traces export.

```json
{
  "telemetry": {
    "enabled": true,
    "otlpEndpoint": "https://tempo.example.com:4478",
    "loki": {
      "enabled": true,
      "endpoint": "http://100.108.226.64:3100",
      "headers": {}
    }
  }
}
```

You expose the Loki endpoint yourself (PMR-ZV9Y D2 — no bundled collector);
`telemetry.loki.endpoint` stores the **base** URL only and the pusher appends
`/loki/api/v1/push`, so the example above POSTs to
`http://100.108.226.64:3100/loki/api/v1/push`. A Bearer token in front of a
reverse proxy belongs in `telemetry.loki.headers` (or better, env), not baked
into a committed config.

Semantics (test-gated, see `telemetry/loki.ts`):

- **Closed labels only.** A stream carries `job="pi-flow"` plus the closed v2
  enum set — `flow_ref`, `mode`, `phase`, `state`, `reason`, `wait_kind`,
  `kind` — and nothing else. Free text (the halt `note` prose, deviation
  reasons) rides the JSON **line**, never a label, so Loki cardinality stays
  bounded. Query the whole family with `{job="pi-flow"}` and slice by `state`
  or `flow_ref`.
- **Session-side only.** The live session's journal-writer fan-out pushes
  each event as it is recorded; the durable daemon never pushes Loki (it has
  no live event stream). One strict config reader, no daemon mirror.
- **Fail-silent.** Fire-and-forget with a 2.5 s timeout. An unreachable or
  unconfigured endpoint writes **at most ONE** journal note per process and
  then stays silent — no retry queue, never a rejected promise into the flow
  loop. Runs proceed identically with no Loki backend at all. The unit tests
  mock `fetch`, so nothing here depends on the endpoint being live.
- **Restart Pi** after changing the setting; the config is read once per session.

### Notifications

When a flow stops and needs someone, pi-flow can surface it two ways. They are
**independent channels with independent off-switches** (PMR-ZV9Y D3): turn
either one off and the other keeps working, and neither affects the run itself.

| Channel | What it does | Off-switch |
| --- | --- | --- |
| **Desktop** | Pages you on a `waiting_human` or `halted` transition, through [`pi-desktop-notify`](../pi-desktop-notify/README.md) (notify-send / herdr / ntfy) | `notify.desktop.enabled` in pi-flow config (default `true`) — and the channel toggles in pi-desktop-notify's own config |
| **Grafana alerting** | Fires the `pi-flow-runs` alert rules (`piflow-waiting-on-human`, `piflow-run-halted`, …) on the Prometheus/Loki series | Grafana itself: pause or mute the rule / alert group. pi-flow has no switch for it and never will — the alerting backend is not this extension's business |

**Desktop channel.** Only two v2 states page: `waiting_human` (a human unblocks
it) and `halted` (a human must). `waiting_machine` — a retry budget, a
subagent still in flight, a deviation gate re-run — is a Grafana/Loki concern,
never a notification, and `running` / `done` are silent. The message is the
journal event, nothing else:

```
pi-flow PMR-ZV9Y: waiting_human
/flow answer PMR-ZV9Y pass|fail — reason: code_review_pending
```

```
pi-flow PMR-ZV9Y: halted
reason: label_miss — recover with /flow PMR-ZV9Y
```

The first line of the body is the **expected action** — the exact command from
the same `expectedAction` map the Waiting-on-me board renders, so what you type
is what the board already advertised. Only the closed reason enum is quoted;
free-text halt prose never enters a notification.

Semantics (test-gated, see `telemetry/dispatch.ts` and `test/notify-hook.test.ts`):

- **Opt-out.** `notify.desktop.enabled` defaults to `true`: a fresh install
  pages. Set it to `false` (global or per-project config) for silence, no Pi
  restart needed beyond the next config read (`session_start` / `/flow` start).
- **One page per event, not per state.** The loop already suppresses
  same-state repeats inside a process, so a duplicate only happens when a gate
  genuinely re-asks (you declined a review, the run re-parked) — that earns a
  second page. A resumed run in another session re-notifies the same wait:
  accepted, because the journal is the audit record and the notification mirrors it.
- **Fail-silent, optional dependency.** `@gtheys/pi-desktop-notify` is an
  *optional* dependency, loaded by dynamic import on the first paging event.
  Not installed, or its config malformed, or the notify backend dead → **one**
  journal note (`desktop notify unavailable: … (channel off, further failures
  silent)`) and the channel switches off for the session. It is fire-and-forget:
  it never delays a journal write and never throws into the flow loop. Grafana
  alerting is unaffected either way.

```json
{
  "notify": {
    "desktop": {
      "enabled": false
    }
  }
}
```

### Cost rollup push (`/flow-cost --push`)

The offline `/flow-cost <ref>` table needs nothing but the local journal. The optional `--push` export to a Prometheus Pushgateway is env-gated:

```sh
export PI_FLOW_PUSHGATEWAY_URL=https://pushgateway.example.com:4479
export PI_FLOW_PUSHGATEWAY_TOKEN=<token>
```

Push failures print a warning and never fail the command; rerun `/flow-cost <ref> --push` any time to re-export or backfill.

**Automatic push**: with `PI_FLOW_PUSHGATEWAY_URL` set, the same rollup is pushed for you whenever a `/flow` run ends — completed, halted, or paused for spec approval. A one-line notice confirms it (`flow-cost <ref>: cost metrics pushed to the pushgateway.`); a failure shows a warning with the retry command. With the URL unset nothing happens. Pushing is idempotent (same-identity series are overwritten in place — official Pushgateway replaces the whole group, the homelab build was verified to merge on write, PMR-WBC2), so a resumed flow just refreshes the numbers. The rollup covers spawned workers and, for runs started after the `main-session` journal event existed, the main session split across plan / implement / validate. It also includes a per-phase **step outputs** section summarizing `flow_submit` submissions (advisory evidence, never blocking). While a run is still in flight the daemon refreshes the same body on its own timer — see [Liveness](#liveness-running-flow-visibility).

### Reconcile (stale run tombstoning)

Pushgateway groups never expire on their own: a `/flow` run that halted or
paused keeps exporting `pi_flow_run_status{status="halted"}` forever, so
halted/paused alerts go on firing for tickets that closed weeks ago (PMR-V36Y
started as exactly that — four alerts on four dead runs). Reconcile retires
those series by **tombstoning** them.

**What counts as stale.** A journal run whose projected loop status is
`halted` or `paused` AND whose aven ticket status is neither `active` nor
`todo` (backlog, inbox, done, canceled, or the ticket is gone). `todo` counts
as live because gate-waiting runs park there (the flow loop moves tickets to
`active` later); backlog stays stale — an abandoned run parked in backlog
must not page. A live ticket keeps its series; a running journal is never
touched.

**A gap in the ticket listing never tombstones a live run.** Liveness is read
from `aven list`, and `aven list` is workspace-routed, so its answer can be
valid yet incomplete (a configured `avenWorkspace` other than the two
workspaces pi-flow pins). Because "missing from that listing" would then be
wrong evidence, every candidate the listing does not know gets a BOUNDED
direct question first — `aven show <ref> --json`, asked of the same workspaces
the listing covered plus aven's own cwd-inferred workspace, stopping at the
first one that knows the ref — so the direct lookups a pass can make stay
proportional to its candidate count. Three answers: aven says the ticket is
`active`/`todo` → the run is LIVE and is skipped as
`ticket live on direct lookup` (nothing is read from or written to the
gateway for it); aven says none of those universes has such a ticket →
genuinely gone, so it is tombstoned; aven cannot be asked at all (unreachable,
timeout, malformed output, or a ref that only matches by prefix) → the ref is
skipped as `aven lookup inconclusive` with one warning. That last case fails
closed PER REF: one bad shell-out costs one tombstone, not the whole pass, and
the question can only ever cancel a tombstone — it is asked solely for refs
the listing already lacked.

**What a tombstone does.** The run's Pushgateway group is re-pushed with two
changes and nothing else:

- `pi_flow_run_status{…status="halted"|"paused"}` becomes `status="stale"` — a
  new status **value**; metric names and label keys stay frozen, so the alerts
  and the board's value mappings simply stop matching a closed run.
- `pi_flow_run_halt_reason{…}` is dropped — that series only exists for
  halted runs, which is what clears the run out of the needs-attention table.
  Note (PMR-WBC2, verified live 2026-11-24): the homelab gateway MERGES on
  write rather than applying official Pushgateway replace semantics, so a
  series omitted from the body keeps being served — the stored halt_reason
  survives the tombstone until it is overwritten. The table and the alerts
  are unaffected: both gate on `status`, and the status flip to `stale` does
  land (merge overwrites same-identity series in place).

Every other line (cost, tokens, tool calls, durations, gate decisions, human
wait, run start, gate waits) is re-emitted byte-identical, so done-run cost
history on the runs board is untouched. **Nothing is ever deleted** — deleting
the group would erase those cost rows too.

**Where it runs.** Two places, same engine:

- The daemon timer: first pass ~60 s after the daemon starts, then every
  `reconcile.intervalMinutes` (default 360 = 6 h). One summary line lands in
  `<agentDir>/pi-flow/server.log` per pass.
- `/flow-reconcile-push` for an immediate pass, with `--dry-run` to list what
  would be tombstoned without pushing anything.

Both are gated on `PI_FLOW_PUSHGATEWAY_URL`: the daemon timer is never armed
without it, and a REAL `/flow-reconcile-push` run refuses with an error rather
than silently doing nothing. A `--dry-run` is the documented exception — it
still answers "which runs would be retired?" without a gateway, from the run
journals + aven alone, and labels its output `candidates only, groups not
inspected` so nobody mistakes an unverified body for a verified one.

```
DRY RUN — nothing pushed
PI_FLOW_PUSHGATEWAY_URL unset — candidates only, groups not inspected
reconcile pass: scanned=123 candidates=4 stale=4 tombstoned=0 skipped=0 dry-run
  PMR-C0WG (ticket backlog) journal=halted → would tombstone
  PMR-ESPA (ticket done) journal=halted → would tombstone
  PMR-HHS8 (ticket done) journal=halted → would tombstone
  PMR-XXXX (ticket todo) journal=halted → would tombstone
```

With the URL set, the `groups not inspected` header disappears (the groups ARE
read) and the arrow shows what actually happened: `→ tombstoned`,
`→ skipped: already clean`, `→ skipped: pushgateway responded 500 …` — the
same pass above, run against a real gateway, reported
`skipped=1 … → skipped: already clean` for a ref whose stored body held no
liveness series to retire, a fact only the gateway can tell you. A
`ticket missing` status is the ordinary case for a deleted or never-filed
ticket — a missing ticket is stale, once the direct question above agrees.
Refs that stayed live are not listed; the `candidates=N` count covers them.

**Known limitation: only journals name the candidates.** Because candidacy
comes from the run journals, Reconcile can never retire a Pushgateway group
that no journal names any more. A work group exporting
`ref="DP-253",mode="work"` at `status="paused"` whose run re-tracked to a
different journal ref (say `AA-SG9T`) stays exported, and a `paused` alert
rule can still fire on it; likewise a resumed run keeps its `paused` series
until the next terminal transition re-pushes it. Sweeping the gateway dump
instead (retire every halted/paused group whose ticket is closed) is
deliberately out of scope: a stored group carries no identity beyond its
`ref` label, so a sweep means guessing which journal that ref belongs to, and
a sweep that ignores `ref` entirely would reach adhoc runs and other jobs'
groups. If this bites, `/flow-reconcile-push` cannot help either — retire the
series by hand (re-push the group without the liveness line) or let the
`piflow-human-wait-4h` rule page and close the loop.

**Fail-closed on aven errors.** If `aven list` fails, times out, or returns
something unexpected, the pass tombstones **nothing** and logs exactly one
warning. An empty universe counts as such a failure: every workspace
answering zero tickets on a host that holds hundreds is aven breaking in a way
that still parses, and reading it as a real "no tickets" answer would retire
every halted run at once, so it fails closed too. Worst case the alerts keep
firing on stale runs until aven recovers — status quo, visible, honest. A
malformed config likewise falls back to the defaults with a warning instead of
silently switching retires off.

**Only the global file counts for the timer.** The daemon has no session
directory, so the interval comes from `~/.pi/agent/pi-flow/config.json` only —
per-checkout config does not affect it. `/flow-reconcile-push` is the escape
hatch when you need a pass now, or for one checkout.

**Mode is not part of the decision.** The candidate filter asks only whether a
JOURNAL projects a halted/paused loop state; liveness then comes from the aven
ticket map, where a missing entry is stale. In practice `TP-*` personal runs
carry no loop-state journal, so they never become candidates — but a
personal-mode ref that DOES have a halted/paused journal and no aven ticket
tombstones under the same rule. `mode` only picks the group URL suffix
(`/mode/work`), so the tombstone replaces the RIGHT group instead of creating
a duplicate personal one.

On the Grafana side, the `piflow-runs` board maps the new value to a gray
**stale (ticket closed)** and the needs-attention table is gated to
`status=~"running|paused|halted"`, so tombstoned runs drop out of it while
their cost history stays browsable (homelab:
`quadlets/grafana/provisioning/dashboards-piflow/piflow-runs.json`).

### Liveness (running-flow visibility)

Reconcile retires series for runs that are over. Liveness is the other half
of that story: until PMR-8MQH the group was only ever pushed at a TERMINAL loop
transition (`onRunEnd` → done/halt/pause, plus the manual
`/flow-cost <ref> --push`), so a flow that was still running exported
**nothing** — DP-253 ran 14:21–14:37 and the board stayed empty until the
pause autopush landed at 14:37:05. The daemon now periodically re-pushes each
run that is in flight, so `pi_flow_run_status{status="running"}` has a
producer and the board's existing running/needs-attention mappings actually
light up.

**What it pushes.** Not a status-only patch — the FULL group body: cost,
token, tool-call and duration lines plus the run-health lines, rendered
through the SAME path the terminal autopush uses
(`buildPushBody(trackRef, rows, durations, events)`). That is a requirement,
not a style choice: on official Pushgateway semantics a POST replaces the
entire group, so a partial body would drop the cost series the terminal push
owns. (The homelab gateway was verified to MERGE on write instead — PMR-WBC2,
2026-11-24 — but the full-body rule stays: it is correct under either
semantics and does not depend on which build answers.) It also means the two
pushes of one run differ only in the status line. Reading the stored group
back with
`fetchGroupBody` is deliberately NOT used here — that round-trip stays
reserved for the tombstone reconcile above.

**Terminal push stays the last writer.** The pass re-reads and re-gates the
journal immediately before the POST, so a run that went terminal while the
rollup was being computed is skipped rather than stamped over the terminal
body. (A millisecond-scale window remains — the re-gate passes, the session
dies, and the terminal push lands before the POST does. When it hits, the
group sticks at `status="running"`: liveness never revisits the ref (the
journal no longer projects running) and the tombstone reconcile only
covers halted/paused journals, so nothing self-heals until the group is
replaced — a restart under the same ref, or manual cleanup. Rare, accepted,
documented rather than silent.) Refs projecting
anything other than `running` — paused, halted, done, no projection — are
never touched by liveness.

**Where it runs.** The daemon timer only: first pass ~60 s after the daemon
starts, then every `liveness.intervalMinutes` (default 5). A run too fresh to
have any cost rows yet still gets a body pushed (the run-health and duration
lines, no cost lines), so it appears on the board at the first tick instead
of waiting for its first cost-bearing push — for personal runs only: a
work-mode fresh run's trackRef is the shared Jira key, and a zero-cost body
there would erase the previous run's cost series, so such refs wait for
their first cost-bearing pass. One summary line lands in
`<agentDir>/pi-flow/server.log` per pass; a broken journal or a failed POST
costs one warning and a `failed` count, never the pass.

```
liveness pass: scanned=42 pushed=2 skipped=40 failed=0
```

Like reconcile, the timer is gated on `PI_FLOW_PUSHGATEWAY_URL` — unset
means no timer at all (one log line, no journal reads for liveness), and
`liveness.enabled = false` arms nothing. There is no `/flow-liveness-push`
command: the exported `runLivenessPassOnce` is the manual escape hatch for
verification.

**Only the global file counts for the timer.** Same dual-reader rule as
`reconcile`: the session side reads the `liveness` block through `config.ts`
(typed, throws on a malformed value), the daemon reads the raw global JSON
tolerantly and falls back to the defaults with a warning. The daemon has no
session directory, so a per-checkout `liveness` override does not affect it —
only `~/.pi/agent/pi-flow/config.json` does.

**Known limitation: a crashed run stays `running`.** Liveness only stamps
what the journal projects, and a session that died mid-run never wrote a
terminal loop state, so its series keeps refreshing (or, if the daemon died
with it, simply stays) as `running` until either a terminal push happens for
that ref or its group is cleaned up. Detecting crashed-running flows is out
of scope for this feature — reconcile tombstones halted/paused only.

### Aven ref resolution

Aven resolves refs against the workspace inferred from the current
directory via project path mappings. On a checkout without such a mapping,
pi-flow falls back automatically: `aven show <ref> --json` first, then an
exact-ref `aven search` in the active workspace, then a sweep of every
workspace from `aven workspace list`; the resolved workspace is pinned for
all later calls on that ref. If nothing matches, the failure names the
fix. Two one-time remedies:

```sh
# map this checkout to its aven project (recommended)
aven project path add pi-my-rifle-ext /path/to/this/checkout

# or pin the workspace explicitly in pi-flow config.json (see avenWorkspace)
```
