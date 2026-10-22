# Context for: Port pi-herdsman coordination mechanisms into pi-interactive-subagents

Scout date: 2026-10-14. Package state read from working tree, `@gtheys/pi-interactive-subagents` v3.7.2.

## Relevant Files

All under `packages/pi-interactive-subagents/`:

- `package.json` — name `@gtheys/pi-interactive-subagents`, ESM, `pi.extensions: ["./pi-extension/subagents/index.ts"]`, peerDeps `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox` (devDeps pinned `^0.65.0` while root uses `^0.85.1` — version mismatch worth noting). Scripts: `test` = `node --test test/test.ts`, `test:integration` = `node --test --test-concurrency=1 test/integration/*.test.ts`. `files` allowlist: `pi-extension`, `agents`, `README.md`, `config.json.example`.
- `pi-extension/subagents/index.ts` (2595 LOC) — parent-side extension. Registers tools `subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`; commands `/iterate`, `/subagent`, `/plan`; status widget; message renderers `subagent_result`/`subagent_status`/`subagent_ping`; `launchSubagent()` + `watchSubagent()` + `runWatcher()`; agent-definition discovery/parsing; public programmatic API export (`isMuxAvailable, launchSubagent, muxSetupHint, watchSubagent`) used by e.g. pi-test-runner.
- `pi-extension/subagents/cmux.ts` (1707 LOC) — mux abstraction over `cmux | tmux | zellij | wezterm | herdr`. Backend detection via env (`CMUX_SOCKET_PATH`, `TMUX`, `ZELLIJ*`, `WEZTERM_UNIX_SOCKET`, `HERDR_PANE_ID`) + `PI_SUBAGENT_MUX` override. Key exports: `createSurface`, `createSurfaceSplit`, `sendCommand`, `sendLongCommand` (writes launch script to disk, types path), `sendEscape`, `readScreen`/`readScreenAsync`, `closeSurface`, `pollForExit`, `shellEscape`, zellij pane-placement planners, `PollResult`, `__pollForExitTest__`.
- `pi-extension/subagents/session.ts` — child session jsonl helpers: `seedSubagentSessionFile({mode: 'lineage-only'|'fork', ...})` (writes session header with `parentSession` link; fork copies parent turns up to last user message), `getNewEntries`, `getLeafId`, `findLastAssistantMessage` (with `stopReason:"error"` → `errorMessage` fallback), `appendBranchSummary`, `copySessionFile`, `mergeNewEntries`.
- `pi-extension/subagents/subagent-done.ts` (369 LOC) — CHILD-side extension, loaded in the child via `pi -e <path>`. Registers `caller_ping` and `subagent_done` tools, `alt+j` tools widget, auto-exit logic on `agent_end`, activity-recorder wiring for every lifecycle event, `PI_DENY_TOOLS` enforcement in parent, `exitSidecarPayload()`, `findLatestAssistantError()`.
- `pi-extension/subagents/activity.ts` (665 LOC) — child-written runtime snapshot: `<artifactDir>/subagent-activity/<childId>.json`, `SubagentActivityState` (version, runningChildId, sequence, phase `starting|active|waiting|done`, activeScope, timestamps, latestEvent). Child writes throttled (500ms) + atomic-rename; parent `readSubagentActivityFile` validates `runningChildId` match (wrong-id / missing / invalid reasons).
- `pi-extension/subagents/status.ts` (606 LOC) — parent-side status state machine. `SNAPSHOT_STALLED_AFTER_MS = 60_000`; kinds `starting|active|waiting|stalled|running` (`running` = no-snapshot backends e.g. claude); transitions `'stalled' | 'recovered' | null`; `forceStatusAfterInterrupt`; config loader `loadStatusConfig`.
- `pi-extension/subagents/plugin/hooks/{hooks.json,on-stop.sh}` — Claude Code plugin: Stop hook writes sentinel file (`/tmp/pi-claude-<id>-done`) + transcript pointer for the claude CLI path.
- `agents/*.md` — bundled agent definitions: `planner`, `scout`, `worker`, `reviewer`, `visual-tester`, `claude-code`. Frontmatter-driven.
- `config.json.example` — `{ "status": { "enabled": true } }`. `config.json` is gitignored; `loadStatusConfig()` falls back to the example.
- `test/test.ts` (2904 LOC) — unit tests, `node:test`, importing pure functions plus `__test__` export from index.ts.
- `test/integration/{harness.ts,mux-surface.test.ts,subagent-lifecycle.test.ts}` + `test/integration/agents/` — real-mux, real-LLM lifecycle tests.
- `test/system-prompt-mode.test.ts` — unit test for system-prompt replace/append handling.

