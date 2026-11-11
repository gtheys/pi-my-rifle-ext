# pi-bash-guard

Human approval gate for the agent's `bash` tool: commands that look
destructive wait for your Allow/Deny; obviously-safe ones run untouched.
The "looks destructive" call is made by
[strands-decider](https://github.com/strands-labs/strands-decider) — a small,
fast, calibrated decision model (a "system one" model) that classifies a
command as `safe` or `destructive` with a confidence, faster and cheaper than
an LLM. Deterministic tiers around it keep the obvious cases off the model.

Decision order per `bash` tool call:

| Tier | What | Result |
| --- | --- | --- |
| 0 | already human-approved this session | allow (no prompt) |
| 1 | catastrophic patterns (`mkfs`, fork bomb, `curl … \| sh`, `rm -rf /`, raw device writes, shutdown) | **block outright** — never run from an agent session |
| 2 | single read-only command, no shell metacharacters (`ls`, `rg`, `git diff`, `bun test`, …) | allow (no decider call) |
| 3 | everything else → decider `safe`/`destructive` + confidence | `safe` ≥ threshold → allow |
| 4 | decider says destructive, low confidence, or is unreachable | **you** get an Allow/Deny dialog showing the command, the verdict and the confidence |

Fail-closed everywhere: decider unreachable, an unparseable answer, or no
dialog UI available → block, never a silent allow. A human running bash by
hand is out of scope — the boundary is the agent's bash *tool*.

Every tier-3/4 decision is journaled to the session as a `bash-guard` entry
(command, decision, reason), so runs have an audit trail.

This is a guardrail, not a privilege boundary: aliases, `sh -c '…'` and
variable-built commands are not decoded (same stance as pi-flow's landing
gate).

## Setup

1. Serve the decider locally (one-time per machine; CPU works, a GPU is
   faster):

   ```bash
   pip install strands-decider
   strands-decider serve StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --device cpu --port 8000
   ```

2. Nothing else — the extension defaults to `http://127.0.0.1:8000`.

Optional config at `~/.pi/agent/pi-bash-guard/config.json` (global) or
`<project>/.pi/pi-bash-guard/config.json` (project, wins):

```json
{
  "enabled": true,
  "deciderUrl": "http://127.0.0.1:8000",
  "threshold": 0.85,
  "timeoutMs": 3000,
  "rememberApproval": true
}
```

- `threshold` — minimum calibrated confidence for a `safe` verdict to
  auto-run. The decider's calibration is measured (answers at ≥ 0.9 are right
  ~95% of the time on unseen short tasks); 0.85 trades a few extra prompts
  for fewer surprises.
- `rememberApproval` — an approved command is not re-prompted within the
  session (exact string match).

`/bash-guard` shows status: config, decider reachability, and session
counters (allowlisted / decider-allowed / human-confirmed / human-denied /
hard-denied / fail-closed).

## Files

- `classify.ts` — pure tiers: allowlist / hard-deny / decider routing
- `decider.ts` — strands-decider HTTP client (`POST /v1/systemone`), injectable fetch
- `config.ts` — TypeBox config schema + resolution (project > global > defaults)
- `index.ts` — extension entrypoint: `tool_call` interceptor, confirm dialog, journal, `/bash-guard`
