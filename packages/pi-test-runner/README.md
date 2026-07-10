# pi-test-runner

Pi extension that discovers and runs JS/TS test scripts from the nearest `package.json`, spawning an isolated subagent to execute them and returning structured pass/fail results.

## Usage

```
/run-tests               — discover scripts and run (prompts if multiple found)
/run-tests <script>      — run a specific script key (e.g. test:unit)
/test-runner             — show active runs and config
/test-runner model <id>  — set the default subagent model
/test-runner back        — return to the previous session
```

The `run_tests` tool is also registered for direct agent use.

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
