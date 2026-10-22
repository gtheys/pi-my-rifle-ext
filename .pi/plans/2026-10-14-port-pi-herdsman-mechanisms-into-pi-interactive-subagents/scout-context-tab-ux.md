# Context for: pi-herdsman background-tab spawn → status widget → click-to-focus UX

Source: /tmp/pi-herdsman-scout (clone of boadij/pi-herdsman, read-only). All paths relative to `extension/`.

## Relevant Files
- `extension/herdr.ts` — the entire herdr CLI wrapper. Spawn (`startHerdrAgent` ~L1275), placement selection (`selectSplitPlacement` ~L1155), shell readiness (`waitForShellMarker` ~L1958), `runHerdr` exec wrapper (~L470), herdr event subscriptions (~L199).
- `extension/agent-controller.ts` — placement decision `physicalPlacement()` (~L2821), lead-tab reuse (`reusableLeadTab` ~L2733), focus-with-verification path, coordination tools (steer/interrupt/reply → herdr verbs).
- `extension/presentation.ts` — status widget: `StatusAgent`/`FocusIntent` types (~L115), `renderSupervisionRows` (~L968), `createSupervisionWidget` (~L1432, mouse hit-testing), `formatElapsed` (~L298), `StatusWidget` class (~L3735).
- `extension/lead-runtime.ts` — widget registration via `ctx.ui.setWidget` (~L4999), click handler → `focusLead`/`focusTarget` (~L3131), `herdr agent focus` invocation.
- `docs/reference/status-widget.md` — authoritative UX spec: row format, markers, navigation, refresh cadence.
- `docs/reference/commands.md` — `/herdsman` menu, `/herdsman placement tab|subtree|split`, Agents→Running focus flow.

## 1. Spawn placement — TAB, not visible pane

Config `spawnPlacement` (`extension/config.ts` L36): default **`"subtree"`** = one herdr **tab per agent**, labeled with the agent label. Options: `tab` | `subtree` | `split` (settable via `/herdsman placement …`).

Decision logic (`agent-controller.ts` `physicalPlacement()` L2821):
- Managed-agent delegation (agent spawning a sub-agent) → `{ kind: "split", paneId: $HERDR_PANE_ID }` — splits the caller's own pane (hidden inside the agent's tab, never the owner's view).
- `configured === "subtree"` → `{ kind: "tab", label }` — new tab per agent.
- `configured === "tab"` → reuse a single verified "lead tab" if all owned agents already share exactly one tab that isn't the caller's tab (`reusableLeadTab()`), else new tab.

Physical execution (`herdr.ts` `startHerdrAgent()` L1275):

```bash
# Tab placement (new tab) — root pane comes back from the create call:
herdr tab create --workspace <ws> --cwd <cwd> --label <agentLabel> --env K=V --no-focus
# Tab placement (reusing existing lead tab) or split placement:
herdr pane split --pane <anchorPaneId> --direction right|down --ratio 0.65|0.5 --cwd <cwd> --env K=V --no-focus
# Then attach the pi agent to that pane:
herdr agent start <alias> --kind pi --pane <paneId> --timeout <s> -- \
  --extension <pi-herdsman-ext-path> --extension <agentDir>/extensions/herdr-agent-state.ts <agentArgs>
```

**Background key: `--no-focus` on both `tab create` and `pane split`** — the new surface never steals focus. `createdTab` flag recorded on the result for rollback (a failed start tears down a tab it created but never a user tab).

Spawn sequence hardening (portable lessons):
1. `herdr tab list --workspace` / `pane list --workspace` to resolve placement; revalidate right before acting (`placementRevalidator`).
2. `waitForShellMarker()` L1958: `herdr pane run <pane> echo __PI_HERDSMAN_READY_<uuid>__` then `herdr pane wait-output <pane> --regex ^<marker>$ --timeout <n>` — proves shell is interactive before launching pi (avoids the fresh-shell "busy" race; retries on `agent_pane_busy` for 2s).
3. Re-`pane list` and verify pane identity/topology unchanged before `agent start`.
4. After start, read back `agent.agent_session` (session id/path) — verified identity used everywhere later.

