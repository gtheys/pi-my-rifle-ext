# Agent definition frontmatter reference

Every pi-subagents agent is a markdown file with YAML frontmatter and a body.
This document lists every field the loader reads, what it does, its default,
and what to put in it. Source of truth:
`packages/pi-interactive-subagents/pi-extension/subagents/index.ts`
(`parseAgentDefinition` and the spawn path).

## Where files live

| Location | Source label | Wins over |
| --- | --- | --- |
| `packages/pi-interactive-subagents/agents/` | bundled | nothing |
| `~/.pi/agent/agents/` | global | bundled |
| `<repo>/.pi/agents/` | project | global + bundled |

Discovery merges by `name`. A same-named file in a later location fully
replaces the earlier one — field by field, not per-key. `pi-test-runner`
installs its bundled `test-runner.md` into the global dir on first use and
never overwrites an existing copy.

## Quick example

```markdown
---
name: worker
description: Implements tasks from todos - writes code, runs tests
tools: read, bash, write, edit
deny-tools: claude
model: zai/glm-5.3-flash
thinking: minimal
spawning: false
auto-exit: true
system-prompt: append
---

You are a code implementation specialist. ...
```

## Field reference

### `name`

- **Type:** string. **Default:** filename without `.md`.
- Identity for `subagent({ agent: "..." })`, `/subagent <name>`, and the
  discovery merge. Fill with a lowercase, hyphenated role name. Must be unique
  across the layers you use, or you are overriding another agent.

### `description`

- **Type:** string. **Default:** none.
- Shown in listings and read by the orchestrating model when it picks an
  agent. Fill with one sentence: what the agent does and when to use it.

### `model`

- **Type:** string. **Default:** pi's default model for the child session.
- Passed as `--model` to the child. Fill with a `provider/model-id` that
  exists in `~/.pi/agent/models-store.json` (e.g. `zai/glm-5.3-flash`,
  `kimi-coding/k3`, `github-copilot/claude-haiku-4.5`,
  `anthropic/claude-sonnet-4.6`). For `cli: claude` agents, Claude CLI model
  aliases (`sonnet`, `opus`) are also valid. A wrong ID does not fail the
  spawn — the child silently falls back to its default. Verify before use:

  ```bash
  grep -c 'claude-sonnet-4.6' ~/.pi/agent/models-store.json   # 0 = missing
  ```

  A spawn-time `model:` tool parameter overrides this.

### `thinking`

- **Type:** string. **Default:** the model's own default.
- Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
  The loader joins it onto the model argument (`model:thinking`); pi limits
  the effective level to what the model supports. Fill with `minimal` for
  cheap fast workers, `medium` for planning/review roles.

### `tools`

- **Type:** comma-separated string. **Default:** all tools.
- Becomes the child's `--tools` allowlist. Entries are exact tool names or
  `*` wildcard patterns; pi matches both (e.g. `mcp__codegraph__*`).
  Fill with the minimum set the role needs: `read, bash` for a scout,
  `read, bash, write, edit` for an implementer. Six control tools are always
  added on top, whether you list them or not: `caller_ping`, `subagent_done`,
  `ask_owner`, `message_owner`, `list_peers`, `message_peer`. A spawn-time
  `tools:` parameter overrides this.

### `deny-tools`

- **Type:** comma-separated string. **Default:** none.
- Removes tools from the child on top of any allowlist. Typical use:
  `deny-tools: claude` to prevent nested Claude runs. The six control tools
  above can never be denied. `spawning: false` additionally denies all four
  spawn tools (`subagent`, `subagent_interrupt`, `subagents_list`,
  `subagent_resume`).

### `spawning`

- **Type:** `true` | `false` | `manager-approval`. **Default:** `true`.
- `false`: the child cannot spawn subagents of its own (spawn tools denied).
- `manager-approval`: model-invoked spawns are refused with instructions to
  ask the user; a human running `/subagent <name> <task>` is the approval.
- An invalid value rejects the entire file with a console warning — the agent
  disappears from listings. The three values above are the only accepted ones.

### `auto-exit`

- **Type:** boolean (`true`/`false`). **Default:** `false`.
- `true`: the child is autonomous — it finishes its turn and exits, and gets
  stall pings when its heartbeat goes silent. `false`/omitted: the child is
  interactive — it stays alive waiting for `subagent_done` or user input in
  its pane, and status transitions do not wake the parent.

### `interactive`

