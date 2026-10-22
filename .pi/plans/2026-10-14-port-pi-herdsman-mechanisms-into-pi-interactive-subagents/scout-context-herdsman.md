# Scout context: porting pi-herdsman coordination mechanisms into pi-interactive-subagents

Source: cloned https://github.com/boadij/pi-herdsman (v0.26.0, Apache-2.0) to `/tmp/pi-herdsman-scout` (shallow, read-only). All paths below relative to repo root.

## Overall repo structure

Pi extension (ESM, zero runtime deps — devDeps only: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, esbuild, prettier, typebox). Everything runs on Node stdlib + Pi's `ExtensionAPI` + the external **herdr** CLI (>=0.9.1) which owns panes/tabs/worktrees/an events unix-socket. herdr is tmux-like: `herdr tab|pane|worktree|workspace <cmd> --json`, JSON result envelope `{id, result}`.

```
extension/
  mailbox.ts        (1056)  durable mailbox: state/request/ask/result records
  storage.ts         (138)  data root, semantic result refs, canonical UUID refs
  lock.ts            (333)  process locks (pid+uuid claims) in OS temp
  supervision.ts    (2718)  roles, chief/manager/peer runtimes, presence, inboxes
  agent-controller.ts (7798) owner-side: delegate/steer/interrupt/close/recovery/health
  lead-runtime.ts  (11219)  lead/manager/chief runtime, project assignments, worktrees
  managed-agent-runtime.ts (2981) child side: ask_owner, request pump, bootstrap
  index.ts          (2269)  root-lead tools: list_peers/message_peer/message_supervisor/staff/project tools
  agent-definitions.ts (1029) markdown definition parsing, governance
  herdr.ts          (2743)  herdr CLI wrapper, spawn/placement, identity verification
  presentation.ts   (3919)  status widget / TUI
  support.ts        (3072)  shared handlers incl. context retirement
  config.ts, errors.ts, core.ts, compatibility.ts
  agent-definitions/*.md    reserved role definitions (chief/manager/leads/agents)
docs/adr/  20 ADRs — the design rationale; read 0001–0010, 0013, 0017, 0019 before porting
docs/concepts, docs/reference      concise spec-level docs per mechanism
scripts/   build, check, smoke, package-audit.mjs (pack allowlist + secret scan)
install.sh (6.3k) version-baseline bootstrap; Dockerfile + docker/ container path
SKILL.md   optional model-facing reinforcement skill (runtime contract is authoritative)
```

Architecture invariant: **owner and child Pi processes never talk directly.** All coordination goes through durable JSON files under `getAgentDir()/pi-herdsman/` (atomic writes, per-record size limits, chmod 700) + OS-temp process locks; herdr supplies only physical identity (pane/session/alias inventory) and liveness events. ~46k LOC implementation, ~63k LOC tests (node:test, colocated `*.test.ts`).

## License / attribution

Apache-2.0 at root. **No per-file license headers, no NOTICE file.** Porting patterns/reimplementation is unrestricted; verbatim code copying requires keeping the Apache-2.0 LICENSE and attribution. The ADRs and docs are the highest-value copying targets (design rationale), and they are ordinary Apache-2.0 content too.

---

## 1. Durable result store + semantic refs

- **Files**: `storage.ts` (whole file), `mailbox.ts` (`ResultRecord`, `writeResult`/`readResult`/`removeResult`), ADR 0001, ADR 0007.
- **How**: Results persisted as files at `<agentDir>/pi-herdsman/results/<requestId>` (canonical UUID). Model-facing handle is a semantic ref `result:<agentLabel>#<n>`; allocation via exclusive-create (`flag:"wx"`) loop over `result-ref-reservations/<label>/<n>` marker files — never reused, allocation scope = data root, *availability* scoped to the caller's current Pi branch. A hidden binding `{ref, canonicalRef}` travels inside every message/attachment payload so a recipient can forward the same semantic ref without seeing the UUID. Refs are passed through the `files` parameter — the single evidence channel — with inline-UTF-8 embedding for small text and canonical path refs otherwise.
- **Size/complexity**: ~400 LOC core (storage 138 + result plumbing in mailbox). Low complexity, high value.
- **herdr deps**: none. Pure fs + `getAgentDir()`. **Fully portable.**