## 2. Status listing UX

Pi-native ambient widget via `ctx.ui.setWidget("pi-herdsman-staff", (tui, theme) => component)` (`lead-runtime.ts` L5000). Component object contract: `{ render(width) → string[], handleMouse(event), invalidate() }`. `renderWidget` closure calls `tui.requestRender()` on a 2s presentation tick so **elapsed time ticks without new snapshots** (`PRESENTATION_MIN_INTERVAL_MS = 2000`, herdr.ts L213).

Per-agent row data (`presentation.ts` `StatusAgent` L115): `label`, `state` (`working|blocked|settling|starting|unknown|lost`), `definition`, `paneId`, `sessionId`, `task`, `startedAt` (→ elapsed), `model`, `thinking`, `contextPercent`, `stale`, `inactiveMs`, `parentLabel`.

Row rendering (tree form, width-aware):
```
● chief · 2 working · 1 blocked
├─ ● feat/foo · working  14m  61%
└─ ○ fix/other · done
```
Markers: `●` working, `◐` blocked, `◌` settling/starting, `○` idle/done, `?` unknown, `×` lost; `>` = selected; `!` prefix for blocked. Header = role + nonzero state counts. Under width pressure drop order: task → elapsed → context. Cap 6 ordinary rows + `… N more`. Starting agents are controller-local transient entries (`pendingStartEntries`) shown before herdr knows the agent. Refresh: herdr SSE-style events (`herdr` event subscriptions, herdr.ts L199) + 10s reconciliation; snapshot failure → header `stale`, last snapshot retained.

## 3. Open/focus mechanism — mouse click → `herdr agent focus`

Two layers:

**Clickability** (`createSupervisionWidget` L1432): `render()` records `HitRegion[] = {row, from, to, intent}` for rows whose identifying label is visible. `handleMouse(event)` receives `{type:"click", button:"left", width, x, y}` from pi's TUI; match `row === event.y && from <= event.x < to`; emit `FocusIntent = {kind:"session", sessionId, parentSessionId?} | {kind:"assigned-manager"}`. Only left-click, only if width unchanged since render.

**Focus action** (`lead-runtime.ts` `focusTarget()` L3131): intent → re-verify before acting:
1. Reload status snapshot; find exactly one live agent with that sessionId, state not starting/unknown/lost, with paneId.
2. `verifiedHerdrAgent()` (herdr.ts L74): `herdr agent list` + `herdr agent get <pane>`; require exact match of pane_id, tab_id, workspace_id AND `agent_session` equals expected pi session id/path.
3. If all checks pass: **`herdr agent focus <paneId>`**. Any mismatch → no command sent, error "Agent changed; reopen Running."

Also available keyboard-path: `/herdsman` (alias `/agents`) → Agents → Running menu → select agent → same verify + `herdr agent focus`. Docs: mouse nav unavailable in plain terminal/scrollback mode; menus are the fallback. No global custom keybindings registered for this; pi keybinding API used only inside custom select menus (`keybindings.matches(data, "tui.select.up")` etc., index.ts L1447).

## 4. Minimal herdr CLI verb set

All calls go through `runHerdr(pi, ctx, args)` = `pi.exec("herdr", args, {cwd, signal, timeout})`, stdout parsed as herdr JSON-RPC envelope `{id, result}` (herdr.ts L470). Preflight: `herdr status --json`, client ≥ 0.9.1, server running+compatible.

