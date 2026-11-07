# pi-flow observability — how it works (LLM handoff / context doc)

Feed this file to an LLM before working on pi-flow telemetry or the Grafana dashboard. It states what exists,
where it lives, how data flows, and the traps already hit. Last verified against the code on 2026-11-07
(commit `81f31e8`+). For the chronological incident log see
[`pi-flow-observability-troubleshooting.md`](pi-flow-observability-troubleshooting.md).

## 1. What this is

pi-flow (`packages/pi-flow`) drives the PIV flow (plan → implement → validate) for an aven ticket. Two independent
signal paths describe a run:

| Path | Signal | Produced by | Goes to | Used by |
| --- | --- | --- | --- | --- |
| **Traces** | OTLP/HTTP JSON spans | `telemetry/` (live, every pi process) | Caddy `:4478` → Tempo | trace table + trace view |
| **Metrics** | Prometheus text, `pi_flow_*` | cost rollup from run journal + session files: pushed **automatically when a run ends** (`flow/cost-autopush.ts`), or by hand with `/flow-cost <ref> --push` | Caddy `:4479` → Pushgateway → Prometheus | 3 timeseries panels |

Traces are live and per-call. Metrics are an after-the-fact rollup: the loop pushes it when a run ends (done, halt, pause;
`onRunEnd` → `createCostAutoPush`, env-gated by `PI_FLOW_PUSHGATEWAY_URL`, idempotent, ~1.5 s settle so the journal's
async appends land first). `/flow-cost <ref> --push` remains the manual retry/backfill. Failure = a warning with that command.

**Cost sources in the rollup** (`flow/cost.ts`): (a) spawned WORKER sessions (review, deviation check, implementers…),
attributed via the spawn notes in the run journal; (b) the MAIN pi session, attributed to plan/implement/validate by
splitting its entries across the journal's phase windows (`phaseWindows`, `buildMainRows`). (b) needs the journal's
`main-session` event (written by the loop at every phase start, `getSessionFile` dep wired in `index.ts`) — so
**runs started before 2026-11-07 evening have no main-session cost** (only workers, i.e. validate) and cannot be
backfilled; new runs are pushed automatically; `/flow-cost <ref> --push` re-exports. Main rows are pushed as `agent="main"`. Unreadable
session file = one coverage-gap row, never a zero. Windows: a phase runs from its phase-start to the next phase-start;
the last one ends at its phase-complete; entries outside every window (chat before/after the flow) are ignored.

## 2. Infrastructure (chicken homelab, podman quadlets)

Source of truth: `~/Code/personal/homelab/quadlets/*` (git repo). Deployed copy: `/opt/homelab` (root-owned; needs
`sudo cp` + `systemctl restart <svc>`). Everything is reached over tailscale: `https://chicken.tail4250d0.ts.net:<port>`.

| Component | Where | Notes |
| --- | --- | --- |
| Caddy | `quadlets/caddy/Caddyfile`, `caddy.container` | TLS + authelia forward-auth. **Client ports are the host ports `44xx`; the `84xx` ports are container-internal and unreachable** (publishing is `PublishPort=100.108.226.64:44xx:84xx`). |
| `:4478` | Caddy → `tempo:4318` | OTLP/HTTP ingest, bearer auth (`PI_FLOW_OTLP_TOKEN`). No authelia. |
| `:4479` | Caddy → `pushgateway:9091` | metrics push, bearer auth (`PI_FLOW_PUSHGATEWAY_TOKEN`). |
| `:4443` | Caddy → Grafana (`/grafana/`), Prometheus (`/prometheus/`), authelia… | humans, authelia SSO. |
| Tempo | `quadlets/tempo/tempo.yaml`, image `grafana/tempo:2.10.10` | OTLP grpc 4317 + http 4318, local storage, 14d retention (`block_retention: 336h`), `MemoryMax=1G`. No published port (Grafana reads `http://tempo:3200` on `homelab.network`). **`ingester.trace_idle_period: 3m`** (see §7). |
| Pushgateway → Prometheus | `quadlets/pushgateway`, `quadlets/prometheus/prometheus.yml` | scrape job `pushgateway`, `honor_labels: true` so pushed `ref/phase/agent` labels survive; series carry `job="pi-flow"`. |
| Grafana | `quadlets/grafana`, datasources provisioned in `provisioning/datasources/` | Prometheus uid **`PBFA97CFB590B2093`** (must not change), Tempo uid **`tempo`**. |
| grafana-image-renderer | `quadlets/grafana-image-renderer` | enables `gcx dashboards snapshot` PNGs. Needs Grafana `GF_RENDERING_CALLBACK_URL=http://grafana:3000/grafana/` (else renders return the login page). |