- **Type:** boolean. **Default:** inverse of `auto-exit`.
- Explicit long-running marker. Usually omit it: `auto-exit: true` already
  implies `interactive: false`. A spawn-time `interactive:` parameter wins
  over both this and `auto-exit`.

### `system-prompt`

- **Type:** `append` | `replace`. **Default:** none.
- Controls where the body goes. `append`: body is layered onto pi's default
  system prompt (`--append-system-prompt`) — the normal choice for role
  prompts. `replace`: body becomes the entire system prompt. Omitted: the
  body is prepended to the first task message instead (weaker identity, but
  works). `cli: claude` children always get the body appended, regardless of
  this key.

### `skills` (alias `skill`)

- **Type:** comma-separated string. **Default:** none.
- Each entry is injected into the child's prompt as a `/skill:<name>` line.
  Fill with skill directory names that exist in the child's discovery paths
  (`~/.pi/agent/skills/`, `<repo>/skills/`, `<repo>/.pi/skills/`...). A name
  that resolves to nothing produces a dead instruction — verify the directory
  exists before adding.

### `session-mode`

- **Type:** `standalone` | `lineage-only` | `fork`. **Default:** `standalone`.
- `standalone`: fresh session, artifact-backed task handoff. `lineage-only`:
  fresh session recorded in the family lineage without copied turns. `fork`:
  full-context fork inheriting the parent conversation. A spawn-time
  `fork: true` overrides to `fork`.

### `cwd`

- **Type:** string (path). **Default:** the parent's working directory.
- Where the child runs. Relative paths resolve against the agent dir
  (`~/.pi/agent`), absolute paths as-is. If `<cwd>/.pi/agent/` exists, the
  child uses it as its own config root. A spawn-time `cwd:` parameter
  overrides this.

### `cli`

- **Type:** string. Currently only `claude` is meaningful. **Default:** pi.
- Launches the child through the Claude Code CLI
  (`claude --dangerously-skip-permissions`) instead of pi. The body is always
  appended as a Claude system prompt, the task is the prompt argument, and
  `model` is passed through to Claude's own model resolution. Everything else
  (herdr tab, snapshots, resume, steering) works the same.

### `disable-model-invocation`

- **Type:** boolean (`true`/`false`). **Default:** `false`.
- `true`: the orchestrating model cannot spawn this agent; only a human via
  `/subagent <name> <task>`. Use for agents that are expensive or
  user-approval-gated.

### Body (below the frontmatter)

- **Type:** markdown. **Default:** none.
- The agent's role prompt. With `system-prompt: append|replace` it becomes
  (part of) the child's system prompt; without the key it prefixes the first
  task message. Fill with identity, scope boundaries, and workflow rules —
  commands and examples inline. Do not reference skills or scripts without
  verifying they exist.

## Precedence summary

For every parameter, the winner is: spawn-time tool parameter, then agent
frontmatter, then built-in default. For interactivity specifically:
spawn `interactive:` → frontmatter `interactive:` → inverse of `auto-exit`.

## Failure modes

- **Unknown key:** silently ignored. A typo (`aut-exit:`) does nothing and
  raises no error — the main hazard when editing by hand.
- **Invalid `spawning` value:** the whole file is rejected with
  `[pi-subagents] rejecting agent definition ...` on the console; the agent
  vanishes from listings.
- **Bad `model` ID or missing skill:** no error. The child falls back to its
  default model or receives a dead `/skill:` line. Both are silent quality
  losses — check `models-store.json` and the skill directories after edits.

## Recipes

Autonomous worker:

```markdown
---
name: worker
description: Implements one task end to end
tools: read, bash, write, edit
model: zai/glm-5.3-flash
thinking: minimal
spawning: false
auto-exit: true
system-prompt: append
---
```

Interactive planner (user drives the session):

```markdown
---
name: planner
description: Interactive planning - clarifies and plans with the user
model: zai/glm-5.3
thinking: medium
system-prompt: append
---
```

No `spawning` key on purpose: a planner may spawn scouts.

Claude-CLI runner:

```markdown
---
name: claude-code
description: Self-driving Claude Code session for deep investigation
cli: claude
model: sonnet
auto-exit: true
spawning: false
deny-tools: claude
---
```

User-approval-gated agent:

```markdown
---
name: expensive-runner
description: Long, costly run - human must invoke it
disable-model-invocation: true
spawning: manager-approval
auto-exit: true
---
```
