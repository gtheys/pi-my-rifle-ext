---
name: worktrunk
description: Use Worktrunk for git worktree workflows and configuration whenever working in a git repository. Prefer `wt` over manual branch/worktree lifecycle commands; use it for switching, creating task worktrees, merging, removing, hooks, aliases, approvals, LLM commit generation, and troubleshooting.
allowed-tools: Bash(wt:*), Bash(git:*), Bash(gh:*), Bash(tmux:*)
---

# Worktrunk

Use Worktrunk (`wt`) as the default workflow layer for git repositories.

Worktrunk does not replace all git commands. Use it for worktree, branch lifecycle, hooks, aliases, and Worktrunk configuration. Use plain `git` for low-level inspection and commit/push operations: `git diff`, `git show`, `git log`, `git status`, `git commit`, `git push`.

## Core Rules

1. Prefer `wt switch` over manual `git switch`, `git checkout`, `git worktree add`, or `cd`-based worktree navigation when the task involves changing working context.
2. Prefer `wt switch --create <branch>` for new task branches.
3. Prefer `wt switch --create <branch> --base=@` for stacked work that should build on the current branch.
4. Prefer `wt list` to understand all active worktrees before proposing cleanup or parallel work.
5. Prefer `wt merge` for local merge-and-cleanup workflows, and `wt remove` for deleting merged worktrees after remote PR merges.
6. Never use raw `git worktree add/remove` unless Worktrunk cannot express the operation.
7. Never bypass Worktrunk project hook approvals with `--yes` on the user's behalf. Hook approval is a trust decision.

## Start Here

When a task touches git inside a repository, orient with:

```bash
git rev-parse --show-toplevel
git status --short --branch
wt list
```

If the task may involve CI, PRs, or branches without worktrees, use:

```bash
wt list --full --branches
```

For command-specific options, run `wt <command> --help`.

## Configuration Model

Worktrunk has two config scopes. Choose deliberately.

### User config: personal, conservative

```text
~/.config/worktrunk/config.toml
```

Contains personal preferences:

- worktree path templates
- LLM commit generation
- list defaults and custom columns
- personal aliases/hooks
- approved project commands

Rules:

- Do not edit without explicit consent.
- Show the exact proposed change first.
- Preserve existing structure and comments.
- Do not install external tools for the user; recommend commands instead.

Read [reference/config.md](reference/config.md) and [reference/llm-commits.md](reference/llm-commits.md) before changing user config.

### Project config: shared, proactive

```text
.config/wt.toml
```

Contains team automation:

- lifecycle hooks
- aliases
- list URL templates
- shared commit prompt guidance

Rules:

- May create or edit as normal repo code when the user asked for project automation.
- Validate commands exist before adding them.
- Add comments explaining non-obvious choices.
- Warn before adding destructive, networked, or privileged commands.

Read [reference/hook.md](reference/hook.md), [reference/extending.md](reference/extending.md), and [reference/tips-patterns.md](reference/tips-patterns.md) before editing project config.

## Hook Safety And Approvals

Project hooks and aliases are arbitrary shell code from the repository. Worktrunk requires user approval before running them.

If a non-interactive agent hits an approval error like:

```text
Cannot prompt for approval in non-interactive environment
```

stop and escalate to the user:

```bash
wt config approvals add
```

Tell the user this lets them review and approve the commands. Do **not** run `--yes` for them to silence the approval gate. `--yes` is for CI or automation where the hook contents are already trusted.

Approvals live in `~/.config/worktrunk/approvals.toml` and re-prompt when a command template changes.

## Preferred Workflows

### New task branch

Create a new worktree instead of reusing the current directory:

```bash
wt switch --create feature-branch
```

If the user also wants to launch a tool immediately:

```bash
wt switch --create feature-branch -x '<command>'
```

Arguments after `--` pass through to the command:

```bash
wt switch --create feature-branch -x claude -- 'Implement the feature'
```