The k8s `tempo` in the `salaryhero-local` minikube namespace is an unrelated SalaryHero app Tempo (gRPC only). Ignore it.

## 3. Client configuration (the machine running pi)

`~/.pi/agent/pi-flow/config.json` (global; `<repo>/.pi/pi-flow/config.json` overrides per key). Schema:
`packages/pi-flow/config.schema.json`, TypeBox in `packages/pi-flow/config.ts`.

```json
{ "telemetry": { "enabled": true,
                 "otlpEndpoint": "https://chicken.tail4250d0.ts.net:4478",
                 "captureContent": "off", "maxContentChars": 2000 } }
```

Env (never in config): `PI_FLOW_OTLP_TOKEN` (traces bearer), `PI_FLOW_PUSHGATEWAY_URL`
(`https://chicken.tail4250d0.ts.net:4479`), `PI_FLOW_PUSHGATEWAY_TOKEN`. Config is read once per pi session —
**restart pi after changing it or after pulling new telemetry code**.

Content capture (`captureContent`, cumulative): `off` metadata only (default) → `text` adds `gen_ai.completion` →
`tools` adds `gen_ai.tool_calls`, `tool.input`, `tool.output` → `all` adds `gen_ai.reasoning`. Each value truncated
to `maxContentChars` (default 2000). **Tempo silently truncates any attribute at 2048 bytes** (`max_attribute_bytes`),
so raising `maxContentChars` needs Tempo raised too. No redaction exists — content may hold secrets. User docs:
`packages/pi-flow/README.md` ("Capturing content in spans").

## 4. Code map (`packages/pi-flow`)

| File | Role |
| --- | --- |
| `flow/attribution.ts` | Stamps/clears `PI_FLOW_REF`, `PI_FLOW_PHASE`, `PI_FLOW_TRACEPARENT` in `process.env` (`stampFlowStart/Phase`, `clearFlowEnv`). Traceparent = fresh W3C root per `/flow` run; **its span id is the reserved flow-root span id**. |
| `flow/loop.ts` | The flow state machine. Calls `onFlowEnvChange` after every stamp/re-stamp/clear (start, phase change, halt, pause, done, supersede). |
| `telemetry/index.ts` | The telemetry extension (`registerTelemetry`): subscribes to `tool_execution_start/end`, `turn_end`, `session_shutdown`; builds spans; buffers; flushes. Returns `{ syncFlowEnv }`. |
| `telemetry/attributes.ts` | Env → attributes (`flow.ref`, `phase`, `agent.name`, `subtask`, `parent.session`), traceparent parsing, id generation, GenAI attributes. |
| `telemetry/content.ts` | Opt-in content extraction + truncation (levels above). |
| `telemetry/exporter.ts` | Hand-rolled OTLP/HTTP JSON POST to `<endpoint>/v1/traces`, 2.5 s timeout, fire-and-forget. |
| `flow/cost.ts`, `flow/cost-command.ts` | `/flow-cost` rollup + Prometheus text body + push to `<url>/metrics/job/pi-flow/ref/<ref>`. |
| `index.ts` | Wiring: loop ↔ telemetry (`syncTelemetryFlowEnv` late-bound), config → `TelemetrySettings`. |
| `packages/pi-interactive-subagents/.../flow-env.ts` | `applyFlowEnv`: copies the `PI_FLOW_*` stamp + `PI_SUBAGENT_NAME` into every spawned worker's env (scouts, reviewers, deviation checkers, implementers — all subagents). |
| tests | `test/telemetry.test.ts`, `test/telemetry-content.test.ts`, `test/loop-attribution.test.ts`. Run `bun test packages/pi-flow`; also `bunx @biomejs/biome check packages/pi-flow`, `bunx tsc -p tsconfig.json --noEmit`. |

