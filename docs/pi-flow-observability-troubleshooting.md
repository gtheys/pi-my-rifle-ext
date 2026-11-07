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
