# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn a team of AI agents that work in background tabs while you keep coding. Ask them questions mid-run, let them ask *you*, give them their own git worktrees, and never lose track of a run — even if your parent session dies.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## Why

Orchestrating agents usually means one of two bad deals: **block** your main session while a child runs, or **fire and forget** and lose the thread. This extension takes a third path, ported from [pi-herdsman](https://github.com/boadij/pi-herdsman) (see [Acknowledgements](#acknowledgements)):

- **Never blocks.** `subagent()` returns in milliseconds. The child runs in a background [herdr](https://github.com/pi-edubot/herdr) tab; your pane, focus, and flow never move.
- **Never loses work.** Results, assignments, and control messages are durable files, not screen scrapes. Kill the parent, relaunch, and `subagents_list` rediscovers every orphaned child — with a resume hint.
- **Talks both ways.** Children can ask blocking questions (`ask_owner`), send fire-and-forget updates (`message_owner`), and message *each other* (`message_peer`). The parent answers with `answer_subagent` and the conversation continues **in the same child session**.

## How it works

```
1. Agent calls subagent()         → returns immediately ("launched in background")
2. Child runs in a herdr tab      → widget shows live status + activity + cost
3. You keep working               → main session fully interactive
4. Child finishes                 → result steered back, parent wakes and continues
```

The widget above your input tracks every run — click a row to open that agent's tab:

```
╭─ Subagents ───────────────────────────── 2 running · 41.2k tok $0.18 ─╮
│ ● Scout: Auth (scout)         active (bash 12s) · 12.3k tok $0.04    │
│ ● Worker: migrations (worker)          waiting 2m · 28.9k tok $0.14  │
╰────────────────────────────────────────────────────────────────────────╯
```

States: `starting` → `active` (with the current tool and elapsed time) → `waiting`, plus `stalled` when a child's heartbeat goes silent — and a steer to the parent so it can react. Status comes from a child-written snapshot file, never from watching screen pixels.

## The flows

### Parallel scouting

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately; results steer back independently as they land.
```

### A child that asks before it acts

```typescript
// Inside the child:
ask_owner({ question: "Two migration files conflict — use v1 or v2?" });
// Child blocks (widget: "blocked"). Parent wakes with the question, answers:
answer_subagent({ name: "Worker", message: "Use v2, v1 is deprecated" });
// Answer arrives as the child's next user message — same session, full context.
```

Answers travel through a durable mailbox (`asks/` records + reply sidecars), not pane typing — nothing gets mangled, and ingestion is acknowledged on both ends.

### Non-blocking updates from the trenches

```typescript
// Inside the child — fire-and-forget, keeps working:
message_owner({ message: "Schema scan done, 3 hotspots found, moving to API layer" });
// Parent's next status tick delivers a coalesced subagent_message steer.
```

### Peer-to-peer

Sibling subagents discover each other through presence files and talk directly:

```typescript
list_peers();                                    // who else is running?
message_peer({ peer: "scout-auth", message: "Found the session store — stop looking" });
```

### Isolated worktrees, one call

```typescript
subagent({
  name: "Worker: payments",
  agent: "worker",
  worktree: true,   // or { base: "release/2.4" }
  task: "Implement the refund flow",
});
// git worktree add → child spawned with cwd = the new worktree.
// Your checkout is untouched; the branch and path ride along in the result.
```

### Surviving the crash

Every spawn writes a durable assignment record. Parent dies? Relaunch pi and:

```typescript
subagents_list();
// ● scout-auth — ORPHANED (parent gone). Resume: subagent_resume({ sessionPath: "…" })
```

Children with records are deliberately **spared** when a parent shuts down. Completed runs settle into a durable result store; crash-inferred endings are marked `lost` — never invented state.

### `/iterate` and `/plan`

- `/iterate Fix the off-by-one in pagination` — forks your full conversation into a subagent, keeps your main context clean.
- `/plan Add dark mode` — orchestrates investigate → plan → execute → review with bundled agents (`planner`, `scout`, `worker`, `reviewer`, `visual-tester`).

## Feature tour

| Feature | What you get |
| --- | --- |
| **Background tabs** | `tab create --no-focus` — children never steal your screen; click widget rows to visit them |
| **Durable results** | Semantic refs (`results/<childId>.json`) — full output survives compaction and restart |
| **Request/ack interrupts** | `subagent_interrupt` confirms the child actually stopped its turn |
| **Usage rollup** | Live per-row `· 12.3k tok $0.04` in the widget, transitive tree totals in `subagents_list` |
| **Context retirement** | Opt-in (`contextRetirement.enabled`): settled child payloads shrink to refs under compaction pressure — long orchestrations stop bloating the parent context |
| **Governed spawning** | `spawning: manager-approval` frontmatter: the model can't spawn that agent on its own — your `/subagent` command is the approval |
| **Version gate** | Preflight rejects herdr < 0.9.1 with an actionable message instead of weird failures |

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

Requires [herdr](https://github.com/pi-edubot/herdr) >= 0.9.1 (tested against 0.9.5 and pi-coding-agent 0.85.1):

```bash
herdr pi
```

---

## Reference

### Tools

Main session:

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a background tab (async — returns immediately) |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn (ack-confirmed) |
| `subagents_list` | Agent definitions **and** live assignment records (running / orphaned / lost, usage, resume hints) |
| `subagent_resume` | Resume a previous sub-agent session (async) |
| `answer_subagent` | Answer a child's outstanding `ask_owner` question |

Subagent-side (auto-injected, never deniable):

| Tool | Description |
| --- | --- |
| `subagent_done` | Finish and return results to the parent |
| `caller_ping` | Ask for help and exit — parent resumes the session with guidance |
| `ask_owner` | Blocking question to the parent; answer arrives in the same session |
| `message_owner` | Fire-and-forget update to the parent |
| `list_peers` / `message_peer` | Discover and message sibling subagents |

### Commands

| Command | Description |
| --- | --- |
| `/plan` | Planning pipeline — create-plan (Jira ID) / feature-plan (free text) / bundled generic workflow |
| `/iterate` | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly (user-initiated — bypasses `manager-approval` gates) |
| `/subagents` | Open the subagent dashboard |

### `subagent()` parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | required | Display name (widget + tab label) |
| `task` | string | required | Task prompt for the sub-agent |
| `agent` | string | — | Load defaults from an agent definition |
| `fork` | boolean | `false` | Force full-context fork for this spawn |
| `worktree` | boolean \| `{base?}` | `false` | Spawn in a fresh git worktree (`~/.herdr/worktrees/<repo>/<branch>`); removal is manual |
| `interactive` | boolean | derived | Don't wake the parent on stall/recovery (default: inverse of `auto-exit`) |
| `model` | string | — | Override agent's default model |
| `systemPrompt` | string | — | Append to system prompt |
| `skills` | string | — | Comma-separated skill names |
| `tools` | string | — | Comma-separated tool names |
| `cwd` | string | — | Working directory (mutually exclusive with `worktree`) |

### Bundled agents

| Agent | Model | Role |
| --- | --- | --- |
| **planner** | Opus (medium thinking) | Brainstorming, plans, todos |
| **scout** | Haiku | Fast codebase reconnaissance |
| **worker** | Sonnet | Implements tasks, runs tests |
| **reviewer** | Opus (medium thinking) | Bugs, security, correctness |
| **visual-tester** | Sonnet | Visual QA via Chrome CDP |

Discovery precedence: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **bundled**.

### Agent frontmatter

Full field reference with defaults, valid values, and recipes: [`docs/agent-frontmatter.md`](../docs/agent-frontmatter.md).

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
tools: read, bash, edit, write
session-mode: lineage-only
spawning: manager-approval
auto-exit: true
---

You are a specialized agent that does X...
```

| Field | Description |
| --- | --- |
| `session-mode` | `standalone` (default), `lineage-only` (linked, no copied turns), `fork` (inherits conversation) |
| `spawning` | `true` (default), `false` (deny spawn tools), `"manager-approval"` (model calls denied; `/subagent` is the approval) |
| `deny-tools` | Comma-separated extension tools to deny |
| `auto-exit` | Shut down when the turn finishes; any user input disables it permanently |
| `interactive` | Override stall-ping behavior (default: inverse of `auto-exit`) |
| `cwd` | Default working directory |
| `disable-model-invocation` | Hide from listings; still invokable by explicit name |

### The `/plan` workflow

```
/plan IMP-7070                → create-plan skill (Jira flow)
/plan Add a dark mode toggle  → feature-plan skill / bundled generic workflow
```

Generic pipeline: investigate → interactive planning → todo review → execute → review, with tab titles tracking the phase (`🔍 → 💬 → 🔨 1/3 → 🔎 → ✅`).

### Interrupt semantics

`subagent_interrupt` is a **turn-level** interrupt, not a kill: Escape is delivered to the child, the `.ack` handshake confirms the turn stopped, the widget moves to `waiting`, and the session stays alive for follow-ups. Pi-backed children only.

### caller_ping — the escalator

```typescript
// Inside a worker subagent:
caller_ping({ message: "Found two conflicting migration files — v1 or v2?" });
// Session EXITS. Parent gets the ping and resumes the session with guidance:
subagent_resume({ sessionPath: "…", message: "Use v2 — v1 is deprecated" });
```

Unlike `ask_owner` (blocks, stays alive), `caller_ping` ends the session — use it when the child is done until further notice.

## Configuration

Config lives at `~/.pi/agent/pi-subagents/config.json` (created with defaults on first run).

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `status.enabled` | boolean | `true` | Live status widget and refresh loop |
| `contextRetirement.enabled` | boolean | `false` | Retire settled subagent payloads to durable refs when compaction pressure hits |

```json
{
  "$schema": "https://json-schema.org/schema",
  "status": {
    "enabled": true
  },
  "contextRetirement": {
    "enabled": false
  }
}
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- [herdr](https://github.com/pi-edubot/herdr) >= 0.9.1

## Acknowledgements

The coordination architecture — durable file-based channels (results, assignments, mailboxes), blocking `ask_owner` semantics, presence and peer messaging, usage rollup, context retirement, and governed spawning — is ported from **[pi-herdsman](https://github.com/boadij/pi-herdsman)** by [@boadij](https://github.com/boadij) (Apache-2.0). Herdsman proved these mechanisms in production; this package re-implements them on herdr's tab model with pi-native session files as the authority. Thank you for the blueprint.

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

## License

MIT