## 2. Peer-to-peer messaging (`list_peers` / `message_peer`)

- **Files**: `supervision.ts` (`peerRuntime()` ~line 1032, `PeerRecord`, presence write/scan), `index.ts` (tool registrations ~line 334, 1728, 2207–2227), docs/reference/peer.md.
- **How**: Each live Lead/Manager publishes a presence record `runtime/peers-v2/peers/<file>` containing `{version, piSessionId, paneId, tabId, workspaceId, cwd, claim:{pid,id}, updatedAt}` (≤4 KiB). The claim ties the record to that session's live process lock — dead/stale/malformed/replaced records are filtered on scan (a record is valid only while its claim is the live lock generation). `list_peers` scans the global dir, returns `self` + peers (session ID only as handle; repo/branch/label are display metadata enriched async). `message_peer` writes a durable inbox message ≤8 KiB (prepared text + hidden result-ref bindings); recipient drains inbox when idle. Deliberately **user-global and herdr-socket-independent** — works across herdr instances.
- **Size/complexity**: ~500–700 LOC including tools. Moderate; the fiddly part is lock-generation validation and async metadata enrichment.
- **herdr deps**: only identity fields (paneId/tabId/workspaceId) which are passthrough metadata — discovery/transport are pure fs + process locks. **Portable nearly as-is** (drop pane/tab fields or repurpose them).

## 3. Blocking `ask_owner` (child asks parent without exiting)

- **Files**: `managed-agent-runtime.ts` (tool def ~line 969, eligibility + record flow ~2130–2210), `mailbox.ts` (`AskRecord`, `pendingAskId` on `ManagedAgentState`, `readPendingAsk`), owner side: `reply_agent` in agent-controller/lead-runtime, docs/reference/ask-owner.md.
- **How**: Every managed agent gets `ask_owner` (infrastructure — cannot be excluded by tool policy). Turn rule: must be the sole+final tool call of the turn. On acceptance: correlated `AskRecord` written, `pendingAskId` set, original `activeRequestId` preserved, child's turn ends, public state projects `blocked`. Question + `files` (with result refs) delivered to the exact direct owner via the owner-session delivery path. Owner answers via `reply_agent {agent, message}` — reply is correlated against askId/requestId/runId/ownerSession/workspace/label/pane/session and fails closed on mismatch. Child clears ask, acks reply, resumes the same assignment. One outstanding ask per assignment; no timeout; settlement disabled while pending. Eligibility gates prevent asking with unresolved children/results.
- **Size/complexity**: The ask/reply protocol itself ~300–400 LOC; entangled with the whole lifecycle runtime (eligibility checks reference direct-agent gating, pending results, control requests).
- **herdr deps**: owner *wake-up* uses the herdr events socket + pane identity; identity correlation uses paneId/session paths. The durable ask/reply record protocol is mailbox-based and portable; the delivery/wake channel must be replaced (in our package, in-process or our own notification path).

## 4. Non-blocking upward messaging (`message_supervisor`)

- **Files**: `index.ts` (tool), `supervision.ts` (`CoordinationMessageRecord`, `drainCoordinationInbox`), `lead-runtime.ts` (manager-side consumption; ADR 0016), docs/reference/supervisor.md.
- **How**: Fire-and-forget durable message child→direct authority (Lead→Manager or Chief; managed Lead→assigned Manager). Validated against *current* authority (assignment record for managed Leads; ambiguous authority fails closed, no routing through intermediaries). Queued ≤8 KiB with prepared attachments/hidden ref bindings; recipient consumes after current run; does not alter assignment state; not deduplicated with automatic result handoff.
- **Size/complexity**: ~300–500 LOC. Simple once the inbox pattern exists (same shape as peer inbox).
- **herdr deps**: minimal — authority validation reads assignment/state files; delivery wake uses herdr events. **Protocol portable.**