Repo rules: no ternaries in TS, explicit `.ts` import suffixes, explicit `files` allowlist in
`packages/pi-flow/package.json` (a new module must be added there or the published package breaks), never edit
existing tests without asking, implement in a git worktree (`worktree` tool), `AIDEV-NOTE` comments stay.

## 5. Trace shape (what spans exist)

```
flow <ref>                       flow.span=root     main process; zero-length marker; spanId = traceparent span id
├─ <ref> - plan                  flow.span=phase    main process; REAL start/end; sent when the phase ends
│  ├─ tool … / gen …             spans of the main session in that phase
│  └─ <ref> - <role>             flow.span=session  one per worker; zero-length marker; role = agent.name before ':' lowercased
│     └─ tool … / gen …          that worker's spans
├─ <ref> - implement             (same shape)
└─ <ref> - validate              (contains `review`, `deviation check` worker sessions)
```

Rules that make it work (each cost an incident — do not "simplify" them away):

1. **Root span**: the loop reserves the root span id in `PI_FLOW_TRACEPARENT` but nothing else exports it; the MAIN
   process (no `PI_SUBAGENT_NAME`) emits `flow <ref>` once per flow trace, else Grafana shows `<root span not yet received>`.
2. **Env is re-read on every span** (`ensureTrace`). The loop stamps env AFTER `session_start`; a one-shot read left
   main-session spans without `flow.ref`.
3. **Phase span id is deterministic**: first 16 hex of `sha256(traceId:phase)` (`phaseSpanId`). Workers recompute it from
   their own env to nest their session span under the main process's phase span — no extra env var crosses packages.
4. **Phase spans close on any flow-env transition** (`syncFlowEnv`) or on `flow_phase_complete` (close + flush).
   Validate is the last phase — without this it stayed open/unsent and review/deviation sessions hung off a missing parent.
5. **Never re-export a span id with a later end time**: Tempo keeps BOTH copies until compaction. Hence root/session
   spans are zero-length markers and a phase span is sent once, at close (`exported` flag).
6. A closed phase stays the parent of trailing spans; each phase span stores its own root parent id (closing after a
   trace switch must not re-parent it).
7. Spans buffer and flush at 16 spans, at `session_shutdown`, on phase close and on `syncFlowEnv` growth.
8. Plain interactive sessions (no flow env) emit flat spans with no `flow.ref` and never appear in the dashboard.

Known gap: a main process hard-killed mid-phase never sends that phase span (children hang off a missing parent;
the flow root still names the trace).

### 5b. Which agents are tracked (coverage)

| Agent | Traces | Cost (`/flow-cost`, auto-pushed) |
| --- | --- | --- |
| Orchestrator (main pi session running `/flow`) | yes: `<ref> - <phase>` spans + its tool/gen spans | yes, role `orchestrator`: session split across phases by journal timestamps (needs the `main-session` journal event, runs from 2026-11-07 evening) |
| Oneshot work done in the orchestrator itself | yes (same spans) | yes (orchestrator cost) |
| Subagents spawned WHILE a flow is active (plan agent, scouts, workers, reviewers, deviation checks) | yes: `<ref> - <role>` session span + their tool/gen spans (env copied by `applyFlowEnv`) | yes if journaled: the spawn note is written by the main loop |
| Nested spawns (a worker spawning scouts) | yes (env is forwarded again) | yes: the worker journals its spawns via inherited `PI_FLOW_REF` (`spawnJournalTarget`, `recordRunEventJournalOnly`: journal only, never the projection) |
| Agents spawned OUTSIDE a flow (before `/flow` starts, ad hoc) | NO flow attrs: flat spans, random trace, not in the dashboard | NO (no spawn note) — open design question: when does a flow "begin"? |

