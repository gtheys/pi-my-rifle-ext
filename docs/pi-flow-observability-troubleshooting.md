# pi-flow observability: "dashboard shows no data" troubleshooting

Dashboard: `https://chicken.tail4250d0.ts.net:4443/grafana/d/piflow-health/pi-flow-health`
(not provisioned in the homelab repo; it lives in Grafana's DB, fetch it with `gcx dashboards get piflow-health`).

## Architecture (chicken homelab, podman quadlets in `~/Code/personal/homelab/quadlets`)

| Signal | pi-flow sends to | Path | Stored in | Dashboard use |
| --- | --- | --- | --- | --- |
| Traces (OTLP/HTTP JSON) | `telemetry.otlpEndpoint` + `/v1/traces` | Caddy host port **4478** (bearer `PI_FLOW_OTLP_TOKEN`) -> `tempo:4318` | Tempo | "Traces by flow.ref" panel (TraceQL `{ .flow.ref = "$ref" }`) |
| Metrics (`pi_flow_*`) | `PI_FLOW_PUSHGATEWAY_URL` | Caddy host port **4479** (bearer `PI_FLOW_PUSHGATEWAY_TOKEN`) -> `pushgateway:9091` | Pushgateway -> Prometheus (`job=pi-flow`) | tool error rate, tool failures, run duration; `$ref` var = `label_values(pi_flow_run_cost_usd, ref)` |

Port gotcha: Caddy's `PublishPort=100.108.226.64:44xx:84xx` — clients use the **44xx** host port.
The **84xx** ports are container-internal and unreachable from clients. The k8s `tempo` in
`salaryhero-local` is a different, unrelated Tempo (SalaryHero app traces, gRPC 4317 only).

## Incident 2026-11-07: no traces in Grafana

- **Root cause:** `~/.pi/agent/pi-flow/config.json` had `otlpEndpoint: https://chicken.tail4250d0.ts.net:8478`.
  Nothing listens on 8478 (connection fails, curl code 000). The exporter is fire-and-forget and
  swallows errors (max one journal note per process), so there was no visible failure.
  Correct port is **4478**. The pushgateway URL already used 4479, which is why metrics did arrive.
- The misleading `8478` example in `config.ts` / `config.schema.json` descriptions was changed to `4478`.
- Evidence: Tempo `service.name` values had no `pi-flow`; POST to `:8478` failed, `:4478` without token
  returned 401, with token 200.
- Not a dashboard bug for traces. Metrics were present but only for ref `PMR-BZ4G`, all `status="ok"`,
  so the two error-rate panels (filter `status="error"`) are legitimately empty until a tool call fails.

## Diagnosis checklist (run on chicken)

```bash
# 1. Does the endpoint accept spans? 200 = ok, 401 = bad/missing token, 000 = wrong port/unreachable
curl -sk -m6 -o /dev/null -w '%{http_code}\n' -X POST \
  -H "authorization: Bearer $PI_FLOW_OTLP_TOKEN" -H 'content-type: application/json' \
  -d '{"resourceSpans":[]}' "$(jq -r .telemetry.otlpEndpoint ~/.pi/agent/pi-flow/config.json)/v1/traces"

# 2. Did pi-flow spans land in Tempo?
gcx traces query '{ resource.service.name = "pi-flow" }' -d tempo --since 7d

# 3. Did metrics land in Prometheus, and which refs/status exist?
gcx metrics query 'pi_flow_tool_calls_total' -d PBFA97CFB590B2093 --since 7d -o json

# 4. Dashboard queries
gcx dashboards get piflow-health -o json
```

Then: Tempo has no data -> check endpoint port/token (step 1). Prometheus has no data -> check
`PI_FLOW_PUSHGATEWAY_URL` (should be `:4479`). Both have data but panels empty -> check `$ref`
variable, time range, and whether the panel filters on `status="error"`.

`gcx dashboards snapshot` cannot render this dashboard (lands on the Grafana login page); look in the browser.

## Follow-up 2026-11-07: traces arrive, trace panel still empty

- After the port fix, real pi-flow traces reached Tempo (`service.name="pi-flow"`).
- The "Traces by flow.ref" panel used `{ .flow.ref = "$ref" }`. With `ref` = All the variable
  expands to `.*` (`allValue`), and `=` is an exact match, so nothing matched. Patched live with
  `gcx dashboards update` to `{ .flow.ref =~ "$ref" }` (backup was `/tmp/piflow-health.bak.json`, not kept;
  re-create via `gcx dashboards get`). The dashboard is not in git, so this change exists only in Grafana.
- `flow.ref` is set only when `PI_FLOW_REF` is in the env (flow-spawned workers). Plain interactive
  sessions emit spans without it, so they never match the panel. Check with `{ .flow.ref != nil }`.
- Spans are buffered and flushed at 16 spans or on `session_shutdown` — not live.

## Follow-up 2026-11-07 (2): trace panel said "No data found in response"

- Real cause of the empty panel: it used the `traces` visualization, which renders ONE trace by id.
  A TraceQL search returns a table of traces, so the viz must be `table` (`tableType: "traces"`).
  Patched live with `gcx dashboards update`; verified by rendering the panel (8 rows incl. flow runs).
- Rows showed `<root span not yet received>`: the flow loop reserves a root span id in `PI_FLOW_TRACEPARENT`
  and every span parents on it, but nothing exported that span. Fixed in `telemetry/index.ts`: the MAIN process
  (no `PI_SUBAGENT_NAME`) now exports `flow <ref>` once per flow trace (zero-length marker, see `shortcut:` note).
  Traces recorded BEFORE this fix keep the placeholder forever (Tempo is append-only).
- Panel query now `... | select(.flow.ref, .phase, .agent.name)`, so expanded rows show ref/phase/agent.
- The row `flow PMR-DEMO` (13:03) is a synthetic verification trace I POSTed by hand, not a real run.
- Rendering with `gcx dashboards snapshot piflow-health --since 7d --output-dir /tmp/x` works once the
  image renderer reaches Grafana without Authelia (it returned the login page before that was fixed).
  ALWAYS render the dashboard before declaring it fixed.

## Trace shape (after 2026-11-07 fixes)

```
flow <ref>                       main process, zero-length marker, id = PI_FLOW_TRACEPARENT span id
├─ tool bash / gen <model>       main-session spans (flow.ref, phase attrs)
└─ <ref> - <role>                one per worker (role = agent name before the first colon: review, deviation check, worker…), zero-length marker exported when the worker first sees the trace
   └─ tool … / gen …             worker spans
```

Known limits: root and worker-session spans are zero-length markers (trace duration comes from the child
spans). Never re-export a span with the same id and a later end: Tempo keeps both copies until compaction and
which wins is undefined (verified on the homelab Tempo). A crashed worker is safe: its session span went out
with the first flush. Traces recorded before the fixes keep `<root span not yet received>`.