### Switch contexts

Use Worktrunk shortcuts whenever they fit:

```bash
wt switch ^
wt switch -
wt switch @
wt switch pr:123
wt switch mr:123
```

Use the interactive picker with no argument:

```bash
wt switch
```

Read [reference/switch.md](reference/switch.md) for picker keys, PR/MR handling, `--prs`, `--execute`, and troubleshooting.

### Stacked work

When the next task should build on the current branch instead of the default branch:

```bash
wt switch --create feature-part-2 --base=@
```

### Local merge workflow

If the user wants a local merge into the default branch, prefer:

```bash
wt merge
```

Useful variants:

```bash
wt merge develop
wt merge --no-remove
wt merge --no-squash
wt merge --no-ff
```

Read [reference/merge.md](reference/merge.md) before changing merge behavior or hooks.

### Cleanup after remote merge

If a PR merged remotely and the local worktree needs cleanup:

```bash
wt remove
```

Use force flags only when the user understands the target and impact:

```bash
wt remove --force       # remove dirty worktree
wt remove -D            # delete unmerged branch
```

Read [reference/remove.md](reference/remove.md) before forced cleanup.

### Status and coordination

For fast overview:

```bash
wt list
```

For CI, PR status, branch-only rows, and richer context:

```bash
wt list --full --branches
```

Use markers when they help coordinate parallel work:

```bash
wt config state marker set "🤖"
wt config state marker set "💬" --branch feature-auth
wt config state marker clear --branch feature-auth
```

Read [reference/list.md](reference/list.md) for status symbols, JSON output, custom columns, and CI behavior.

## Hooks And Project Automation

When the user asks to set up project automation, prefer `.config/wt.toml` hooks instead of one-off shell rituals.

Current hook types:

| Event | Blocking | Background |
|---|---|---|
| switch | `pre-switch` | `post-switch` |
| create | `pre-start` | `post-start` |
| commit | `pre-commit` | `post-commit` |
| merge | `pre-merge` | `post-merge` |
| remove | `pre-remove` | `post-remove` |

Guidance:

- dependencies/env generation needed before work starts → `pre-start`
- dev servers, cache copying, watchers, long builds → `post-start`
- format/lint/typecheck before `wt merge` creates a commit → `pre-commit`
- tests/build/security before the merge lands → `pre-merge`
- cleanup before/after worktree deletion → `pre-remove` / `post-remove`

Hook forms:

```toml
# single command
pre-start = "npm ci"

# concurrent commands
[pre-merge]
lint = "npm run lint"
test = "npm test"

# sequential pipeline; keys within one block run concurrently
[[post-start]]
copy = "wt step copy-ignored"

[[post-start]]
server = "wt step tether -- npm run dev -- --port {{ branch | hash_port }}"
```

Prefer `post-start` over `pre-start` unless later steps or `--execute` need the work completed first.

## Aliases And Extensions

Use aliases for reusable `wt` workflows in user or project config:

```toml
[aliases]
open = "open http://localhost:{{ branch | hash_port }}"
since-main = "git log --oneline {{ default_branch }}..HEAD"
```

Use pipeline aliases for multi-step commands. Read [reference/extending.md](reference/extending.md) before adding aliases, especially when nesting `wt step for-each` or deferring template expansion with `{% raw %}`.

## LLM Commit Generation

When the user wants Worktrunk to generate commit messages during `wt merge`, configure user config, not project config by default:

```toml
[commit.generation]
command = "..."
```

Read [reference/llm-commits.md](reference/llm-commits.md) for supported tools and safe command examples. Do not invent Claude/Codex command flags from memory.

## Agent Handoffs

Only spawn background agents in new worktrees when all are true:

- the user explicitly requests spawning or handoff
- the repo/project instructions authorize this pattern or the user approves it now
- the target worktree and branch are clear

For tmux:

```bash
tmux new-session -d -s feature-auth "wt switch --create feature-auth -x <agent-cli> -- 'Implement auth flow'"
```

For Zellij, use the equivalent `zellij run -- wt switch --create ...` pattern.

Do not use this pattern for normal worktree operations.

When delegating to subagents inside one parent session, prefer pre-creating the worktree yourself and giving the subagent the absolute path:

```bash
wt switch --create <branch> --no-cd --no-hooks
```

Then tell the subagent:

```text
You are working in /absolute/path/to/worktrunk.<branch> on branch <branch>. All edits must stay in that worktree.
```

This keeps path, branch, and hook target aligned.

## Decision Rules

- Use `wt` for branch/worktree lifecycle.
- Use `git` for diff/log/show/status/commit/push level operations.
- Use `gh` or `glab` with `wt switch pr:<n>` / `wt switch mr:<n>` when a forge branch needs a local worktree.
- Use `tmux` or Zellij only for explicit agent handoff/background tasks.
- Use `wt config show` to discover actual config paths and shell integration status.
- Use `wt hook <type> --dry-run` and `wt hook show` before trusting hook edits.

## Avoid These Anti-Patterns

- Creating a feature branch in the current directory when a dedicated worktree is more appropriate.
- Running `git worktree add` manually when `wt switch --create` would do it.
- Manually deleting worktree directories instead of `wt remove`.
- Using ad hoc branch names without checking `wt list` first when several parallel branches already exist.
- Using `git switch` to retarget a worktree unless the task specifically requires changing branches in place.
- Editing user config without consent.
- Adding project hooks that run destructive commands without warning.
- Running `--yes` to bypass hook approval as an agent.

## Common Failure Cases

- Branch does not exist: use `wt switch --create <branch>`.
- Target path occupied: switch to existing worktree or use `--clobber` only when the stale path is clearly safe to remove.
- Shell does not change directories: run `wt config show`, then `wt config shell install` if needed.
- Hooks block progress: inspect `.config/wt.toml`, `wt hook show`, and hook logs; do not bypass approval with `--yes`.
- Need the default branch name without assuming `main`: use `wt config state default-branch` or template `{{ default_branch }}`.
- Slow or broken `wt list`: use `-v`/`-vv`, `WORKTRUNK_VERBOSE=2`, and [reference/troubleshooting.md](reference/troubleshooting.md).

## Quick Reference

```bash
wt list
wt list --full --branches
wt switch
wt switch --create feature-x
wt switch --create feature-y --base=@
wt switch pr:123
wt merge
wt remove
wt config show --full
wt config state default-branch
wt hook show
wt hook pre-merge --dry-run
wt config approvals add
```

## References

| Reference | When to Read |
|-----------|--------------|
| [reference/config.md](reference/config.md) | Before editing user/project config or list defaults |
| [reference/hook.md](reference/hook.md) | Before configuring hooks or approvals |
| [reference/switch.md](reference/switch.md) | Before advanced switching, PR/MR checkout, picker use, or `--execute` |
| [reference/merge.md](reference/merge.md) | Before changing merge behavior or merge hooks |
| [reference/remove.md](reference/remove.md) | Before cleanup, force removal, or branch deletion |
| [reference/list.md](reference/list.md) | Before interpreting `wt list` symbols, CI, JSON, or custom columns |
| [reference/llm-commits.md](reference/llm-commits.md) | Before setting up generated commit messages or summaries |
| [reference/extending.md](reference/extending.md) | Before adding aliases or multi-step pipelines |
| [reference/tips-patterns.md](reference/tips-patterns.md) | For practical recipes: dev servers, DBs, vars, env, copy-ignored |
| [reference/shell-integration.md](reference/shell-integration.md) | When `wt switch` does not cd correctly |
| [reference/troubleshooting.md](reference/troubleshooting.md) | For hook, config, list, LLM, and platform failures |