Evidence at the time of writing: every journaled spawn so far was a `Review` or `Deviation check` (9 each); plan
agents / scouts / implementers had not yet been exercised under `/flow`, so those paths are unit-tested but not
yet observed on a real run.

**Role** (`flow/agent-role.ts`, `agentRole`): agent type (`PI_SUBAGENT_AGENT` / `AssignmentRecord.agent`) first, else
the name before the first colon, else `worker`; lowercased, max 40 chars. Used for trace session-span names and for
the metric `pi_flow_run_role_info{ref,session,role} 1` (one per session, emitted by `buildPushBody`; the existing
cost/token/tool-call label sets are unchanged). Span attribute `agent.type` carries the type.

## 6. The dashboard

`https://chicken.tail4250d0.ts.net:4443/grafana/d/piflow-health/pi-flow-health` — uid `piflow-health`, a Grafana
**v2 dashboard resource** (`dashboard.grafana.app/v2`), 7 d default range, 5 m refresh, variable `ref`
(`label_values(pi_flow_run_cost_usd, ref)`, multi, include-All with `allValue=".*"`).
**It is NOT provisioned from git** — it lives only in Grafana's DB. A backup export is committed at
[`docs/pi-flow-health.dashboard.json`](pi-flow-health.dashboard.json) (restore with `gcx dashboards update piflow-health -f …`;
the `metadata.resourceVersion` inside must be current — re-`get` and edit rather than pushing the stale file).

| Panel | Type | Datasource | Query | Shows |
| --- | --- | --- | --- | --- |
| Tool error rate per tool per phase | timeseries | Prometheus | `sum by (tool, phase)(pi_flow_tool_calls_total{status="error",ref=~"$ref"}) / sum by (tool, phase)(pi_flow_tool_calls_total{ref=~"$ref"})` | empty when no tool call has `status="error"` (expected) |
| Tool failures by tool | timeseries | Prometheus | `sum by (tool, status)(pi_flow_tool_calls_total{ref=~"$ref", status="error"})` | same |
| Run duration by phase | timeseries | Prometheus | `max by (phase)(pi_flow_run_duration_seconds{ref=~"$ref"})` | needs `/flow-cost <ref> --push` |
| Traces by flow.ref | **table** | Tempo | `{ .flow.ref =~ "$ref" && (.flow.span = "phase" \|\| .flow.span = "root") } \| select(name, .phase)`, `tableType: traces`, `spss: 20`, `limit: 50` | one row per trace; expanding shows root + one row per phase with duration; click the trace/span id to open the tree |

Metrics (`/flow-cost --push`, labels in `flow/cost.ts`): `pi_flow_run_cost_usd{ref,phase,agent,subtask,session}`,
`pi_flow_tokens_total{…,kind=input|output|cacheRead|cacheWrite}`, `pi_flow_tool_calls_total{…,tool,status}`,
`pi_flow_run_duration_seconds{ref,phase}`. Reruns are safe (replays the journal).

Dashboard gotchas learned:
- The trace panel must be a **table**. The `traces` visualization renders ONE trace by id and shows "No data found
  in response" for a search result.
- `=~` not `=` for `$ref` (All expands to `.*`).
- Tempo returns max 3 spans per trace unless `spss` is set; without `select(name, …)` the rows are unlabeled.
- Old traces (before 2026-11-07) have no `flow.span` attribute → they no longer match this panel's filter.
- Variable `ref` only lists refs that have pushed metrics, so a ref with traces but no `/flow-cost --push` is only
  reachable via "All".