## 5. Lifecycle state machine + request/ack handshake (claim/occupancy)

- **Files**: `mailbox.ts` (record schema v5, `lastAck`, `controlMarker`), `lock.ts` (whole file — process locks), `agent-controller.ts` (request pump, ack observation ~3362–3434, close preflights, health scanner), docs/concepts/lifecycle.md, docs/reference/agent-states.md, ADR 0002/0003.
- **How**:
  - *Handshake*: owner atomically writes a `RequestRecord` (steer/interrupt/reply/close) → child claims the per-mailbox assignment lock, validates exact identity (requestId, runId, ownerSession, label, pane), applies (steer = queue at boundary; interrupt = cancel current op + replacement message via `controlMarker` embedded in conversation), writes `state.lastAck {requestId, accepted, code, message}` → owner `waitForState` (fs.watch + timeout) verifies ack identity, then removes request. At-least-once semantics documented (ack-write failure ⇒ possible re-apply). Unacknowledged request blocks close/cleanup (fail-closed).
  - *State projection*: public states `working | blocked | settling | unknown | lost` are a **safe-control projection** over (a) durable mailbox state and (b) herdr physical inventory. `lost` requires *proven* absence of pane+session+alias in a coherent inventory; anything ambiguous = `unknown` with zero actions (fail-closed). `available_tools` per record is the authority for what the model may do; recomputed and revalidated before every mutation.
  - *Ownership*: durable ownership graph (parent session → child mailbox) decides authority; physical visibility grants nothing (ADR 0003).
- **Size/complexity**: the largest item. Handshake + records ≈ 800–1200 LOC liftable; the full controller (recovery, health attention 5m→2m30s→1m15s→1m cadence, close preflights, lost/unknown reconciliation) is thousands of LOC and is the majority of agent-controller.ts (7.8k).
- **herdr deps**: state projection and close/lost preflights lean on herdr inventory (`herdr agent list`, pane process checks, session-file verification via `herdrSessionSnapshot`). `lock.ts` is pure Node (open+fcntl-style claims with `{pid,id}`) — **directly reusable gem**. The handshake protocol is portable; *physical* liveness evidence must be swapped for our runtime's equivalent (child process handle / exit event).

## 6. Worktree placement composed with pane spawn

- **Files**: `herdr.ts` (`startHerdrAgent` 1275–1619, `HerdrStartPlacement {tab|split}`, `selectSplitPlacement`, startup timeout budget, rollback), `config.ts` (`spawnPlacement: "subtree"` — pane placement policy, *not* worktree), worktree creation for project Leads: `lead-runtime.ts` ~6762 (`herdr worktree create --workspace …`, `--base`, verify created branch matches assignment, cwd = `worktree.path`), ADR 0013.
- **How**: Two different things: (a) *pane placement* of managed agents — herdr creates a tab or splits a pane, injects env (`PI_HERDSMAN_*`, structured topology env), runs `pi` with launcher args inside; heavy rollback/diagnostic machinery on startup failure. (b) *worktree placement* for project Leads — Manager's `delegate_project` asks herdr to create a linked git worktree for a branch (optionally from `--base`), then spawns the Lead session with cwd = the new worktree. Composition = one call creates worktree + workspace + pane + session.
- **Size/complexity**: (a) ~400–600 LOC with retry/rollback; (b) ~150–250 LOC around the CLI call + verification.
- **herdr deps**: total for (a); (b) reduces to `git worktree add` + branch bookkeeping we can do directly (herdsman itself shells out to `git worktree list --porcelain` elsewhere). For pi-interactive-subagents (in-process children, no panes) port (b) as "worktree:true creates a worktree then spawns the child with that cwd"; (a) is N/A.