## Project Structure

Single extension directory (`pi-extension/subagents/`), no build step (raw `.ts` run by pi directly; explicit `.ts` import suffixes). Parent extension and child extension are two entrypoints of the same package: parent is the package manifest entry, child is loaded per-spawn via `pi -e .../subagent-done.ts`. Agent definitions are markdown files with YAML-ish frontmatter, discovered from three sources with override precedence: project `.pi/agents/` > global `~/.pi/agent/agents/` (actually `PI_CODING_AGENT_DIR ?? ~/.pi/agent`) > package-bundled `agents/`.

No cross-package runtime imports. Sibling `packages/pi-worktree` is the existing worktree integration (herdr worktree tool: `create`/`list`/`remove`, branch derivation, dep bootstrap, `.env` snapshot, dirty-checked removal, dashboard of worktree × pi agent state). Its README already documents the manual composition path: "spawn a subagent with `cwd` set to the worktree path" — that is what PMR-11TD would make atomic.

## Core Architecture (spawn → run → result)

1. **Spawn.** `subagent` tool executes: blocks self-spawn (params.agent === `PI_SUBAGENT_AGENT` env), requires mux + session file, then `launchSubagent()`:
   - Resolves agent defaults from frontmatter: `model`, `thinking`, `tools`, `skills`, `deny-tools`, `spawning`, `auto-exit`, `interactive`, `session-mode` (`standalone|lineage-only|fork`), `system-prompt` (`append|replace`), `cwd`, `cli` (`claude`), `body` (role identity text), `disable-model-invocation`.
   - Session mode: `fork: true` param forces fork; otherwise agent frontmatter; default `standalone`. fork/lineage-only seed the child session file (`parentSession` header; fork also copies parent turns). Task delivery: fork = direct CLI arg; standalone/lineage-only = artifact file (`@<artifactPath>` positional).
   - Creates mux pane (`createSurface`), waits `PI_SUBAGENT_SHELL_READY_DELAY_MS` (default 500).
   - Command: `pi --session <pre-created jsonl> -e <subagent-done.ts> [--model m[:thinking]] [--system-prompt|--append-system-prompt <file>] [--tools <allowlist + caller_ping,subagent_done>]` + env prefix: `PI_CODING_AGENT_DIR` (local `.pi/agent` of target cwd wins), `PI_DENY_TOOLS`, `EPIMETHEUS_ENABLED=false`, `PI_SUBAGENT_NAME/AGENT/AUTO_EXIT/SESSION/ID/ACTIVITY_FILE/SURFACE`. Appends `crashCodeSuffix()`: `; __rc=$?; echo "__SUBAGENT_DONE_${__rc}__"; echo "$__rc" > <sessionFile>.code`.
   - Claude CLI path (`cli: claude` frontmatter): separate command builder, sentinel file, `--plugin-dir` hooks, transcript copy into `~/.pi/agent/sessions/claude-code/`.
   - Registers `RunningSubagent` in a `globalThis` Map (survives `/reload` via `Symbol.for` keys; watchers re-attach on module re-import).
2. **Run observation.** Child extension (`subagent-done.ts`) hooks every pi lifecycle event into the activity recorder → throttled JSON snapshot file. Parent runs two 1s intervals: widget refresh + `startStatusRefresh` (observe snapshots → `advanceStatusState` → transitions).
3. **Completion detection.** `pollForExit(surface, signal, {interval:1000, sessionFile, sentinelFile})` per tick: (a) `<sessionFile>.exit` sidecar `{type:'done'|'ping'|'error'}` — primary path, written by `subagent_done`, `caller_ping`, or the auto-exit branch of `agent_end`; (b) claude sentinel; (c) `<sessionFile>.code` crash code (SIGKILL/OOM); (d) slow path screen scrape for `__SUBAGENT_DONE_<rc>__` sentinel (30-row window; ponytail note: sidecar is primary now).
4. **Result delivery.** `runWatcher()` promise → summary = last assistant message of child session jsonl (error-message fallback; resume flow re-extracts only `resumeEntryCount`-onward entries) → `pi.sendMessage({customType:'subagent_result'|'subagent_ping', ...}, {triggerTurn: true, deliverAs: 'steer'})`. Stall/recovered transitions aggregate into `subagent_status` steer messages (capped line list). All three have registered TUI renderers.
5. **Interrupt.** `subagent_interrupt({id|name})` → `sendEscape(surface)` to child pane = cancels current model turn only; pane/session/watcher survive; `forceStatusAfterInterrupt` immediately marks waiting; Pi-backed only (claude returns error).
6. **Stall detection.** Child snapshot absent/invalid/wrong-id for 60s ⇒ `stalled`; valid snapshot again ⇒ `recovered`. Steered to parent unless subagent is `interactive`.
7. **Interactive vs autonomous.** `resolveEffectiveInteractive`: explicit tool param > agent `interactive` frontmatter > inverse of `auto-exit`. Interactive: no stall steers; pane spared on `session_shutdown` (autonomous orphans are killed).
8. **caller_ping (current = blocking-ish).** Child tool writes `{type:'ping'}` sidecar and `ctx.shutdown()` — the child **exits** to ask. Parent gets `subagent_ping` steer incl. session path; continuation happens via `subagent_resume({sessionPath, message, autoExit})` in a NEW pane. This is exactly what PMR-WXG0 (herdsman ask_owner: ask parent without exiting) replaces, and PMR-QCVA (non-blocking upward channel) extends.