- `gcx dashboards snapshot` only renders collapsed rows (cannot expand a trace row); verify expanded rows in a browser.

### 6a. Split cost dashboards (2026-11-07): `piflow-orchestrator` and `piflow-subagents`

`piflow-cost` was split because "cost" mixed two different things: the **orchestrator** (the main pi session that runs
`/flow`, own LLM calls only) and the **subagents** (every worker / reviewer / deviation check / scout, each a separate session).
Old combined dashboard is kept but retitled "superseded" (backup `docs/pi-flow-cost.dashboard.json`); a ticket's combined
total (orchestrator + subagents) is a column on BOTH new dashboards' ticket tables.
Backups: [`pi-flow-orchestrator.dashboard.json`](pi-flow-orchestrator.dashboard.json),
[`pi-flow-subagents.dashboard.json`](pi-flow-subagents.dashboard.json). Both are DB-only, built with the same principles as 6b
(instant queries, `ref` variable, "in range" = `push_time_seconds` within `$__range_s`).

* **Orchestrator selector:** `agent="main"` (rows pushed by `buildMainRows`; role `orchestrator`). Subagents: `agent!="main"`.
* `piflow-orchestrator`: tiles (orchestrator spend, tickets, avg/median per ticket) · rolling 24h · per-ticket stacked by
  phase (plan/implement/validate) · ticket table (Orchestrator gauge, Plan, Implement, Validate, Subagents, Ticket total
  (orchestrator + subagents), Duration, Last pushed) · orchestrator cache hit ratio per ticket.
* `piflow-subagents`: tiles (subagent spend, sessions, avg/median per session) · rolling 24h · per-ticket stacked by ROLE ·
  per-role highest/avg/median · top-10 sessions · ticket table (Subagents gauge, Sessions, Most expensive session,
  Orchestrator, Ticket total) · cache hit ratio per role. Role comes from `pi_flow_run_role_info` joined by (ref, session) with the legacy
  name-prefix fallback and `Review`/`Deviation check` lower-casing (same as 6b).
* First insight it surfaced: deviation checks run a 29% cache hit ratio vs 75% for reviews (cost lever).
* Old tickets (before main-session tracking) show "–" for orchestrator columns but their subagent cost and combined total.
* Table header "Ticket total (orchestrator + subagents)" has a 300 px column width override (it was truncated).

### 6b. (superseded by 6a) Cost dashboard (`piflow-cost`) and range dashboard (`piflow-range`)

Three pi-flow dashboards exist in the same Grafana folder (`ag3jjknk85xc0b`): `piflow-health` (above), **`piflow-cost`**
("pi-flow cost", backup: [`docs/pi-flow-cost.dashboard.json`](pi-flow-cost.dashboard.json)) and `piflow-range`
("pi-flow range: cost vs score", from the M6 ticket; not documented here — `gcx dashboards get piflow-range`).
All are DB-only, not provisioned from git.

`piflow-cost` layout (all Prometheus, variable `ref`, redesigned 2026-11-07 — the original panels were time series of
values that never change after the push, so every ticket was a dot at the right edge and the legends listed one row per
agent name per ticket). Principle: **cost is a per-run total, not a time series → instant queries, tables, bars**.
Instant queries also make deleted/stale test refs disappear. "In range" = tickets whose `push_time_seconds{job="pi-flow"}`
falls inside the selected time range (`and on (ref) (push_time_seconds >= time() - $__range_s)`).

