---
name: subagent-orchestration
description: Orchestrate background subagents effectively with pi-interactive-subagents. Use when a task benefits from parallel exploration, isolated implementation, long-running background work, or when you need to decide between ask_owner / caller_ping / message_owner, worktree:true, or resuming orphaned children. Trigger on "spawn agents", "parallel research", "background task", "delegate", "fan out", or when multiple independent investigations/implementations could run concurrently.
---

# Subagent orchestration

The `subagent` tool returns immediately — children run in background herdr tabs.
The widget above the input shows live status, current activity, and token/cost
per child. Results steer back automatically; never poll or sleep waiting for
them — keep working or end your turn, the harness wakes you.

## When to spawn

- **Independent investigations** → fan out `scout` agents in parallel, one per
  area. Synthesize when results steer back.
- **Implementation while you continue** → `worker` in the background; review
  when the result lands.
- **Dirty or risky changes** → `worktree: true` so the child gets its own git
  worktree and your checkout stays clean.
- **Long-running watches** (test loops, deploy monitors) → background child +
  `message_owner` updates.

## Choosing the communication channel

| Situation | Tool |
| --- | --- |
| Child needs an answer to proceed | `ask_owner` (blocks child; parent answers with `answer_subagent`; same session continues) |
| Child is done until further notice / stuck hard | `caller_ping` (child EXITS; parent resumes the session with guidance) |
| Progress note, no answer needed | `message_owner` (fire-and-forget) |
| Sibling coordination | `list_peers` + `message_peer` |
| Parent wants to stop a turn | `subagent_interrupt` (turn-level, ack-confirmed; session survives) |

## Rules of thumb

- Batch spawns: call `subagent` multiple times in one turn for true parallelism.
- Trust durable state, not screens: results, assignments, asks, and inboxes are
  files under the extension data root; they survive parent restarts.
- After a parent restart, run `subagents_list` — orphaned children appear with
  `subagent_resume` hints. Resume them instead of respawning from scratch.
- Respect `spawning` frontmatter: `manager-approval` agents can only be started
  by the user via `/subagent <agent> <task>` — don't retry denied `subagent()`
  calls; tell the user the command to run instead.
- `fork: true` only when the child genuinely needs the parent's conversation
  context — it costs tokens on every spawn.
