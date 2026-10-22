# Port pi-herdsman mechanisms into pi-interactive-subagents — tab-based UX rework

**Date:** 2026-10-14 (rewritten for tab-based background-agent UX)
**Status:** Draft — awaiting user approval before stage 2 (aven ticket creation + dep rewiring + ticket description updates)
**Directory:** /home/geert/Code/personal/pi-my-rifle-ext
**Package:** `packages/pi-interactive-subagents` (`@gtheys/pi-interactive-subagents`)
**Aven epic:** PMR-N65M — 11 epic children + PMR-M48Y, plus ONE new ticket proposed below (tab-UX rework).
**Branch:** `feat/herdsman-mechanisms-port`, worktree `/home/geert/.herdr/worktrees/pi-my-rifle-ext/feat-herdsman-mechanisms-port`
**Source reference:** pi-herdsman v0.26.0 clone at `/tmp/pi-herdsman-scout` (Apache-2.0, read-only; re-clone `boadij/pi-herdsman` if gone). ADRs 0001–0010, 0013, 0017, 0019. herdr CLI docs track 0.9.4; installed binary is **0.9.0** — trust `herdr api schema --json` over the website.

## Intent

Port herdsman's coordination kernel (durable mailbox records, request/ack handshake, result store with semantic refs, blocking ask_owner, peer registry, branch-owned assignments) into `pi-interactive-subagents`, and **rework the runtime around herdsman's tab-based background-agent UX**: `subagent()` spawns the child pi session in a **background herdr tab** (`herdr tab create --no-focus` — never a visible sibling pane, never focus-stealing), the parent's status widget shows per-agent rows (state marker, label, status, elapsed tick), and a **mouse click on a widget row opens that agent's tab** (`herdr agent focus` after identity re-verification, stale clicks inert). The package becomes **herdr-only**: the cmux/tmux/zellij/wezterm backends are deleted; the mux-portability guardrail is dropped by user decision.

Coordination between parent and child stays **file-based** (mailbox records + sidecars — already landed). Delivery into a live child changes from pane typing to **herdsman's model: durable records + child-side pump** — we never type text into panes; the only physical pane input is control keys (Escape). Answer/reply delivery adapts accordingly (PMR-WXG0 section).

## Landed work (survives the rework)

Committed on `feat/herdsman-mechanisms-port`:

| Commit | Phase / ticket | Content |
|---|---|---|
| `19b2b76` | Phase 0 | Config modernization (TypeBox, `getAgentDir()`/`CONFIG_DIR_NAME`, `config.schema.json`), durable data root `pi-subagents/`, process locks (`lock.ts`, herdsman port), dep alignment |
| `12bb261` | PMR-VJPR (done) | Durable result store + semantic refs `result:<name>#<n>`, exclusive-create reservations, hidden bindings |
| `e987ae4` | PMR-DNPZ (done) | Request/ack handshake for `subagent_interrupt` (durable control record, `.ack` sidecar, correlation, fire-and-forget fallback) |

Uncommitted in the worktree: **PMR-M48Y** herdr backend notes (cmux.ts herdr path fixes) and **PMR-WXG0** ask_owner work (new `asks.ts`, `test-ask.md` agent, harness/lifecycle-test changes). The file-channel core of both survives; spawn/delivery mechanics adapt as described below. Both land as their own commits in the re-sequenced phases.