## Existing Mechanisms vs. Requested Ports

| Aven ticket | Current state in package |
|---|---|
| PMR-WXG0 ask_owner (ask without exiting) | `caller_ping` exists but kills the child; resume = new pane, `subagent_resume`. Ask-without-exit does not exist. Sidecar `.exit` protocol + `pollForExit` reason enum (`done\|ping\|sentinel\|error`) is the natural extension point. |
| PMR-98S6 peer-to-peer (list_peers/message_peer) | None. Only parent↔child channel (sidecar files + steer). No peer registry. `runningSubagents` Map is parent-side only; children know nothing about siblings. |
| PMR-VJPR durable result store | Results live only in steer message text + child session jsonl path (in `details.sessionFile`). No durable result artifact, no semantic refs. Artifact dir convention exists: `<sessionDir>/artifacts/<sessionId>/` (task files, sysprompts, launch scripts, activity files). |
| PMR-QCVA non-blocking upward messaging | `caller_ping` is exit-based; no fire-and-forget child→parent channel. Parent wake machinery (`sendMessage deliverAs:'steer', triggerTurn:true`) already exists and is proven. |
| PMR-874G transitive cost/token rollup | Zero cost/token code anywhere in package (grep confirms). Status widget shows elapsed + status label only. Greenfield. |
| PMR-1EC3 context retirement | No compaction/retention logic. Child sessions grow unbounded; `getNewEntries`/`findLastAssistantMessage` read whole files. Greenfield. |
| PMR-DNPZ lifecycle state machine + request/ack | Partial: `status.ts` is a real state machine for activity/liveness (starting/active/waiting/stalled + stalled/recovered transitions), but there is NO ack handshake for steer/interrupt/complete — interrupt is fire-and-forget Escape, completion is sidecar polling. |
| PMR-11TD worktree:true on subagent() | `subagent({cwd})` exists (with agent-frontmatter default + local `.pi/agent` discovery). No worktree param. Sibling `pi-worktree` does placement/herdr workspace creation; subagent package does not import it (no cross-package runtime deps per repo convention). |
| PMR-Z5KR durable branch-owned assignments | Watcher state is in-memory (`globalThis` Map). Parent death (`session_shutdown`) kills autonomous child panes; interactive panes survive but nothing durable records assignments. Greenfield. |
| PMR-RKH5 governed spawning | Partial: `spawning: false` frontmatter ⇒ all of `subagent|subagent_interrupt|subagents_list|subagent_resume` denied via `PI_DENY_TOOLS` env (honored only in child sessions); `deny-tools` fine-grained; `disable-model-invocation` hides from `subagents_list`; parent blocks self-spawn by agent name. No `manager-approval` flow. |
| PMR-0SWR governed distribution | Out of package scope; repo-level release/npm concerns. |

## Conventions

- Strict TS, ESM, explicit `.ts` import suffixes. Biome formatting (no manual reformat). **No ternary expressions** — `if/else` assignments throughout (repo rule).
- `AIDEV-NOTE:` anchor comments at tricky spots (reload resilience, stale ctx, sidecar reasons) — preserve/extend when editing.
- `/reload` resilience pattern: module state shared via `globalThis[Symbol.for('pi-subagents/...')]`; top-level reset block aborts old timers; watchers re-attach in `subagentsExtension()`. Any new long-lived state (peer registries, result stores) must follow this or die on `/reload`.
- Delivery-to-parent pattern: `pi.sendMessage({customType, content, display, details}, {triggerTurn: true, deliverAs: 'steer'})` wrapped in try/catch (stale ctx must never crash host).
- Result objects are plain interfaces (`SubagentResult`, `PollResult`); tool schemas are TypeBox (`Type.Object`) → `Static<typeof>`.
- Test hooks: exported `__test__` object (index.ts) and `__pollForExitTest__` (cmux.ts) expose internals to unit tests.
- Child↔parent communication is file-based sidecars (`<session>.exit`, `<session>.code`, activity JSON) + env vars at spawn — no sockets, no pi-internal APIs.

