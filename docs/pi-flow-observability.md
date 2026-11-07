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

### 6b. Cost dashboard (`piflow-cost`) and range dashboard (`piflow-range`)

Three pi-flow dashboards exist in the same Grafana folder (`ag3jjknk85xc0b`): `piflow-health` (above), **`piflow-cost`**
("pi-flow cost", backup: [`docs/pi-flow-cost.dashboard.json`](pi-flow-cost.dashboard.json)) and `piflow-range`
("pi-flow range: cost vs score", from the M6 ticket; not documented here — `gcx dashboards get piflow-range`).
All are DB-only, not provisioned from git.

`piflow-cost` panels (all Prometheus, variable `ref`): cost by ticket (timeseries), **cost per flow stacked by phase**
(barchart, below), cost by agent/subtask, tokens by kind, total cost by agent.

Stacked-by-phase panel (`panel-2`, replaced the old "Cost by phase" time-bar which plotted `sum by (phase)` over time and
therefore showed one bar per 15 minutes): query `sum by (ref, phase) (pi_flow_run_cost_usd{ref=~"$ref"})` as an
**instant table**, transformation `groupingToMatrix` (rows = `ref`, columns = `phase`, value = `Value`, empty = zero),
`barchart` with `stacking: normal`, tooltip `multi` (hover a bar → every phase's cost), unit `currencyUSD`, fixed colours per
phase via `byName` overrides (plan blue, implement green, validate orange, feedback purple). One bar = one flow ref
(metrics are keyed by ref, so two runs of one ref add up; the trace root is per run). Verified with synthetic refs
pushed via the Pushgateway then deleted (`DELETE <url>/metrics/job/pi-flow/ref/<ref>`).

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