## 7. Durable branch-owned assignments (work survives orchestrator death)

- **Files**: `lead-runtime.ts` (ProjectAssignment write/read/retire ~5900–6900, `resume_project`, `stop_lead`, `remove_worktree`), `supervision.ts` (`assignments` dir), docs/reference/staff.md, ADR 0017/0019/0013.
- **How**: `ProjectAssignment` = durable record keyed by **git branch** naming the exact Lead Pi session; lives under the data root, not in any process. Manager authority = exactly one current assignment naming that session (missing/ambiguous ⇒ fail closed). Survives Manager death: any new Manager process resumes authority from the record. `resume_project branch` relaunches the Lead in the existing worktree; stopped Lead ≠ retired assignment. Retirement only on *verified checkout absence* (`git worktree list --porcelain` cross-checked with herdr worktree inventory) or confirmed `remove_worktree` (interactive "type remove" confirmation, never forced, dirty refused). Every completed managed-Lead turn auto-returns a nonterminal project message to the Manager role.
- **Size/complexity**: ~800–1200 LOC in herdsman, but the core is a small record + occupancy check + retirement reconciliation; much of the bulk is staff tools/presentation.
- **herdr deps**: checkout verification partially (but git porcelain is portable), workspace topology for `open_workspaces`. The assignment-record pattern is **portable**: file keyed by branch + session ID + status(active/paused/conflict).

## 8. Context retirement instead of compaction

- **Files**: ADR 0010, `support.ts` (`registerManagedAgentContextHandlers` ~584–600, `sessionContextRetired`), `agent-controller.ts` (~1641–1709 pre-compact hook, ~5219–5254 retirement notice in result), `lead-runtime.ts` toggle ~2044, config `contextRetirement`.
- **How**: On Pi's native `session_before_compact` with reason `threshold`, cancel the compaction and write a durable retirement marker into session state; inject one-shot retirement guidance (bridged into the next provider request if Pi defers the append, per ADR 0009 prompt-cache rule). Agent finishes current coherent operation and converges to a self-contained final result with full context intact. Retired session is then ineligible for `continue_agent` (follow-up = fresh delegation). Manual compaction unaffected; true overflow still falls through to Pi's native emergency compaction.
- **Size/complexity**: ~150–250 LOC. **Smallest, most portable mechanism** — uses Pi-native lifecycle events we also have.
- **herdr deps**: none beyond being scoped to managed sessions.

## 9. Transitive owned cost/token rollup

- **Files**: `lead-runtime.ts` (Session stats command), `presentation.ts` (owned-usage coverage, ~line 255 "Coverage incomplete"), docs/reference/status-widget.md.
- **How**: Walk the durable ownership graph from the current session; read Pi-native token usage/cost for each owned session (including owned descendants transitively); project a sum plus a coverage flag when some owned sessions' usage is unavailable. Display-only; mailbox stays authority.
- **Size/complexity**: ~150–300 LOC.
- **herdr deps**: none — ownership graph + Pi session usage data. **Portable** if we track the ownership edges (we get them from our own subagent tree).

## 10. Governed spawning