## Config Patterns

- **Does NOT follow the repo's newer extension-config convention**: no `getAgentDir()`/`CONFIG_DIR_NAME`, no `pi-subagents/` config dir, no TypeBox config schema, no `config.schema.json`. Status config is read from `join(PACKAGE_ROOT, 'config.json')` (gitignored) with `config.json.example` fallback; validation is hand-rolled (`requireObject`/`requireBoolean`/`rejectUnsupportedKeys`) over `JSON.parse → unknown`. TypeBox is used only for tool parameter schemas.
- Agent dir resolution: `process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')` — local helper `getAgentConfigDir()`, not pi's `getAgentDir()` (repo AGENTS.md prefers the latter; pre-existing divergence).
- Spawn-time "config" is env vars + agent markdown frontmatter, not JSON config.
- Env vars inventory: `PI_SUBAGENT_MUX`, `PI_SUBAGENT_SHELL_READY_DELAY_MS`, `PI_SUBAGENT_NAME`, `PI_SUBAGENT_AGENT`, `PI_SUBAGENT_AUTO_EXIT`, `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_ACTIVITY_FILE`, `PI_SUBAGENT_SURFACE`, `PI_DENY_TOOLS`, `EPIMETHEUS_ENABLED=false` (deliberate: Hindsight memory disabled in children).

## Test Setup

- Unit: `node --test test/test.ts` (single 2904-line file, plus `test/system-prompt-mode.test.ts`). Pure-function coverage: cmux parsing/placement, session jsonl helpers, status state machine, sidecar payloads, agent-definition parsing, widget rendering, `__test__`-exported helpers. No test framework deps — `node:test` + `node:assert/strict`.
- Integration: `npm run test:integration` — `--test-concurrency=1`, real mux surfaces + real `pi` sessions + real LLM (default `PI_TEST_MODEL=anthropic/claude-haiku-4-5`, ~$0.01–0.05/test, 30–90s each). `harness.ts` detects available backends, builds isolated temp envs with test agent defs, `waitForFile`/`waitForScreen` polling, surface cleanup. Skips with a notice when no mux backend available. New lifecycle-ish features (ask_owner, peers, ack handshake) have an existing home here.

## Gotchas

- **Child exit = the universal signal.** Every completion path (`subagent_done`, auto-exit, `caller_ping`, crash) ends with the child process dying and a sidecar/code file. Anything that lets a child keep living (ask_owner, non-blocking pings, peer messaging) breaks the invariant that "watcher promise resolves ⇒ pane closes". `runWatcher` closes the surface and deletes the Map entry on resolve — reworking PMR-WXG0/QCVA means decoupling "deliver message to parent" from "child exited".
- **`interactive` semantics are notification-level, not focus/lifecycle-level** — but `session_shutdown` DOES kill non-interactive panes. New message channels must decide which class of child they target.
- Parent wake = steer with `triggerTurn:true`. Flooding this channel (e.g. per-peer messages, fire-and-forget pings) has no rate limiting/coalescing today; `subagent_status` has `capStatusLines` coalescing as the only precedent.
- Session jsonl parsing is line-based JSON with no schema validation; fork seeding truncates at last user message and strips `session` entries. Durable result refs (PMR-VJPR) will interact with resume (`resumeEntryCount` new-only extraction) and fork seeding.
- The `.exit` sidecar is deleted on read (`rmSync` in `pollForExit`) and the auto-exit path refuses to overwrite an existing sidecar — ordering between `caller_ping`/`subagent_done`/error-exit writes matters.
- `resume` clears stale `.exit`/`.code` before relaunch; any new sidecar family must be added to that cleanup.
- devDependency version skew: package devDeps `^0.65.0` vs root `^0.85.1` of pi-coding-agent — integration tests run against whatever resolves in the workspace.
- `subagent-done.ts` is loaded per-child via absolute path from `SUBAGENTS_DIR` (`import.meta.url`) — path-coupled to package layout under `pi-extension/subagents/`.
- Claude-backed subagents are a parallel, weaker path (sentinel scraping, no activity snapshots, no interrupt). Ports that touch completion/status must handle `cli === 'claude'` or explicitly scope to Pi-backed.
