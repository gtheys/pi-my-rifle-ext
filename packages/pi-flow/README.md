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
| `/herdr-sync` | Links this repo as a Herdr plugin (idempotent, explicit-only). |
| `/flow-view <ref> [placement]` | Opens/focuses a Herdr pane rendering the run-state journal for a ref. |
| `/flow-diagram <ref> [run]` | Renders the per-ticket flow timeline as a self-contained HTML sequence diagram (one lane per subagent + orchestrator, phase markers, tool arrows with dashed returns, per-lane token totals). Writes to `pi-flow/diagrams/<ref>.run<k>.<stamp>.html` and best-effort opens it; the file path is always the deliverable. |
| `/flow <ref>` | Extension-owned loop: injects one phase prompt at a time (same builders the phase commands use, gates intact), then advances when the phase turn settles and its completion label has landed; missing label → halt note + stop. Resume = first phase whose completion label is missing. Work mode + Jira ID: find-or-create the local epic (`jira-ref` metadata, dep-linked to the synced ticket) and run on the epic ref. |
| `/flow` (bare) | Same gate picker as `/flow <ref>`, plus an extra "Start a flow on a ready ticket…" row; picking it opens the cwd-project's ready tickets from `aven list --ready` and Enter starts the flow exactly like `/flow <ref>`. Zero ready gates skips the menu and goes straight to the ticket list. Esc cancels silently. |

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
| `resolve_spec_path` / `resolve_feature_path` | Canonical spec/plan.md path resolution for a Jira ticket or personal feature (absorbed from pi-planning). |
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
| `landTestCommand` | `string[]` | detected, else `["bun","run","test"]` | Argv of the test command `flow_land` runs itself before authorizing a landing — the gate never trusts a claimed-green suite. When unset, the command is detected from repo signals in a fixed order: `bun.lock`/`bunfig.toml` → `bun run test`, `Cargo.toml` → `cargo test`, `package-lock.json` → `npm test`, `pnpm-lock.yaml` → `pnpm test`. The summary of every run names the command and its source (config / detection / default) |
| `telemetry.enabled` | `boolean` | `false` | Master switch for OTLP telemetry. `false` or a missing `telemetry` block = the session probe subscribes to nothing, allocates nothing, makes no network calls |
| `telemetry.otlpEndpoint` | `string` | unset (required with `telemetry`) | OTLP/HTTP base URL (e.g. `https://host:4478`); spans POST to `<endpoint>/v1/traces` |
| `telemetry.headers` | `record<string, string>` | `{}` | Static extra headers for OTLP export. Secrets belong in env (`PI_FLOW_OTLP_TOKEN`), not config |
| `telemetry.captureContent` | `"off" \| "text" \| "tools" \| "all"` | `"off"` | Content layers added to spans (cumulative): `off` metadata only, `text` assistant text, `tools` + tool calls and tool input/output, `all` + model reasoning. See [Capturing content](#capturing-content-in-spans) |
| `telemetry.jiraBaseUrl` | `string` | unset | Base URL for Jira issue links, e.g. `https://example.atlassian.net/browse/`. Work-mode spans then carry `flow.url` = base + Jira key, so dashboards can link tickets to Jira. Unset = no links |
| `telemetry.maxContentChars` | `integer` (100–100000) | `2000` | Max characters per captured content attribute; longer values end with `…[truncated N chars]`. Tempo drops anything past its `max_attribute_bytes` (default 2048) silently, so raise both together |
| `runServer.enabled` | `boolean` | `true` | Kill switch for the durable run server (PMR-XTQQ). `false` = never spawn the daemon; journal writers permanently use the full in-session path (runs don't survive a session exit) |

```json
{
  "$schema": "https://raw.githubusercontent.com/gtheys/pi-my-rifle-ext/main/packages/pi-flow/config.schema.json",
  "workRoots": [
    "/home/geert/Code/salaryhero"
  ],
  "avenWorkspace": "personal",
  "landTestCommand": ["bun", "run", "test"],
  "runServer": {
    "enabled": true
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

On-disk layout under `<agentDir>/pi-flow/`: `server.pid`, `server.log`,
`pending/`, `runs/`.

- **Disable**: set `"runServer": { "enabled": false }` — the daemon is never
  spawned and writers permanently use the in-session full path.
- **Degrade**: daemon absent or dead = today's pre-PMR-XTQQ behavior. The
  journal stays the authority; the projection and pending records are
  rebuildable caches. Known limits: the projection lags ≤~1s while the daemon
  owns it (only `/flow-view` reads it — receipts and gates read the journal
  and aven directly), and a brand-new session in the same worktree without a
  restored binding is not re-presented (binding-scoped only).

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

### Cost rollup push (`/flow-cost --push`)

The offline `/flow-cost <ref>` table needs nothing but the local journal. The optional `--push` export to a Prometheus Pushgateway is env-gated:

```sh
export PI_FLOW_PUSHGATEWAY_URL=https://pushgateway.example.com:4479
export PI_FLOW_PUSHGATEWAY_TOKEN=<token>
```

Push failures print a warning and never fail the command; rerun `/flow-cost <ref> --push` any time to re-export or backfill.

**Automatic push**: with `PI_FLOW_PUSHGATEWAY_URL` set, the same rollup is pushed for you whenever a `/flow` run ends — completed, halted, or paused for spec approval. A one-line notice confirms it (`flow-cost <ref>: cost metrics pushed to the pushgateway.`); a failure shows a warning with the retry command. With the URL unset nothing happens. Pushing is idempotent (the ref's metric group is replaced), so a resumed flow just refreshes the numbers. The rollup covers spawned workers and, for runs started after the `main-session` journal event existed, the main session split across plan / implement / validate. It also includes a per-phase **step outputs** section summarizing `flow_submit` submissions (advisory evidence, never blocking).

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