| Row | Panel | What it answers |
| --- | --- | --- |
| 1 | stat tiles `panel-6..9`: Total spend, Tickets, Average per ticket, Median per ticket | how much, how many, typical ticket (median resists one expensive outlier) |
| 2 | `panel-10` Spend in the last 24h (rolling) | trend: at each hourly step, cost of tickets pushed in the preceding 24h. Rolling because daily buckets can't show "today" (a bar is evaluated at its window end and the series don't exist before their push) |
| 2 | `panel-2` cost per flow stacked by phase | where each ticket's money went |
| 3 | `panel-1` Tickets table | per ticket: Total (gauge), Plan / Implement / Validate, Orchestrator, Sessions, Duration, Last pushed; joined by `ref`, sorted newest first. Plan/Implement/Orchestrator columns only exist once a ticket has main-session cost (new runs) — absent otherwise |
| 4 | `panel-3` Most expensive sessions (top 10) | outlier sessions: Ticket, Role, Subtask, Cost, Tokens (`label_join` key to join cost+tokens; role via `label_replace`) |
| 4 | `panel-5` cost per agent role (below) | which role is expensive in general |
| 5 | `panel-4` Cache hit ratio per ticket | `cacheRead / (input + cacheRead + cacheWrite)`; thresholds red < 50%, orange < 80%, green ≥ 80% — low ratio on a costly ticket is the first place to look |

`piflow-health` `panel-3` "Run duration per ticket, stacked by phase": instant `sum by (ref, phase)(pi_flow_run_duration_seconds)`
+ `groupingToMatrix` stacked barchart (durations are wall-clock phase-start→complete and INCLUDE waiting for the human, so a
long validate bar is usually review/approval wait).

`piflow-health` `panel-5` "Tool failures": Tempo table (`tableType: spans`) of
`{ .tool.error = "true" && .flow.ref =~ "$ref" } | select(.flow.ref, .phase, .agent.name, .gen_ai.tool.name, .tool.output)`,
one row per failed tool span; the **Span ID is the link** (opens the trace with that span). Columns: Start time, Ticket,
Phase, Tool, Agent, Duration, Span ID, and Tool output (only when `captureContent` is `tools`/`all`). Failures from plain
interactive sessions (no `flow.ref`) are deliberately not listed — drop the `.flow.ref` clause to include them (4 existed
when this was built). Spans mark failures twice: attribute `tool.error="true"` and OTLP status = ERROR; the same
limits as any Tempo search apply (a trace split by `trace_idle_period` can hide matching spans for ~3 min).
The old error-rate / failures-by-tool panels (`panel-1`, `panel-2`) read the pushed `pi_flow_tool_calls_total{status="error"}`
metric, so they are empty until `/flow-cost` has pushed a ticket that had a failure.

Dashboard-editing gotcha: `gcx dashboards update` needs the CURRENT `metadata.resourceVersion`; a stale file is rejected
(no output). Always `gcx dashboards get` immediately before editing and check for `"action":"updated"`.

Stacked-by-phase panel (`panel-2`, replaced the old "Cost by phase" time-bar which plotted `sum by (phase)` over time and
therefore showed one bar per 15 minutes): query `sum by (ref, phase) (pi_flow_run_cost_usd{ref=~"$ref"})` as an
**instant table**, transformation `groupingToMatrix` (rows = `ref`, columns = `phase`, value = `Value`, empty = zero),
`barchart` with `stacking: normal`, tooltip `multi` (hover a bar → every phase's cost), unit `currencyUSD`, fixed colours per
phase via `byName` overrides (plan blue, implement green, validate orange, feedback purple). One bar = one flow ref
(metrics are keyed by ref, so two runs of one ref add up; the trace root is per run). Verified with synthetic refs
pushed via the Pushgateway then deleted (`DELETE <url>/metrics/job/pi-flow/ref/<ref>`).

Cost-per-agent-role panel (`panel-5`, replaced the old bargauge "Total cost by agent", which had one row per agent NAME and
therefore one row per ticket because worker names embed the ref, e.g. `Deviation check: TP-5K94`): three instant table
queries over `label_replace(sum by (ref, agent, session)(pi_flow_run_cost_usd{ref=~"$ref"}), "role", "$1", "agent", "^([^:]*).*")`
— `max by (role)`, `avg by (role)`, `quantile by (role)(0.5, …)` — joined on `role` (`joinByField`), renamed
Highest/Average/Median (`organize`), filtered, sorted by Highest; horizontal grouped `barchart` (orange/blue/green), tooltip `multi`.
Role = the `role` from `pi_flow_run_role_info` (agent type, else name prefix; orchestrator rows carry `orchestrator`), joined with
`* on (ref, session) group_left (role)`; runs pushed BEFORE role tracking fall back to the old name-prefix `label_replace`
(via `unless on (ref, session) pi_flow_run_role_info`) and old `main` rows are relabelled **`orchestrator`** — the main pi session that runs the flow, one session per
flow run (verified with synthetic refs: highest/avg/median matched). Its bars dwarf the workers' on a shared axis (it does
plan + implement + validate itself); a session = one worker or one
main-session run (the per-phase main rows of one session are summed by `sum by (… session)` first). Grafana cannot draw
per-row markers on one bar, so avg/median are sibling bars, not ticks. Checked against raw series: 9 sessions per role,
values identical to the chart.

