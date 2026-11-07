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
flow <ref>                       flow.span=root     main process, zero-length marker, id = PI_FLOW_TRACEPARENT span id
├─ <ref> - plan                  flow.span=phase    main process, REAL start/end, exported + flushed when the phase ends: flow_phase_complete, or ANY flow-env transition (halt, pause, done, next phase, supersede)
│  ├─ tool … / gen …             main-session spans of that phase
│  └─ <ref> - <role>             flow.span=session  one per worker (role = agent name before the first colon)
│     └─ tool … / gen …          worker spans
├─ <ref> - implement             (same shape)
└─ <ref> - validate
```

- Phase span id = first 16 hex of `sha256(traceId:phase)` (`phaseSpanId`); workers recompute it from their own
  `PI_FLOW_TRACEPARENT` + `PI_FLOW_PHASE`, so no extra env var crosses the package boundary.
- Root and worker-session spans are zero-length markers (trace duration comes from children). Never re-export
  a span id with a later end: Tempo keeps both copies until compaction and which wins is undefined.
- Limits: a main process killed mid-phase never exports that phase span (children hang off a missing parent,
  flow root still names the trace). A crashed worker is safe (its session span goes out with the first flush).
  Traces recorded before 2026-11-07 keep `<root span not yet received>` and have no `flow.span` attribute.

## Trace table: "3 rows, all phase=plan"

The expanded rows under a trace are the first matching SPANS, not "plan spans". Tempo returns 3 matching
spans per trace by default (`spss`), and with only `select(.flow.ref, .phase)` they all look alike. Panel query is now
`{ .flow.ref =~ "$ref" } | select(name, .flow.ref, .phase, .agent.name)` with `spss: 20`, so rows show span names
(`flow <ref>`, `tool bash`, `gen <model>`). `gcx traces query` returns no span sets, so verify in the browser.

Panel query (final): `{ .flow.ref =~ "$ref" && (.flow.span = "phase" || .flow.span = "root") } | select(name, .phase)`
with `spss: 20` -> expanding a trace row lists one row per phase (with its duration) instead of individual calls;
click a phase span id to open the trace with that phase's calls nested under it. Older traces (no `flow.span`)
no longer match this panel.

Incident: `validate` phase span missing, its calls and the review/deviation worker sessions loose at the top level.
Cause: a phase was only closed when the NEXT phase appeared; validate is last, so it stayed open (unsent) while
the session lived. Fix: close + flush on `flow_phase_complete`; the closed phase stays the parent of trailing spans
and is never re-sent. Spans only auto-flush at 16 buffered spans or shutdown, so closing without flushing is not enough.

Phase closing, final design: the flow loop calls `onFlowEnvChange` after every stamp/re-stamp/clear; `index.ts`
late-binds it to telemetry's `syncFlowEnv()`, which re-reads the env, closes the phase that just ended and flushes
(also flushes the `flow <ref>` root immediately at run start). `flow_phase_complete` still closes + flushes on its own
(more accurate end). A phase closes at most once (`exported`); the closed phase stays parent of trailing spans.
Only remaining gap: main process hard-killed mid-phase (no shutdown event) never sends that phase span.

## Seeing what the LLM said: content capture levels

Spans are metadata-only by default. To see content, set `telemetry.captureContent` in
`~/.pi/agent/pi-flow/config.json` (restart pi after changing it). Levels are cumulative:

| `captureContent` | Adds | Attributes |
| --- | --- | --- |
| `off` (default) | nothing | — |
| `text` | assistant text | `gen_ai.completion` (gen spans) |
| `tools` | + tool calls the model made, tool input + output | `gen_ai.tool_calls`, `tool.input`, `tool.output` |
| `all` | + model reasoning | `gen_ai.reasoning` |

```json
{ "telemetry": { "enabled": true, "otlpEndpoint": "https://chicken.tail4250d0.ts.net:4478",
                 "captureContent": "tools", "maxContentChars": 2000 } }
```

- Where to look: Grafana trace view -> click a `gen …` / `tool …` span -> Span attributes. TraceQL:
  `{ .gen_ai.completion =~ ".*word.*" }`, `{ .tool.output =~ ".*ENOENT.*" }`.
- **Tempo truncates every attribute value at 2048 bytes, silently** (measured on the homelab Tempo 2.10: a 10000-char
  value came back as 2048). Hence `maxContentChars` defaults to 2000. Raising it needs Tempo's `max_attribute_bytes`
  raised too (`0` disables the check; see Grafana Tempo "Configure Tempo"/overrides docs — placement not yet applied on
  chicken, `quadlets/tempo/tempo.yaml` is unchanged). Truncation counter: `tempo_distributor_attributes_truncated_total`.
- **Secret/PII risk:** no redaction. Tool output and reasoning hold file contents, env dumps and tokens; Tempo keeps them 14 days
  (`block_retention: 336h`) and anyone with Grafana access can read them. Start with `text`.
- Only `gen` and `tool` spans carry content; root, phase and worker-session spans stay metadata-only. Workers use the same
  config, so their spans carry content at the same level.
- Code: `packages/pi-flow/telemetry/content.ts` (extraction + truncation), wiring in `telemetry/index.ts`,
  tests in `test/telemetry-content.test.ts`. User-facing docs: `packages/pi-flow/README.md` ("Capturing content in spans").

## Incident: dashboard table missing the validate phase although the trace is complete

Symptom: trace opened by id showed plan/implement/validate/review/deviation correctly (83 spans), but the
"Traces by flow.ref" table listed only root/plan/implement for the same trace.

Cause (Tempo, not pi-flow): ingester `trace_idle_period` defaults to 10s. Spans of one trace pushed more than 10s
apart are cut into separate segments, and TraceQL SEARCH surfaces only ONE segment per trace (open-by-id merges
them all, which is why the trace view was right). Controlled test with synthetic traces, 4 spans pushed N seconds
apart: 4s -> search sees 4/4; 30s -> search sees 1/4. Flow traces run for minutes, so they always split.

Fix: homelab `quadlets/tempo/tempo.yaml` -> `ingester.trace_idle_period: 3m` (deployed via copy to
`/opt/homelab/quadlets/tempo/` + `systemctl restart tempo`). Verified: 30s-gap synthetic trace -> 4/4 once idle 3m passed.

Consequences:
- A finished (or paused) trace becomes fully searchable ~3 minutes after its last span; the table can look
  partial during that window. Open-by-id (clicking the trace ID) is always complete.
- A silence longer than 3m inside one trace (e.g. a long human wait with no spans from main or workers) can still
  split it. Raise the value (memory cost is tiny at this volume) if that happens.
- Traces recorded BEFORE the change (TP-AXWW, TP-EC0G, ...) stay partial in the table forever; the trace view is fine.
- Test traces `SYN-*`, `PMR-DEMO` and the `*-probe` spans were posted by hand while debugging; they will show in the
  table until Tempo's 14d retention removes them.
- Re-run the experiment with `synth.sh`-style pushes (root + 3 phase spans, N s apart) and a TraceQL search that
  reads `matched` / `spanCount` via `gcx api /api/datasources/proxy/uid/tempo/api/search?...`.