- **Files**: `agent-definitions.ts` (frontmatter schema/validation, layering, `agents` allowlist, `withoutDelegationCapability` ~588, `agentDefinitionDelegationEnabled` ~872), docs/reference/agent-definition-schema.md.
- **How**: Markdown definitions (YAML frontmatter), layered `bundled < project < global`, unknown fields reject, one invalid file fails the whole roster (no silent drops). Governance: a managed agent may delegate only if its effective `agents` list is non-empty AND delegation not opted out (`excludeTools:["agent"]`, `noTools` without `agent` in explicit `tools`, or empty `tools`). `agents` is a closed allowlist of child definition names (each must exist and be `enabled`); disabled/unavailable children prune the parent from runtime discovery. `enabled:false` removes the definition from delegation but never mutates a live assignment. Reserved role profiles (chief/manager/leads) reject delegation-affecting fields. **No `manager-approval` mode exists** — herdsman has only allowlist-true / leaf-false. (Ticket PMR-RKH5's approval mode would be new.)
- **Size/complexity**: parser+validation ~600–800 LOC if the full layering is wanted; the gating logic itself ~100 LOC.
- **herdr deps**: none. **Fully portable**; our package can gate its own `subagent()` tool with the same allowlist shape.

## 11. Governed distribution

- **Files**: `install.sh` (Node >=22.19 baseline, pi/herdr version checks, npm install to ~/.local/bin), `scripts/package-audit.mjs` (npm pack allowlist regex + expected-file sets + secret scans for home paths/tokens), `scripts/container-smoke.sh`, `Dockerfile`+`docker/` (sshd entrypoint, `herdr machine add ssh://…` remote registration, Tailscale compose), `docs/guides/container-deployment.md`, release-please config.
- **How**: Release integrity = documented *tested baselines* + version gates at install/runtime (herdr >=0.9.1 check in `validateHerdrStatus`), not download checksums. Container path = portable SSH-reachable dev container with persistent state volume.
- **Size/complexity**: ops glue, ~1k LOC total across scripts.
- **herdr deps**: the container path is herdr-centric. The reusable piece for us is the **package-audit pattern** (pack allowlist + secret scan — we already do `npm pack --dry-run` verification per AGENTS.md) and version-gate-at-boundary. Low porting value beyond that.

---

## Portable vs herdr-coupled

**Portable (lift nearly as-is; fs + process locks + Pi API only):**
- `lock.ts` process locks with `{pid,id}` claims (333 LOC) — foundation for everything below
- Semantic result store + refs + hidden bindings (1)
- Peer presence registry + peer inbox (2) — designed to be herdr-free
- `message_supervisor` durable inbox (4)
- Request/ack handshake protocol + mailbox record schema (5 protocol half)
- Context retirement via `session_before_compact` (8) — Pi-native
- Cost rollup given an ownership tree (9)
- Governed-spawning allowlist gating (10)
- Branch-keyed assignment record pattern (7 core)

**Herdr-coupled (needs replacement with our runtime's equivalent):**
- Physical spawn into panes/tabs + placement policy + rollback (6a) — N/A for in-process subagents
- Public state projection `working/blocked/settling/unknown/lost` and close/lost preflights (5 projection half) — herdsman uses herdr inventory + session-file verification; we'd use child-process liveness + our own session records
- Owner wake-up / attention events over the herdr events socket (delivery halves of 3 and 4) — replace with our notification path
- herdr worktree create/remove as the worktree executor (6b, 7 retirement) — replace with direct `git worktree` (herdsman already shells to git for verification, so the commands are the same)
- Status widget TUI (presentation.ts) — our own UI

**Biggest gotchas for the port:**
1. Everything assumes *exactly-once* semantics guarded by atomic file writes + exclusive-create + process locks. Dropping any of the three reintroduces races the protocol explicitly fails closed on.
2. Identity is re-validated before *every* mutation (requestId + runId + ownerSession + label + session/pane). Port the discipline, not just the records.
3. Fail-closed `unknown` state (no actions, no guesses) is a deliberate design choice (ADR 0002/0003) — resist "helpfully" inferring state from availability.
4. Semantic ref stability across handoffs (ADR 0001) is an invariant, not an implementation detail: hidden binding must travel with the message, and conflicts must fail closed.
5. Herdsman's `ask_owner`/`reply_agent` are inseparable from its one-assignment-per-generation lifecycle; if our subagents are reusable/multi-turn, the eligibility gates need rethinking rather than copying.
6. Size: do not port agent-controller.ts/lead-runtime.ts wholesale — extract the mailbox/lock/protocol kernels (~2–3k LOC total) and re-derive the rest.