## 7. Tempo behaviours that bite (measured on the homelab Tempo 2.10)

| Behaviour | Evidence | Mitigation |
| --- | --- | --- |
| Attribute values truncated at **2048 bytes** silently | 10 000-char value read back as 2048 | `maxContentChars` default 2000; raise Tempo `max_attribute_bytes` together; metric `tempo_distributor_attributes_truncated_total` |
| TraceQL **search** returns only ONE segment of a trace whose spans arrived > `trace_idle_period` apart; open-by-id is always complete | synthetic: 4 spans 4 s apart → search 4/4; 30 s apart → 1/4 | `ingester.trace_idle_period: 3m` (deployed). Consequence: a finished trace is fully searchable ~3 min after its last span; silences > 3 min inside a trace can still split it |
| Duplicate span ids both returned until compaction | re-sent probe span returned twice | never update a span in place |
| Ingest needs the bearer; 401 without, 200 with | curl | `PI_FLOW_OTLP_TOKEN` in the shell that starts pi |

## 8. Operating it (copy-paste)

```bash
# Is the ingest path alive? 200 = ok, 401 = token, 000 = wrong port/unreachable (use 4478, NOT 8478)
curl -sk -m6 -o /dev/null -w '%{http_code}\n' -X POST -H "authorization: Bearer $PI_FLOW_OTLP_TOKEN" \
  -H 'content-type: application/json' -d '{"resourceSpans":[]}' https://chicken.tail4250d0.ts.net:4478/v1/traces

gcx traces query '{ resource.service.name = "pi-flow" }' -d tempo --since 1d      # trace list (metadata only)
gcx traces query '{ .flow.ref = "TP-XXXX" }' -d tempo --since 2h                  # find a ref (mind 0 vs O in refs)
gcx traces get <traceId> -d tempo                                                  # full trace (large -> spills to /tmp/gcx-results-*.json)
gcx metrics query 'pi_flow_run_cost_usd' -d PBFA97CFB590B2093 --since 7d -o json  # metrics side
gcx dashboards get piflow-health -o json                                           # dashboard definition
gcx dashboards update piflow-health -f edited.json                                 # edit: get -> modify -> update (resourceVersion!)
gcx dashboards snapshot piflow-health --since 7d --output-dir /tmp/x               # render PNG
# raw search incl. span sets (gcx traces query hides them):
gcx api "/api/datasources/proxy/uid/tempo/api/search?q=<urlencoded traceql>&start=<s>&end=<s>&spss=20"
journalctl -u tempo -u caddy -u grafana-image-renderer --no-pager -n 50
```

