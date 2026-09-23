# Architecture Overview

## What this repo is not

There's no server, no build, no runtime entrypoint you execute. This is a **package
of extensions for the pi coding agent**. pi discovers it via the `pi` block in the
root `package.json` and loads each listed module directly with Bun/Node's ESM loader.

```json
"pi": {
  "extensions": [ "./packages/pi-bootstrap/index.ts", "./packages/pi-interactive-subagents/pi-extension/subagents/index.ts", ... ],
  "skills": ["./skills"],
  "prompts": ["./prompts"],
  "themes": ["./themes"]
}
```
Source: `package.json:16`

## The extension model

Every extension file exports a default function `(pi: ExtensionAPI) => void`. Inside
that function it registers three kinds of things against the injected `pi` object:

| Registration | Purpose | Example |
|---|---|---|
| `pi.on(eventName, handler)` | React to lifecycle events (`session_start`, `agent_start`, `agent_end`, `session_shutdown`) | `pi-bootstrap` symlinks AGENTS.md on `session_start` |
| `pi.registerTool({...})` | Expose a typed tool the LLM can call mid-conversation | `pi-sem`'s `sem_diff`, `sem_impact`, etc. |
| `pi.registerCommand('name', {...})` | Expose a `/name` slash command a human types | `/review`, `/plan`, `/implement`, `/notify` |

Tool schemas are defined with `typebox`'s `Type.*` builders (or `@sinclair/typebox`
directly in older packages) so the harness can validate LLM tool-call arguments
before your handler runs. See `packages/pi-planning/plan-tools/index.ts:86` for a
representative tool registration.

## Workspace layout and dependency direction

All packages are published to npm under `@gtheys/*` (e.g. `@gtheys/pi-fastcontext`).
Each `package.json` has a `files` allowlist shipping only TypeScript source —
no build step, no `dist/`. Use `make release-dry-run` to verify tarballs before
publishing.

```
packages/
├── pi-bootstrap/             no deps — pure side effect on session_start
├── pi-ask-user-question/     ask_user_question tool (interactive TUI dialogs), standalone
├── pi-prompt-snippets/       one-shot prompt snippet toggles (alt+s / /snippets), standalone
├── pi-desktop-notify/        /notify command, standalone
├── pi-fastcontext/           fast_context_search tool + /fastcontext, standalone
├── pi-tool-pills/            wraps ls/read/find/grep/bash/write/edit tool RENDERING only
├── pi-interactive-subagents/ subagent tool + /plan dispatch; vendored, exports
│                             programmatic launchSubagent/watchSubagent API
├── pi-test-runner/           run_tests tool, launches a test-runner agent via ↑
├── pi-sem/                   sem_* tools, wraps the external `sem` CLI (@ataraxy-labs/sem)
├── pi-planning/
│   ├── shared/               ← shared by both siblings below (jira-branch)
│   ├── plan-tools/           resolve_* tools + open_in_pane (aven-era slimmed down)
│   └── implement-plan/       jira_create_branch + /implement routing to implement-plan-aven
├── pi-review/
│   ├── shared/sonarqube-utils.ts  ← shared by sonarqube.ts and pr-quality
│   ├── review/review.ts           /review command (reviewer agent + ocr scout via ↑)
│   ├── sonarqube/sonarqube.ts     /sonarqube command
│   └── pr-quality/index.ts        /pr-quality + /pr-watch commands
├── pi-teams-transcript/      teams_transcript tool + sync/summarize/weekly/push commands (MS Graph)
├── pi-pr-digest/             pr_digest tool + /pr-digest (gh CLI), standalone
├── pi-sudo/                  sudo_run tool — confirm dialog + masked password prompt
├── pi-aven-context/          injects live aven workspace state at session_start
└── pi-worktree/              worktree tool — Herdr worktree workspaces (create/list/remove)
```

Two packages internally share code across sibling extensions rather than being split
into more packages — this is deliberate (see `README.md`: "Shared helpers are
co-located with their only consumer"). Don't extract a new package for a helper used
by exactly one other file; keep them next to each other like `pi-planning/shared` and
`pi-review/shared` do.

## Cross-package dependencies: exactly one, deliberately

`pi-interactive-subagents` was vendored into the monorepo and publishes a
programmatic API (`launchSubagent`/`watchSubagent` from `@gtheys/pi-interactive-subagents`).
Two packages import it as a real workspace dependency: `pi-test-runner` (spawns its
test-runner agent through it) and `pi-review` (spawns its reviewer agent and ocr
scout through it). Everything else still coordinates without imports:
- **aven** as external planning state (`feature-plan-aven` / `implement-plan-aven`
  skills drive the aven CLI; `pi-planning` only resolves paths and branches) —
  see `workflows/planning-and-implementation.md` and `docs/aven-feature-flow.md`.
- **git/gh CLI** as external state (`pi-review`'s three commands all shell out to `gh`
  and `git`).
- **pi's own event bus** (`session_start`, `agent_end`) for cross-cutting concerns like
  desktop notifications and AGENTS.md bootstrapping.
- **skill files** as the glue between `/plan` (registered by `pi-interactive-subagents`)
  and the aven planning flow — see the dependency map in `README.md`.

Notably `pi-planning`'s `open_in_pane` shells out to the `herdr` CLI directly instead
of importing pi-interactive-subagents (in-file AIDEV-NOTE: no cross-package dependency
for 3 exec calls).

## External processes each extension shells out to

| Package | External binary/API | Why |
|---|---|---|
| `pi-bootstrap` | none (fs only) | symlink AGENTS.md |
| `pi-planning` (both) | `aven` (optional), `acli` + `git-town` (jira_create_branch) | planning state lives in aven; branch derivation for Jira tickets |
| `pi-aven-context` | `aven` (`aven prime`) | inject live workspace state at session start |
| `pi-sudo` | `sudo -S` | root command execution behind confirm + password overlay |
| `pi-sem` | `sem` CLI (`@ataraxy-labs/sem`, optional dep) | entity-aware git diff/impact/context/blame |
| `pi-review/review` | `git`, `gh`, optional `ocr`, + reviewer agent & ocr scout via `pi-interactive-subagents` | checkout PRs, diff branches/commits, ocr second opinion |
| `pi-review/sonarqube` | SonarCloud REST API (`sonarFetch`) | coverage + issues |
| `pi-review/pr-quality` | `gh api graphql`, SonarCloud API | unresolved review threads + Sonar issues in one pass |
| `pi-fastcontext` | local FastContext server (llama.cpp, `127.0.0.1:8772`) | fast semantic code search without a full agent turn |
| `pi-interactive-subagents` | multiplexer CLI (cmux/tmux/zellij/wezterm/herdr) | sub-agents run in real terminal panes, results steer back into the session |
| `pi-test-runner` | test scripts via the `pi-interactive-subagents` API | isolate test runs in a `test-runner` agent so they don't block the conversation |
| `pi-pr-digest` | `gh` CLI | PR author/comment/review status across an org |
| `pi-worktree` | `herdr`, `git`, optional `acli`/`gh`/`git-town` + package manager | create/list/remove worktree workspaces |
| `pi-desktop-notify` | `notify-send` | desktop notification on idle-after-work |

## Next

- [Extension reference](extensions.md) for a deep dive per package.
- [Planning workflow](../workflows/planning-and-implementation.md) for the aven
data model behind `feature-plan-aven` / `implement-plan-aven` (canonical flow:
  `docs/aven-feature-flow.md`).
