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
| `/feedback <ref>` | Work: `/sonarqube` + `/pr-quality` triage (mechanical fixes committed, behavioral findings become new tasks). Personal: not a phase — `/validate` writes the outcome summary note and sets `done` after the push. |
| `/spec-review [--workspace <name>]` | Lists every spec at `plan-state=review` (aven metadata query), batch-picks them, opens each plan.md in a herdr nvim pane, and injects a review prompt: the session fixes spec issues in place; transitions to approved only via explicit "approve <REF>" (pins `plan` label, plan-state=approved, status todo). |
| `/spec-publish <ref>` | Launches a worker subagent that publishes the approved plan.md to the ticket's notes repo (plan-state gate). |
| `/review-spec <path>` | Opens a plan/spec in a herdr nvim `spec-review` pane (absorbed from pi-planning). |
| `/review [target]` | Code review via a fresh-context `reviewer` subagent — PR / branch / commit / uncommitted / folder / custom; optional ocr second opinion; emits a machine-readable `blockers_count: <N>` verdict the `/validate` review gate consumes (absorbed from pi-review). |
| `/sonarqube [pr]` | SonarCloud coverage gaps + quality issues for a PR, analysis-only (absorbed from pi-review). Requires `SONARQUBE_TOKEN`. |
| `/pr-quality [pr]` | Unresolved GitHub review threads + SonarCloud issues in one triage pass (absorbed from pi-review). |
| `/pr-watch` | Background-polls PR checks; auto-triggers `/pr-quality` when they complete (absorbed from pi-review). |
| `/flow-cost <ref> [--push]` | Per-ticket cost rollup: replays the run journal, attributes each spawned session's token usage and tool calls to agent/subtask, prints the table. `--push` additionally exports the rollup as Prometheus metrics to a Pushgateway (env-gated, see below); failures warn and never fail the command. Reruns any time — it replays the journal, so it doubles as the backfill path. |
| `/herdr-sync` | Links this repo as a Herdr plugin (idempotent, explicit-only). |
| `/flow-view <ref> [placement]` | Opens/focuses a Herdr pane rendering the run-state journal for a ref. |
| `/flow <ref>` | Extension-owned loop: injects one phase prompt at a time (same builders the phase commands use, gates intact), then advances when the phase turn settles and its completion label has landed; missing label → halt note + stop. Resume = first phase whose completion label is missing. Work mode + Jira ID: find-or-create the local epic (`jira-ref` metadata, dep-linked to the synced ticket) and run on the epic ref. |

Lifecycle labels on the aven ticket are the run state:
`planned → active → review-passed → done`; type labels
`bug` / `oneshot` / `plan` route `/implement`.

## Tools

Agent-callable tools registered by pi-flow:

| Tool | What it does |
| --- | --- |
| `flow_phase_complete` | The ONLY way to write lifecycle labels — re-checks the phase gates before exec'ing aven; direct `aven edit --label` mutations are blocked at the bash tool_call boundary. |
| `flow_land` | Gates landing behind the `review-passed` label (+ optional `blockers_count` artifact); authorizes `git push` / `gh pr create` for the ref, which are otherwise blocked while a flow is active. |
| `flow_run_attempt` | Owns the implement-phase retry budget: 3 total attempts, the 3rd failure escalates and further attempts are refused. |
| `spec_approve` | Only path from plan-state `review` → `approved` (pins the `plan` label, moves the ticket to todo). |
| `resolve_spec_path` / `resolve_feature_path` | Canonical spec/plan.md path resolution for a Jira ticket or personal feature (absorbed from pi-planning). |
| `open_in_pane` | Opens a file with nvim in a herdr pane for review (absorbed from pi-planning). Call it only after the file write returned; it polls ~1s for the file. |
| `jira_create_branch` | Derives and creates a git branch from a Jira issue (absorbed from pi-planning). Requires `acli` + `git-town`. |
| `review` | Starts a code review of uncommitted changes / branch / commit / PR / folder / custom instructions (absorbed from pi-review). |
| `sonarqube` | Fetches SonarCloud coverage gaps + quality issues for a PR as an actionable report (absorbed from pi-review). |
| `pr_quality` | Gathers unresolved PR review threads + SonarCloud issues into a triage prompt (absorbed from pi-review). |
| `worktree` | Creates, lists, and removes Herdr-managed git worktree workspaces (absorbed from pi-worktree). |

## Configuration

Global config lives at `~/.pi/agent/pi-flow/config.json` (schema:
[`config.schema.json`](config.schema.json)). A project-local
`<repo>/.pi/pi-flow/config.json` is merged on top (project wins per key) —
handy for enabling telemetry per checkout instead of machine-wide.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workRoots` | `string[]` | `[]` | Absolute path prefixes; a git toplevel under any prefix is `work` mode |
| `avenWorkspace` | `string` | unset | Aven workspace name or key forced on every aven call pi-flow makes (skips cwd inference and the search fallback) |
| `telemetry.enabled` | `boolean` | `false` | Master switch for OTLP telemetry. `false` or a missing `telemetry` block = the session probe subscribes to nothing, allocates nothing, makes no network calls |
| `telemetry.otlpEndpoint` | `string` | unset (required with `telemetry`) | OTLP/HTTP base URL (e.g. `https://host:4478`); spans POST to `<endpoint>/v1/traces` |
| `telemetry.headers` | `record<string, string>` | `{}` | Static extra headers for OTLP export. Secrets belong in env (`PI_FLOW_OTLP_TOKEN`), not config |
| `telemetry.captureContent` | `"off" \| "text" \| "tools" \| "all"` | `"off"` | Content layers added to spans (cumulative): `off` metadata only, `text` assistant text, `tools` + tool calls and tool input/output, `all` + model reasoning. See [Capturing content](#capturing-content-in-spans) |
| `telemetry.maxContentChars` | `integer` (100–100000) | `2000` | Max characters per captured content attribute; longer values end with `…[truncated N chars]`. Tempo drops anything past its `max_attribute_bytes` (default 2048) silently, so raise both together |

```json
{
  "$schema": "https://raw.githubusercontent.com/gtheys/pi-my-rifle-ext/main/packages/pi-flow/config.schema.json",
  "workRoots": [
    "/home/geert/Code/salaryhero"
  ],
  "avenWorkspace": "personal"
}
```

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

**Automatic push**: with `PI_FLOW_PUSHGATEWAY_URL` set, the same rollup is pushed for you whenever a `/flow` run ends — completed, halted, or paused for spec approval. A one-line notice confirms it (`flow-cost <ref>: cost metrics pushed to the pushgateway.`); a failure shows a warning with the retry command. With the URL unset nothing happens. Pushing is idempotent (the ref's metric group is replaced), so a resumed flow just refreshes the numbers. The rollup covers spawned workers and, for runs started after the `main-session` journal event existed, the main session split across plan / implement / validate.

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