Verify end to end after any telemetry change: restart pi → run a flow (`/flow <ref>`) through validate → wait ~3 min →
`gcx traces query '{ .flow.ref = "<REF>" && .flow.span = "phase" } | count() = 3' -d tempo --since 1h` returns the
trace (3 phase spans visible to search) → open the dashboard, expand the row, click a phase id and confirm the
review/deviation sessions nest under validate.

Synthetic trace for experiments (root + 3 phase spans pushed N s apart, then read `matched`/`spanCount` from the
search API) was the tool that proved the Tempo idle-period behaviour; recreate it rather than waiting for real flows.
Synthetic rows (`SYN-*`, `PMR-DEMO`, `*-probe`) clutter the table until retention removes them.

## 9. Backlog / ideas not done

- Per-run root span with real duration (currently a zero-length marker; can't be updated in place — would need a
  single end-of-run emission with a different span id design).
- Span names for workers are `<ref> - <role>` derived from the agent name; scouts get whatever name was passed to the spawn.
- Provision the dashboard from git (homelab `provisioning/dashboards/`) so it is reviewable; today it is DB-only.
- Redaction for content capture (none today).
- Backfill main-session cost for runs before the `main-session` journal event (would need the main session file per run;
  not recorded then).
- Aven tickets `PMR-HFK1` (M1 attribution), `PMR-EA8X` (M2 cost rollup), `PMR-R8AG` (M4 telemetry), `PMR-XPVE` (M5),
  `PMR-DJ7B` (M6) are done; `aven list` for follow-ups.


## Incident 2026-11-07 (evening): TP-1VFZ had no plan/implement/orchestrator cost

Symptom: first run after the main-session feature showed only `validate` (workers) in the cost dashboard.
Cause: `recordRunEvent` (`run-state.ts`) returns early when the projection is unchanged (`next === state`); the new
`main-session` event never changes the projection, so it was **silently dropped before the journal append** — no run had ever
recorded its main session. My first tests mocked the loop's journal callback and never went through the real writer.
Fix (`776f84a`): `main-session` is appended journal-only; regression test goes through `recordRunEvent` with a temp dir.
Recovery for `TP-1VFZ`: appended the `main-session` event by hand (the main session was the pi session that started 5 s before
the run: `…/--home-geert-Code-personal-pi-flow-range--/2026-11-07T08-39-02-631Z_01a1b529-….jsonl`), recomputed with
`computeCostRollup` and pushed (orchestrator plan $0.157 / implement $0.098 / validate $0.165; ticket total $0.439).
Older tickets (TP-F91N … PMR-BZ4G) cannot be backfilled automatically (no record of their main session); if wanted, find the
pi session whose start is just before the ticket's `run-start` in `~/.pi/agent/sessions/--<cwd>--/`, append a `main-session`
journal line, and re-push.

Also seen on that run: the trace was fully correct by id (79 spans, root + 3 phases + 2 reviewer sessions nested under
validate, 0 missing parents, 0 tool errors). Worker spans carry `agent.type=reviewer` for BOTH the review and the deviation
check (same agent definition), so trace session spans are named `<ref> - reviewer` twice while the cost metrics use the
name-prefix roles `review` / `deviation check` (the assignment record had no `agent` for finished children). The dashboards
normalise legacy capitalised roles (`Review` → `review`, `Deviation check` → `deviation check`, `main` → `orchestrator`) with
`label_replace` so old and new data group together. A second push group `job="pi-flow-range"` exists for refs — that is the
separate pi-flow-range project, not this pipeline.

Orchestrator cost semantics (verified 2026-11-07 on TP-1VFZ): `orchestrator` = the main session's OWN assistant-message
usage inside the flow window only. Subagent sessions are separate jsonl files and separate roles; no subagent usage is
embedded in the main session (checked: 27 assistant messages = $0.4197 = the orchestrator figure; workers $0.0089 + $0.0102
are extra; ticket total $0.439 = orchestrator + workers). Work done inline in the main session (a skill, a oneshot) cannot be
separated from the orchestrator — it IS the main session.
