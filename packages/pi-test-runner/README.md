# pi-test-runner

> ⚠️ **Experimental / Work in Progress** — behaviour may change.

Pi extension that discovers and runs JS/TS test scripts from the nearest `package.json`, spawning an isolated subagent to execute them. Results are injected back into the session automatically when done — the tool is **non-blocking**.

## How it works

1. Scans up from the current directory to find the nearest `package.json`.
2. Extracts scripts matching test patterns (`test`, `test:*`, `jest`, `vitest`, `playwright`, `mocha`, `cypress`, `e2e`, `spec`).
3. If multiple scripts exist and no `script` param is given, shows a picker.
4. Detects the package manager from lockfiles (`yarn.lock`, `pnpm-lock.yaml`, fallback to `npm`).
5. Spawns an isolated pi subprocess as the subagent.
6. Returns **immediately** — session is unlocked while tests run.
7. Subagent sends `contact_supervisor` progress updates via pi-intercom.
8. When done, `pi.sendMessage({ triggerTurn: true })` re-engages the LLM with structured pass/fail results.

## Tool parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `script` | `string?` | Script key from `package.json` (e.g. `test:unit`). Auto-detected if omitted. |
| `cwd` | `string?` | Working directory to search. Defaults to current project directory. |
| `model` | `string?` | Model ID for the subagent. Overrides the configured default. |

## Commands

```
/run-tests                — run tests, truly non-blocking
/run-tests test:unit      — run a specific script

/test-runner              — show current config and active runs
/test-runner model <id>   — set default subagent model
/test-runner model        — show current default model
/test-runner reset        — clear all config
/test-runner back         — return to the previous session
```

## `/run-tests` vs `run_tests` tool

| | `/run-tests` command | `run_tests` tool |
|--|---------------------|------------------|
| Triggered by | You (directly) | LLM |
| LLM turn while running | None | One turn for "started", one for results |
| Session stays idle? | ✓ Always | ✗ LLM responds twice |
| When to use | Normal test runs | LLM-driven workflows |

## Configuration

Global config: `~/.pi/agent/test-runner/config.json`

| Option | Type | Default | Description |
|---|---|---|---|
| `defaultModel` | string | _(pi default)_ | Model ID for the test-runner subagent |

```json
{
  "$schema": "./.pi/agent/test-runner/config.schema.json",
  "defaultModel": "claude-haiku-4-5"
}
```