Minimal for spawn → list → open → steer → complete:
- **Spawn**: `tab list --workspace`, `tab create --workspace --cwd --label --env --no-focus`, `pane list --workspace`, `pane split --pane --direction --ratio --cwd --env --no-focus`, `pane run <pane> <cmd>`, `pane wait-output <pane> --regex --timeout`, `agent start <alias> --kind pi --pane --timeout -- --extension …`
- **List/status**: `agent list`, `agent get <pane>`, `pane get`, `pane process-info`, `agent read <pane> --source recent-unwrapped --format text` (recent output; called directly, no explicit --lines to avoid alternate-screen paging), optional `pane layout --pane <p>` (split-anchor geometry).
- **Open**: `agent focus <pane>`.
- **Steer/complete**: `agent steer`, `agent interrupt`, `agent continue`, `agent reply`, `agent close`; owner→agent messages ride `pi.sendMessage(..., {deliverAs:"steer"})` in-process; agent→owner results arrive as custom messages (`pi-herdsman-agent-result`) with `triggerTurn: true`.
- **Teardown/rollback**: `pane close`, `tab close` (only if `createdTab`), `tab rename`.
- Identity sidecar: herdr's own `~/.pi/agent/extensions/herdr-agent-state.ts` is injected into every spawned pi (`--extension`) — that's how herdr populates `agent_session` (pi session id/path) on the pane; herdsman only verifies it.

## 5. What still uses pane splits

- Managed-agent delegation always splits the delegating agent's own pane (`{kind:"split", paneId: $HERDR_PANE_ID}`) — required, fails without `HERDR_PANE_ID`.
- Explicit config `placement: split` (user opt-in) splits the caller pane.
- Lead-tab reuse (placement `tab` with a reusable lead tab, or `subtree`'s tab when placement revalidates to an existing shared tab) splits inside that tab — anchor = largest agent pane rect, direction `right` if `width >= height` else `down`, ratio 0.5 (0.65 for first split into caller pane). This is all *inside* agent tabs/background surfaces — the owner session's own pane is never split in subtree mode.

## pi TUI capabilities herdsman relies on

- `ctx.ui.setWidget(name, factory)` — ambient status widget slot; factory gets `(tui, theme)`, returns `{render(width): string[], handleMouse(event), invalidate()}`. `ctx.hasUI` / `ctx.mode === "tui"` gating; `ctx.ui.setWidget(name, undefined)` to remove; `ctx.ui.notify(msg, "warning")` for focus errors.
- Mouse events delivered to widget components: `{type, button, width, x, y}`; return `{handled: true, render: false}`.
- `tui.requestRender()` for timer-driven redraws (2s elapsed tick).
- pi-tui primitives: `Container, Text, Markdown, truncateToWidth, visibleWidth` (`@earendil-works/pi-tui`), theme helpers from `@earendil-works/pi-coding-agent` (`getMarkdownTheme`, truncate helpers).
- `pi.registerCommand("herdsman"/"agents")` menus as keyboard-accessible fallback; `getArgumentCompletions` for `/herdsman placement tab|subtree|split`.
- `pi.exec` with `signal`/`timeout`; `getAgentDir()` for the herdr-agent-state sidecar path.

## Gotchas

- **Verification-before-focus is the whole safety story**: click intent carries only sessionId; every click re-runs agent list/get + session match. Status projection is "never authorization." Port this pattern — stale clicks must be inert, not focus the wrong pane.
- `createdTab` cleanup asymmetry: only tabs herdsman created are closed on failure/stop. A port must track tab ownership or it will close user tabs.
- `--no-focus` is the background guarantee; also placement revalidation happens *inside* `startHerdrAgent` (race between decision and execution).
- Shell-readiness marker (`pane run` + `pane wait-output`) plus `agent_pane_busy` retry exists because fresh panes aren't immediately ready for `agent start` — herdr bug #3208 workaround; a simpler port may hit the same race.
- `herdr agent read` must not pass explicit `--lines` (pages alternate screen, rejects active agents with `agent_not_idle`).
- Widget hit-testing depends on render width matching event width; stale-width clicks ignored.
- `runHerdr` demands herdr's `{id, result}` JSON envelope — raw CLI parsing won't do.
