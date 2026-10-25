---
name: run-integration-tests
description: Run the pi-interactive-subagents test suites (unit + integration) and verify everything is green. Use when asked to "run integration tests", "run e2e tests", "test before release", "verify integration", "run the full test suite", "check everything works".
---

# Run Tests (pi-interactive-subagents)

Two suites, both runnable anywhere. No LLM sessions are spawned by any
test — the real-LLM lifecycle suites were deleted in PMR-CM6D.

## Step 1: Preflight

```bash
node --version   # Node 22+ required
echo "HERDR_PANE_ID=${HERDR_PANE_ID:-<unset>}"
```

`HERDR_PANE_ID` decides the integration-test mode: set → real herdr;
unset → the mock-herdr shim (`test/mock-herdr.ts`) is prepended to PATH.
Both modes must be green. Two mux-surface tests are real-herdr-only and
report as skips in mock mode.

## Step 2: Unit tests

```bash
cd packages/pi-interactive-subagents
node --test test/test.ts test/herdr-stderr.test.ts test/mock-herdr.test.ts
```

All tests must pass. If any fail, stop and fix them before proceeding.
Expected wall time: a few seconds.

When an agent runs this inside a subagent session, strip its own env
first — `PI_SUBAGENT_ID`/`PI_DENY_TOOLS` make the extension skip tool
registration and cause ~6 false test failures:

```bash
env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_DENY_TOOLS node --test test/test.ts test/herdr-stderr.test.ts test/mock-herdr.test.ts
```

## Step 3: Integration tests

```bash
node --test --test-concurrency=1 --test-force-exit test/integration/*.itest.ts
```

`--test-concurrency=1` is required: suites share herdr/mux global state
(focus) and would race in parallel.

| Suite | Tests | Mode |
|-------|-------|------|
| `herdr-verbs` | 4 | two-mode: real herdr / mock-herdr shim |
| `mux-surface` | 9 | two-mode (2 real-herdr-only, skipped under mock) |
| `owner-inbox` | 3 | file-based, no herdr |
| `peers` | 1 | file-based, no herdr |

All 17 tests must pass (or skip where marked real-herdr-only). If any
fail, report the failure output and stop.

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_TEST_TIMEOUT` | `120000` | Per-test timeout in ms |

## Step 4: Full-repo check (before landing)

```bash
cd <repo root> && bun run check
```

Runs lint + typecheck + every workspace's unit tests — the same command
the lefthook pre-push hook enforces. Must exit 0.

## Step 5: Report

```
Unit tests:        <pass>/<total> ✅
Integration tests: <pass>/<total> (mode: real herdr | mock) ✅
bun run check:     exit 0 ✅
```

If any step failed, summarize what broke and suggest next steps.