**M48Y status note:** installed herdr is 0.9.0; herdsman pins **≥0.9.1**. Verified on 0.9.0: `tab create --no-focus`, `agent start <name> --kind pi --pane <id> --timeout -- <args>`, `pane send-keys <pane> esc`, `agent focus <target>` all exist. The ≥0.9.1 gate is a baseline pin (herdsman's own preflight); upgrade herdr before integration runs.

## Guiding principles (from herdsman ADRs, apply throughout)

- **Persist intent, derive runtime state** (ADR 0002): durable records hold identity/ownership/asks; liveness is recomputed from fresh evidence (sidecars, activity snapshots, herdr inventory). Ambiguous evidence ⇒ fail closed (report `unknown`, take no destructive action).
- **One durable root** (ADR 0007): all durable state under `getAgentDir()/pi-subagents/` (Phase 0, landed). OS temp only for process locks.
- **Exactly-once discipline**: atomic writes (tmp+rename), exclusive-create (`flag:"wx"`) for never-reused allocations, process locks (`{pid,id}` claims) for presence validity.
- **Identity revalidated before every mutation**: ack/reply/claim correlated against requestId + childId + session path; focus actions re-verified against herdr inventory (pane_id/tab_id/workspace + session identity) before any `agent focus`.
- **Files for coordination, herdr for physics**: text never typed into panes; only control keys (Escape). Completion = our sidecars; liveness = activity snapshots + herdr inventory. Screen scraping is deleted.
- **At-least-once, documented**: ack-write failure may re-apply a request. Document each window with an `AIDEV-NOTE:`.
- ~~**Mux portability**~~ — **REMOVED by user decision.** herdr-only from Phase 4 (TABUX) onward.

## Sequencing & phases (re-sequenced — tab-UX is the new foundation)

Each phase = one commit, repo green at the end (`bun run check`, `node --test` unit suite; integration where called out). Conventional commits: `feat(pi-interactive-subagents): ...`.

| Phase | Content | Tickets | State |
|---|---|---|---|
| 0 | Durable foundation: config + data root + locks | none | ✅ `19b2b76` |
| 1 | Durable result store with semantic refs | PMR-VJPR | ✅ `12bb261` |
| 2 | Request/ack handshake for interrupt | PMR-DNPZ | ✅ `e987ae4` |
| 3 | **Herdr verb layer**: preflight/version gate, send-keys esc, script-file runs, async pane read, shell-marker readiness, focus verbs | PMR-M48Y | next — commit uncommitted work |
| 4 | **Tab spawn rework**: delete other backends, background-tab spawn, widget rows, click-to-open, herdr-only integration suite | **NEW ticket** (proposal below) | after M48Y |
| 5 | ask_owner with mailbox-pump answer delivery | PMR-WXG0 | adapts uncommitted work |
| 6 | Peers ∥ non-blocking upward messaging (two parallel workstreams, separate commits) | PMR-98S6, PMR-QCVA | |
| 7 | worktree:true composed with tab spawn | PMR-11TD | |
| 8 | Durable branch-owned assignments | PMR-Z5KR | |
| 9 | Standalones, any order, own commit each | PMR-874G, PMR-1EC3, PMR-RKH5 | |
| last | Governed distribution (trimmed scope) | PMR-0SWR | |

### Stage-2 aven mutations (only after explicit user approval — NOT part of this plan write)

```
# 1. Create the tab-UX ticket as an epic child of PMR-N65M:
aven create "Herdr-only tab spawn UX: background tabs, status widget rows, click-to-open" --epic PMR-N65M --priority high
# 2. Rewire deps (aven dep add <blocked> <blocked-by>):
aven dep add <TABUX> PMR-M48Y
aven dep remove PMR-WXG0 PMR-M48Y   # WXG0 no longer needs M48Y directly — pane typing is gone
aven dep add PMR-WXG0 <TABUX>       # ask integration tests ride the new spawn/harness
# keep existing: PMR-11TD blocked-by PMR-WXG0; PMR-Z5KR blocked-by PMR-11TD
# no deps: PMR-98S6, PMR-QCVA, PMR-874G, PMR-1EC3, PMR-RKH5, PMR-0SWR
```

Also in stage 2: update ticket descriptions whose sections changed (M48Y, WXG0, 11TD, Z5KR, VJPR/DNPZ get a landed marker, new TABUX ticket body).

## Design: herdr verb layer (PMR-M48Y — the base)

New module `pi-extension/subagents/herdr.ts` (the surviving slice of `cmux.ts`; grows into the only surface module in Phase 4). Port herdsman's `runHerdr` discipline: every call via `pi.exec("herdr", args, {cwd, signal, timeout})`, stdout parsed as herdr's JSON envelope `{id, result}` — no raw CLI scraping.

- **Preflight + version gate**: `herdr status --json` before any spawn; parse `client.version`; require **≥0.9.1** (herdsman's baseline); fail closed with an upgrade hint (`herdr upgrade` path documented). Trust `herdr api schema --json` of the installed binary when verifying a verb's flags — the website tracks 0.9.4.
- **Escape**: `herdr pane send-keys <pane> esc` (canonical name `esc`; no raw byte 27). Backs `subagent_interrupt` — the PMR-DNPZ request/ack handshake stays exactly as landed; only the physical send swaps.
- **Script-file execution**: never paste payloads into panes. Write payload to the artifact dir, execute short command lines only (herdsman's `sendLongCommand` correction; herdr rejects oversized input lines in full).
- **Async pane read**: `herdr pane read <id> --source recent --lines N`; `PaneInfo.scroll.offset_from_bottom === 0` = at-bottom. `agent read <pane> --source recent-unwrapped --format text` without explicit `--lines` for agent output (alternate-screen paging guard). Used for diagnostics only — not completion detection.
- **Shell-readiness marker** (herdsman's spawn hardening): `herdr pane run <pane> echo __READY_<uuid>__` + `herdr pane wait-output <pane> --regex ^<marker>$ --timeout <s>`, retry on `agent_pane_busy` ~2s — proves the fresh tab's shell is interactive before `agent start` (avoids the fresh-shell busy race).
- **Focus verbs**: `herdr agent focus <target>`; `agent list` / `agent get <pane>` for identity verification (used by Phase 4 click-to-open).
- Land the uncommitted M48Y herdr notes here.

## Design: tab spawn + widget + click-to-open (NEW ticket — Phase 4)

### Spawn: background tab, never a visible pane

`launchSubagent()` rework (index.ts + herdr.ts):

1. Preflight (version gate, above).
2. `herdr tab create --workspace <ws> --cwd <cwd> --label <agentLabel> --env K=V --no-focus` → returns root paneId. **`--no-focus` is the background guarantee.** Record `createdTab` on the result for rollback (asymmetric cleanup: a failed start tears down tabs WE created, never user tabs — herdsman's rule).
3. `waitForShellMarker(paneId)` (above).
4. Re-`pane list` and verify pane identity unchanged, then `herdr agent start <alias> --kind pi --pane <paneId> --timeout <ms> -- <pi argv>` where `<pi argv>` is the existing launch command (session file, `-e subagent-done.ts`, model/tools flags). Env vars (PI_SUBAGENT_*, PI_DENY_TOOLS, EPIMETHEUS_ENABLED=false) ride `tab create --env` flags instead of a command prefix.
5. Read back agent session identity for later focus verification (our `PI_SUBAGENT_SESSION` env value is the correlation key; herdr's agent-state sidecar binds it to the pane).

Spawn placement config: default is one tab per agent (herdsman's `subtree` default). No split placement for the owner's view — managed-agent delegation (agent spawning a sub-agent) may later split inside the *child's own* tab (herdsman does this); defer, note as open question. **Claude-CLI children** (`cli: claude`): spawn via `agent start --kind claude` in the same background tab; sentinel-hook completion path unchanged; degraded identity verification (pane + alias only).

**Completion detection rework**: primary = `.exit` sidecar (ours, unchanged). Screen-scrape path in `pollForExit` is **deleted** (the `__SUBAGENT_DONE_<rc>__` echo sentinel goes with it). Crash inference: pane/agent liveness from herdr (`agent list`/`pane process-info`) — agent gone with no `.exit` ⇒ crashed/lost, fail closed (surface as error result; never guess). Drop the `.code` crash-code shell suffix if agent-state liveness covers it cleanly; keep it if the first integration pass shows ambiguity — decide during implementation, `AIDEV-NOTE:` the decision.

### Widget: herdsman row pattern

Rework the existing status widget in `index.ts` to herdsman's `presentation.ts` pattern:

- `ctx.ui.setWidget(name, (tui, theme) => component)` where component = `{ render(width): string[], handleMouse(event), invalidate() }`. 2s presentation tick calling `tui.requestRender()` so **elapsed time ticks without new snapshots**.
- Per-agent row: state marker `●` working, `◐` blocked-asking (PMR-WXG0), `◌` starting, `○` done, `?` unknown, `×` lost — then label, status, elapsed, (context% column arrives with PMR-874G). Header = parent label + nonzero state counts. Width-pressure drop order: task → elapsed → context. Cap 6 ordinary rows + `… N more`. Starting agents shown as transient entries before herdr knows them. Snapshot failure ⇒ header `stale`, last snapshot retained.

### Click-to-open: verify, then focus

- `render()` records `HitRegion[] = {row, from, to, intent}` for rows with a visible label; `handleMouse` matches left-click `row === event.y && from <= event.x < to` only when render width matches event width. Intent carries childId + session path.
- Click action re-verifies before acting (herdsman's `focusTarget` discipline — **status projection is never authorization**): reload running-subagent state; exactly one live child with that childId/session; `herdr agent list` + `agent get <pane>`; require pane/tab/workspace and session identity match. All pass ⇒ `herdr agent focus <paneId>`. Any mismatch ⇒ no command sent, `ctx.ui.notify("Agent changed; reopen the agent list.")` — stale clicks are inert.
- Keyboard fallback: extend the existing `/subagents` command with a Running menu (select agent → same verify + focus path), mirroring herdsman's `/herdsman` → Agents → Running. Mouse-unavailable terminals get the menu.

### Backend deletion

`cmux.ts` dissolves: tmux/zellij/wezterm/cmux detection and code paths deleted; `PI_SUBAGENT_MUX` override removed; `isMuxAvailable()` → herdr preflight; `muxSetupHint()` → herdr install/upgrade hint; `sendCommand`/`sendLongCommand`/`readScreen`/`readScreenAsync` deleted (nothing types text anymore). Public programmatic API exports (`launchSubagent`, `isMuxAvailable`, `muxSetupHint`, `watchSubagent` — used by pi-test-runner) keep their signatures. Integration suite becomes herdr-only: harness detects herdr (env `HERDR_PANE_ID` / `herdr status`), drops the backend matrix; scrape-based assertions replaced by file-based (`waitForFile` on sidecars/activity snapshots) — the pane-width-fragility lesson; widget rendering is unit-tested, not screen-scraped.

## Design: ask_owner answer delivery — mailbox pump, not pane typing (PMR-WXG0 — Phase 5)

The landed WXG0 file-channel core survives: child tool `ask_owner` (sole+final tool call, one outstanding ask), durable ask record + `.ask` sidecar, activity phase `blocked`, watcher does not resolve, `subagent_ask` steer with renderer. **What changes: `answer_subagent` no longer types the reply into the pane.** Herdsman's model:

1. Parent `answer_subagent({id|name, message, askId?})`: validate ask identity (askId + childId + sessionFile) → write durable reply record `asks/<childId>.reply.json` `{askId, message, repliedAt}` (atomic) → clear `.ask`. No pane interaction.
2. **Child-side pump**: `subagent-done.ts` watches for the reply record while its ask is pending (fs.watch + piggyback on the existing 500ms activity-recorder cadence as fallback) and delivers the answer into its own session via child ctx `sendMessage({triggerTurn: true})`. Child continues the SAME session; eventual completion writes `.exit` as today.
3. At-least-once: durable reply record survives a failed pump; a re-pump or resume re-delivers. `AIDEV-NOTE:` the window. Reply-record deletion only after successful child-side ingestion (child writes an ack marker; parent cleanup rides the existing status loop).

This removes the last text-injection dependency (`sendLongCommand`) and the M48Y→WXG0 hard dep. `subagent_interrupt` keeps `pane send-keys esc` as its only physical input (control key, herdsman parity). The uncommitted WXG0 work lands here, adapted: delete any `sendLongCommand` reply path, add the pump, run the ask→answer→complete integration round trip against the new tab harness.

## Where herdsman assumptions do NOT transfer

1. **One-assignment-per-generation vs resumable subagents.** Keep only the sole+final-tool-call rule and one-outstanding-ask-per-child. Drop assignment-generation coupling from ask eligibility.
2. **Owner wake-up over the herdr events socket → our steer channel.** Ours is `sendMessage deliverAs:'steer', triggerTurn:true`. Every new message class (asks, peer relays, owner messages) coalesces/caps per tick (`capStatusLines` precedent).
3. **Pane identity vs our identity.** Correlate on **childId + session jsonl path** (stable, ours). herdr paneId/tabId/workspaceId are display + focus-verification metadata. Never gate message correctness on surface identity.
4. **State projection via herdr inventory.** We derive liveness from sidecars + activity snapshots + herdr liveness for crash inference. Adopt fail-closed `unknown` (no actions, no guesses) without porting herdsman's reconciliation machinery.
5. **Fail-closed ceremony scale.** Fail closed ONLY where a race or data-loss window exists: record writes, claim validation, ack correlation, ref allocation, focus actions. Everything else stays permissive.
6. **Worktree executor.** Direct `git worktree add` / `git worktree list --porcelain` (herdsman shells to git for verification itself). No `herdr worktree` coupling, no `pi-worktree` import (no cross-package runtime deps).

## Guardrails — do not regress (updated)

- ~~**Mux portability**~~ — **REMOVED** (user decision). herdr-only.
- **Focus-safe BACKGROUND spawning**: every spawn is `--no-focus`; the owner's pane is never split, never focused away. The only focus action is the user's explicit click/menu choice, always re-verified.
- **Interactive-vs-autonomous stall silence**: interactive children get no stall steers. `blocked` (asking) is not a stall; snapshots keep flowing with phase `blocked`.
- **`/plan` → aven → implement-plan workflow**: planner/worker/scout agent definitions unchanged except new child-side infrastructure tools in the forced allowlist.
- Repo rules: strict TS + ESM with explicit `.ts` suffixes, Biome, **no ternary expressions**, `AIDEV-NOTE:` anchors, `globalThis[Symbol.for('pi-subagents/...')]` reload resilience for long-lived state (pending-ask registry, hit regions, createdTab ownership).

## Ticket catalog (self-contained for workers — landed tickets first)

### PMR-VJPR — ✅ LANDED (`12bb261`). Durable result store with semantic refs

Results under `getAgentDir()/pi-subagents/results/<canonicalId>.json`, atomic writes; semantic refs `result:<name>#<n>` via exclusive-create reservations (never reused); `subagent_result` steer carries `details.resultRef`/`resultPath` + hidden binding. No further work; downstream tickets (98S6, QCVA) forward refs via the hidden binding.

### PMR-DNPZ — ✅ LANDED (`e987ae4`). Request/ack handshake for subagent_interrupt

Durable control record → `.ack` sidecar → correlated ack or bounded-timeout fire-and-forget fallback. One adaptation lands in M48Y/TABUX: the physical Escape send becomes `herdr pane send-keys <pane> esc`; the handshake itself is untouched.

### PMR-M48Y — Fix herdr mux backend primitives (focus, script-file send, async screen read, Escape)

**What/where/how:** Build `pi-extension/subagents/herdr.ts` as the herdr verb layer per the design section: `runHerdr` JSON-envelope wrapper, `herdr status --json` preflight with **≥0.9.1 version gate** (fail closed, upgrade hint), `pane send-keys esc`, script-file execution pattern, `pane read --source recent`, `agent read --source recent-unwrapped --format text` (no `--lines`), shell-marker readiness (`pane run` echo + `pane wait-output --regex` with `agent_pane_busy` retry), `agent focus`/`agent list`/`agent get`. Wire the herdr backend of the still-existing cmux surface through these primitives; land the uncommitted herdr notes. Verify verb flags against `herdr api schema --json` of the installed binary.

**Acceptance criteria:**
- [x] `runHerdr` parses herdr's `{id, result}` envelope; non-JSON output fails with a clear error (unit test)
- [x] Preflight rejects herdr <0.9.1 and unreachable server with actionable messages (unit test with fixture status JSON)
- [x] Escape via `pane send-keys <pane> esc` reaches a real pane (integration); interrupt handshake (PMR-DNPZ) still passes
- [x] Script-file send + async read verified against a real herdr pane (integration)
- [x] `bun run check` + unit suite green; uncommitted M48Y notes committed

### PMR-TABUX (NEW — create in stage 2) — Herdr-only tab spawn UX: background tabs, status widget rows, click-to-open

**What/where/how:** The Phase-4 design section in full: delete cmux/tmux/zellij/wezterm backends (cmux.ts dissolves into herdr.ts); spawn = `tab create --no-focus` → shell marker → `agent start --kind pi` with our pi argv, env via `--env` flags, `createdTab` asymmetric rollback; widget rework (markers, elapsed 2s tick, row cap, stale header, transient starting entries); click-to-open (hit regions → re-verify childId/session + herdr agent identity → `agent focus`; mismatch inert + notify); `/subagents` Running menu fallback; delete screen-scrape completion (`.exit` primary, herdr liveness for crash inference, fail-closed unknown); integration suite herdr-only with file-based assertions.

**Acceptance criteria:**
- [x] `subagent()` spawns into a background tab; user's pane/tab focus never changes; no visible sibling pane ever appears
- [x] cmux/tmux/zellij/wezterm code paths and `PI_SUBAGENT_MUX` deleted; `isMuxAvailable`/`muxSetupHint`/`launchSubagent`/`watchSubagent` exports keep signatures (pi-test-runner unaffected)
- [x] Widget shows per-agent rows: marker, label, status, elapsed ticking every 2s without new snapshots; row cap + `… N more`; stale header on snapshot failure
- [x] Left-click on a live agent row focuses its tab; stale/wrong-identity click is inert with a notify message (unit-test hit matching + verification gating; integration for real focus)
- [x] `/subagents` menu lists running agents and focuses the selected one through the same verified path
- [x] Screen-scrape completion path deleted; `.exit` sidecar remains primary; crash inference fail-closed (unit test)
- [x] Rollback: failed `agent start` closes tabs the spawn created, never user tabs (unit test the createdTab bookkeeping)
- [x] Integration suite runs herdr-only (backend matrix gone); all assertions file-based or unit-level
- [x] `bun run check` + both suites green

### PMR-WXG0 — Port blocking ask_owner (child asks parent without exiting)

**What/where/how:** The Phase-5 design section: land the uncommitted ask work with **mailbox-pump answer delivery** — child tool `ask_owner` (sole+final tool call, one pending ask, writes `asks/<childId>.json` + `.ask` sidecar, activity phase `blocked`, stays alive); parent observes `.ask` before crash-code, status kind `blocked`, watcher unresolved, `subagent_ask` steer + renderer; `answer_subagent` validates identity → durable reply record → child-side pump (fs.watch + 500ms activity-cadence fallback) delivers via child ctx `sendMessage({triggerTurn:true})` → child acks ingestion → parent cleanup. NO pane typing. Interactive/`session_shutdown` sparing + `resume` cleanup extensions as in the landed draft; claude-CLI children get a clear unsupported error.

**Acceptance criteria:**
- [x] Child `ask_owner` mid-run: process alive (tab open, session not finalized, watcher unresolved); widget row shows `◐ blocked`
- [x] Parent receives `subagent_ask` steer with askId + question; renderer registered
- [x] `answer_subagent` reply reaches the SAME live child session via the pump (no pane input); child acks ingestion; final result via normal `.exit` path
- [x] Second `ask_owner` while pending ⇒ tool error; infrastructure tool, not excludable via deny-tools
- [x] Reply record survives a missed pump (at-least-once); window documented with `AIDEV-NOTE:`
- [x] Blocked ≠ stalled (60s snapshot rule silent — snapshots flow with phase `blocked`); interactive children: no stall-steer regression
- [x] Parent shutdown spares blocked children; `subagent_resume` reattaches to an ask-blocked child
- [x] Integration: ask → answer → complete round trip against tab harness; unit tests for sidecar order + pump; `bun run check` + both suites green

### PMR-98S6 — Peer-to-peer messaging (list_peers/message_peer)

**What/where/how:** Herdsman's peer runtime was designed herdr-free — port nearly as-is: presence records `<dataRoot>/peers/<childId>.json` `{version, childId, sessionId, sessionFile, name, agent, cwd, claim:{pid,id}, updatedAt}` (≤4 KiB, atomic, valid only while its claim is a live Phase-0 lock generation); child tools `list_peers` (scan + claim-filter, self included) and `message_peer({peer, message})` (durable inbox `<dataRoot>/peers/<childId>/inbox/<seq>.json`, ≤8 KiB cap, oversized rejected); recipient drains on its activity-recorder cadence and delivers via its own ctx `sendMessage({triggerTurn:true})`. Registry is user-global. herdr pane/tab ids are optional display metadata only.

**Acceptance criteria:**
- [x] Two concurrent subagents discover each other via `list_peers`; self listed
- [x] `message_peer` delivers to the recipient's session without exiting or blocking the sender
- [x] Killed child ⇒ dead claim ⇒ filtered from `list_peers` (unit test with fake claims)
- [x] ≤8 KiB cap enforced; malformed/stale records filtered, never surfaced
- [x] Result refs from PMR-VJPR forward via hidden bindings between peers (unit test)
- [x] Claim validation + inbox cap unit tests; integration peer round trip; `bun run check` + suites green

### PMR-QCVA — Non-blocking upward messaging: fire-and-forget child-to-parent channel

**What/where/how:** Child tool `message_owner({message})` in `subagent-done.ts`: durable record `<dataRoot>/inbox/<parentSessionId>/<childId>-<seq>.json` `{childId, name, message, sentAt}`, return immediately, no exit, no turn interruption (watcher invariant untouched). Parent session id passed at spawn via `PI_SUBAGENT_PARENT_SESSION` env. Parent drains the inbox on the existing 1s status loop; delivers coalesced `subagent_message` steers (new renderer), capped per tick (`capStatusLines` precedent). Claude-CLI children: clear unsupported error.

**Acceptance criteria:**
- [x] Sender tool returns immediately; child keeps working
- [x] Parent wakes with `subagent_message` steer, coalesced and line-capped
- [x] Durable under busy parent; drained exactly once (unit test)
- [x] Unit tests for drain/coalescing/cap; `bun run check` green

### PMR-874G — Transitive owned cost/token rollup in the status widget

**What/where/how:** Ownership edges from child-session `parentSession` headers + durable assignment records (PMR-Z5KR); parse pi-native usage blocks from each owned session's jsonl (same reader as `getNewEntries`); pure summarizer returning totals + coverage flag when any owned session's usage is unavailable ("Coverage incomplete" — never a guessed number). Widget gains the context%/tokens column reserved by the TABUX row layout.

**Acceptance criteria:**
- [x] Widget shows owned token totals (self + descendants) per agent + aggregate
- [x] Coverage flag when usage unavailable; no invented numbers
- [x] Pure summarizer unit-tested with fixture jsonl; `bun run check` green

### PMR-1EC3 — Context retirement instead of native compaction

**What/where/how:** In `subagent-done.ts`, subscribe to pi's pre-compaction lifecycle event (exact name verified against the installed pi version; herdsman used `session_before_compact` reason `threshold`, ADR 0010): cancel the compaction, mark activity phase `retiring`, inject one-shot guidance via child ctx `sendMessage({triggerTurn:true})` — "converge to a self-contained final result, call `subagent_done`". Second threshold hit falls through to native compaction (never loop-block); manual + emergency compaction untouched. Config gate `contextRetirement.enabled` (default false) in the Phase-0 config schema.

**Acceptance criteria:**
- [x] Parent-side payload retirement: settled `subagent_result`/`ask`/`message` payloads retire to durable refs via the `context` hook, armed by `session_before_compact` (threshold/overflow only, never manual, never cancelled)
- [x] Native compaction never blocked — structural (hook only arms, `context` hook does the rewrite); decision logic pure + unit-tested; off by default (`contextRetirement.enabled`); `bun run check` green
- [ ] ~~Threshold compaction intercepted; child converges and completes~~ DEFERRED to follow-up ticket (child-side convergence — user decision 2026-10-15)

### PMR-11TD — worktree:true on subagent(): compose pane spawn and worktree placement in one step

**What/where/how:** Add `worktree` param (boolean or `{base?: string}`) to the `subagent` tool schema. When set: derive branch name from task/name (slugify + timestamp, ~30 LOC helper; NO `pi-worktree` import, NO `herdr worktree` coupling — direct `git worktree add`), then run the existing TABUX spawn flow with `cwd = worktree path` in the same tool call (`tab create --cwd <worktree>`). Failure of `git worktree add` ⇒ tool error, no tab spawned. Worktree outlives the child; recorded on `RunningSubagent` + `subagents_list`; removal stays manual.

**Acceptance criteria:**
- [x] `subagent({worktree: true})` creates linked worktree + branch and spawns the child (background tab, cwd = worktree) in one call
- [x] Agent discovery + artifacts honor the worktree cwd (existing behavior, verified)
- [x] `git worktree add` failure ⇒ clear error, no tab, no partial state
- [x] `subagents_list` shows worktree + branch; no auto-removal ever
- [x] Branch derivation unit-tested; no cross-package import; `bun run check` green

### PMR-Z5KR — Durable branch-owned assignments (work survives orchestrator death)

**What/where/how:** Persist `RunningSubagent` records `<dataRoot>/assignments/<childId>.json` `{childId, name, agent, sessionFile, paneId, tabId, cwd, worktree?, branch?, status, claim:{pid,id}, createdAt, updatedAt}` (atomic, written at spawn, updated on transitions) — branch-keyed when PMR-11TD ran (herdsman's ProjectAssignment pattern, ADR 0017: authority = the record, not process memory). Tab-world synergy: children live in herdr-owned background tabs, so parent session death naturally leaves them running; this ticket makes authority durable and resumable. New parent's `subagents_list` scans assignments, marks orphans (dead claim) with resume hints; `subagent_resume` reattaches (same tab/pane + session). `session_shutdown` spares children with durable assignments; explicit kill remains. Removal only on verified completion (`.exit` reason done) or explicit remove; ambiguous/missing records fail closed to `unknown`.

**Acceptance criteria:**
- [x] Assignment written atomically at spawn; updated on completion/interrupt/blocked transitions
- [x] Parent restart: `subagents_list` shows prior children as orphaned with resume hints (integration proven); `subagent_resume` reattach to surviving tab DEFERRED to PMR-N53A (integration: spawn, exit parent, relaunch, resume)
- [x] Assigned children spared on parent shutdown; explicit kill works
- [x] Removal only on verified completion or explicit remove (unit test)
- [x] Branch-keyed lookup; ambiguous/missing ⇒ `unknown`, no invented state
- [x] `bun run check` + suites green

### PMR-RKH5 — Governed spawning: spawning: true/false/manager-approval per agent definition

**What/where/how:** Extend agent frontmatter parsing with `spawning: true | false | "manager-approval"` (TypeBox enum; invalid value rejects the definition file). `false` keeps the existing deny behavior (all spawn tools via `PI_DENY_TOOLS`). `"manager-approval"`: model-invoked `subagent()` denied with an error pointing at `/subagent`; user-invoked `/subagent` spawns succeed (user initiation IS the approval — herdsman has no approval mode; do not invent mid-tool confirmation). Default/absent = today's behavior. Allowlist gating discipline from herdsman's `agent-definitions.ts` is the reference.

**Acceptance criteria:**
- [x] `spawning` enum-validated; invalid value rejects the agent file with a clear error (unit test)
- [x] `false`: existing deny behavior unchanged (regression test)
- [x] `manager-approval`: model spawn denied + instructed; `/subagent` user spawn succeeds (unit test the gate)
- [x] Bundled agents unchanged unless configured; `bun run check` green

### PMR-0SWR — Governed distribution (trimmed scope)

**What/where/how:** Mostly out of package scope. Trimmed port: (1) `scripts/package-audit.mjs` equivalent — `npm pack --dry-run` output vs `files` allowlists for every workspace + tarball secret/home-path scan; (2) documented tested pi + herdr version baseline (pairs with the M48Y runtime gate). Checksum-verified artifacts and the container/SSH/Tailscale path explicitly deferred — recommend splitting out of the epic or closing as descoped.

**Acceptance criteria:**
- [x] Audit script fails on allowlist mismatch or detected secrets/home paths
- [x] Tested pi-coding-agent + herdr baselines documented
- [x] Checksums + container path explicitly marked deferred in the ticket
- [x] No runtime code changes

## Testing & commit strategy

- **Per phase**: `bun run check` + `node --test test/test.ts` (+ `test/system-prompt-mode.test.ts`) green; one conventional commit per phase.
- **Unit-first**: pure functions via the `__test__` export pattern; exactly-once paths (ref allocation, claim validation, ack correlation, inbox drain, reply pump, hit-region matching + focus gating) get explicit race/corruption tests.
- **Integration** (`npm run test:integration`, `--test-concurrency=1`, real herdr + real pi + real LLM): herdr-only from Phase 4. Required: TABUX (background spawn, no focus steal, click focus), WXG0 (ask→answer→complete), 98S6 (peer round trip), Z5KR (parent-death/resume), 1EC3 (retirement convergence). **File-based assertions over screen scraping** — `waitForFile` on sidecars/activity; widget logic unit-tested. Scrape-based helpers (`waitForScreen`) deleted with the backends.
- **Manual smoke** before merging Phase 4: background spawn never steals focus; click-to-open works and stale-click is inert; `/subagents` menu path works in a mouse-less terminal.
- **herdr upgrade to ≥0.9.1 before integration runs** (user action; gate verifies at runtime forever after).

## Risks & open questions

| Risk | Impact | Mitigation |
|---|---|---|
| herdr 0.9.0 vs ≥0.9.1 behavior gaps (docs track 0.9.4; some socket methods newer) | Spawn/read verbs behave differently than documented | Verify every verb against `herdr api schema --json` of the installed binary; upgrade before integration; runtime gate fails closed |
| Fresh-tab shell race (`agent_pane_busy`, herdr bug #3208) | `agent start` fails on a not-yet-ready shell | Port herdsman's shell-marker readiness + 2s retry; integration tests exercise real spawns |
| Child model doesn't end its turn after `ask_owner` returns | Reply lands mid-turn as a queued user message | Sole+final-tool-call rule + guidance text; benign worst case |
| Reply pump misses the reply record (fs.watch gap) | Ask answered but child unaware | 500ms activity-cadence fallback poll + durable record (at-least-once); ingestion-ack before cleanup |
| pi API drift (`session_before_compact` name; exports) | PMR-1EC3 / Phase-0 assumptions break | Spike-verify against installed pi version; graceful degrade (config off) |
| Steer-channel flooding from new message classes | Parent turn-loop thrash | Coalescing + per-tick caps designed in (capStatusLines pattern) |
| Deleting backends breaks external consumers (pi-test-runner uses `launchSubagent`) | Silent breakage of sibling tooling | Keep public API signatures; smoke pi-test-runner path in Phase 4 |
| Blocked/orphaned children accumulate in background tabs after parent death | Tab sprawl | Z5KR orphan surfacing + resume hints; explicit kill always available |
| Verbatim copy from Apache-2.0 herdsman without attribution | License hygiene | Reimplement; attribution comment if near-verbatim (lock.ts pattern already landed) |

**Open questions (parked, non-blocking):**
- Managed-agent delegation (child spawning grandchild): split inside the child's own tab (herdsman behavior) vs a new tab? Defer to implementation of nested spawning; default = new tab.
- Does `subagent_resume` reattach to a live pane/tab or always spawn new? Verify during WXG0 walkthrough; reattach capability likely a small addition.
- Drop the `.code` crash-code suffix in favor of herdr agent-state liveness? Decide during TABUX integration pass; `AIDEV-NOTE:` either way.
- Exact new ticket ref for TABUX — assigned at stage-2 creation; this plan calls it PMR-TABUX.
