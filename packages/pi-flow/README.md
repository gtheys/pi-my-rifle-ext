# pi-flow

RPIV flow orchestrator skeleton — thin command/skill routing over
pi-planning, pi-review, and pi-interactive-subagents (no cross-package
runtime imports). Phase routing is wired by the phase tickets; this package
ships the foundation:

- **Work-mode detection** — `resolveMode(pi)` runs `git rev-parse
  --show-toplevel` on the session cwd; a toplevel under any `workRoots`
  prefix is `work` mode, anything else is `personal`. Pure logic lives in
  `work-mode.ts` (`modeForToplevel`, path-segment aware prefix match).
- **Phase-state vocabulary** — `phase-state.ts` exports the lifecycle labels
  (`researched → planned → active → review-passed → done`) and type labels
  (`bug`, `oneshot`, `plan`). On `session_start` the extension best-effort
  runs `aven label create <name>` for each label so they exist before first
  use.
- **Slash commands** — `/research` (implemented: dual flow + ticket gate), `/plan`, `/implement`, `/validate`,
  `/feedback`, `/flow` reply "not implemented yet".

## Configuration

Global config lives at `~/.pi/agent/pi-flow/config.json` (schema:
[`config.schema.json`](config.schema.json)).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workRoots` | `string[]` | `[]` | Absolute path prefixes; a git toplevel under any prefix is `work` mode |

```json
{
  "$schema": "https://raw.githubusercontent.com/gtheys/pi-my-rifle-ext/main/packages/pi-flow/config.schema.json",
  "workRoots": [
    "/home/geert/Code/salaryhero"
  ]
}
```
