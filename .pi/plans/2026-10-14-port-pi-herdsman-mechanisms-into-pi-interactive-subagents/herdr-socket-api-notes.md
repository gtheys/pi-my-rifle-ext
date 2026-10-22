# herdr socket API — distilled for PMR-M48Y (cmux.ts herdr backend fix)

Source: https://herdr.dev/docs/socket-api/ (docs track 0.9.4; installed binary is 0.9.0 —
**trust `herdr api schema --json` from the local binary over the website**).

## Relevant to the failing mux-surface [herdr] tests

### Escape delivery (was: "delivers Escape as byte 27")
- Use `pane.send_keys` with key-combo strings: `esc`, `enter`, `ctrl+h`, `alt+x`, `shift+tab`, `f1`, named punctuation (`minus`, `plus`). No raw bytes, no tmux-style prefix+ bindings.
- Also `pane.send_text` (literal text) and `pane.send_input` (combined).

### Long command without truncation (sendLongCommand)
- Input queue has a canonical input limit check: an oversized encoded line (incl. Enter) is **rejected in full**. (Doc describes macOS; verify on 0.9.0/Linux via schema.)
- Correct pattern: write payload to a script file, then type a SHORT command line (`bash /tmp/xyz.sh`) — never the payload itself. If cmux.ts pastes long lines, that's the truncation.

### Reading panes asynchronously
- `herdr pane read <id> --source recent --lines 50`
- `PaneInfo` includes `scroll: {offset_from_bottom, max_offset_from_bottom, viewport_rows}` — `offset_from_bottom == 0` = at-bottom.
- `pane.wait_for_output` exists for blocking waits; `agent.wait <pane> --until done` is server-owned/event-driven.

### Focus preservation
- Explicit methods: `pane.focus_direction {direction}`, `pane.current` (caller_pane_id aware), `tab.focus`, `workspace.focus`.
- `pane.split`/`pane.run`/`layout.apply` accept focus/env params — pass focus intent at creation instead of stealing focus.

### Submit + wait atomically
- `agent.prompt` accepts optional `wait: {until, timeout_ms}` — submit prompt + start wait in one request, no race. Returns `agent_blocked` if agent already blocked.

## Transport
- CLI wrappers (`herdr pane ...`) cover everything needed; raw socket only for event subscriptions (`events.subscribe`, `events.wait`).
- `herdr api schema --json` prints the full protocol schema of the INSTALLED binary.
- All pane methods use public ids like `w1:p1`; omitted pane_id = server's focused pane.

## Version gap warning
- Installed: herdr 0.9.0. Docs latest: 0.9.4. Some methods (e.g. `pane.input.set`, canonical-input check) may be newer. Always verify against `herdr api schema` before relying on a method.
