# @gtheys/pi-worktree

Parallel feature work in one repo, via [Herdr](https://github.com/pi-edubot/herdr) worktree workspaces. The `worktree` tool handles branch naming, dependency bootstrap, `.env` snapshots, a live dashboard, and safe removal — so you can run several pi sessions on the same repo without manual setup or accidental data loss.

## Requirements

- Running inside **Herdr** (`HERDR_ENV` set), with `herdr` on `PATH`
- `git`
- Optional: `acli` (Jira branch derivation), `gh` (yarn token + merge check), `git-town` (Jira flow parent branch), plus the package manager matching your lockfile

## The Workflow

1. **Plan** in your main checkout with the existing planning tools (`/plan`, create-plan, feature-plan).
2. **`worktree create`** — branch derived from `jira_id`, `name` (+ optional `type`), or a literal `branch`. Dependencies are bootstrapped by lockfile, `.env*` files are copied from the main checkout, and Herdr opens the worktree as a workspace.
3. **Work there** — `cd <path> && pi -c` for an interactive session, or spawn a subagent with `cwd` set to the worktree path.
4. **`worktree list`** — dashboard of every worktree × pi agent state (idle / working / blocked / done).
5. **Merge** — push, open a PR, and merge on GitHub (manual; the GitHub flow stays yours).
6. **`worktree remove`** — dirty-checked removal, with `delete_branch` gated on the PR being MERGED on GitHub.

## Actions

| Action | Parameters | Behavior |
| ------ | ---------- | -------- |
| `create` | `jira_id` **or** `name` (+ optional `type`) **or** `branch`; optional `label` | Creates a Herdr worktree workspace on the derived branch, bootstraps dependencies, copies missing `.env*` files |
| `list` | — | Text table of worktrees joined with pi agent states and pane ids |
| `remove` | `cwd` (required); `force`, `delete_branch` (optional) | Refuses dirty worktrees without `force`; `delete_branch` only deletes GitHub-MERGED branches |
| `open` | `path` **or** `cwd` (matches an existing worktree by path/prefix); optional `name`, `prompt` | Splits a pane in the worktree's Herdr workspace, starts a pi agent in it (`herdr agent start --kind pi`), and optionally sends it a first prompt |

`open` finds the target worktree the same way `list` sees it, opens a new
pane there, and starts an agent — the pane it hands back is the worker.
`name` defaults to a slug derived from the worktree path (herdr agent names
are `[a-z][a-z0-9_-]{0,31}`); `prompt`, if given, is sent to the agent right
after it starts. Returns `{ path, workspaceId, paneId, agentName }` — record
these on the feature ticket so a later session can resume the same pane.

Errors: herdr unavailable / not on `PATH` (same preflight as the other
actions); no worktree matches `path`/`cwd` (lists the available worktrees);
zero panes in the target workspace (nothing to split).

## Dependency Bootstrap

| Lockfile | Command |
| -------- | ------- |
| `bun.lock` / `bun.lockb` | `GH_TOKEN="$(gh auth token)" bun install` |
| `yarn.lock` | `GH_TOKEN="$(gh auth token)" yarn install` |
| `package-lock.json` | `GH_TOKEN="$(gh auth token)" npm ci` |
| `pnpm-lock.yaml` | `GH_TOKEN="$(gh auth token)" pnpm install --frozen-lockfile` |
| `Cargo.toml` | `cargo fetch` |
| `go.mod` | nothing (global caches) |
| none | nothing |

Bootstrap is best-effort: each step reports its outcome, failures never block worktree creation. The create action **waits for bootstrap to finish before returning** — in JS/TS repos the install (e.g. yarn) is complete by the time you spawn a session or subagent in the worktree, so tests and typechecks can run immediately.

## Notes

- `.env*` copies are point-in-time snapshots from the main checkout — copied only when missing, never overwritten afterwards.
- One feature = one worktree. Keep unrelated changes out.
- Merge and push stay manual — the GitHub flow (push, PR, merge) is yours; removal only checks its result.
