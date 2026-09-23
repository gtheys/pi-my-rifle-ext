# Glossary

Terms specific to this repo and the aven-driven planning workflow.
For pi's own SDK/extension vocabulary (ExtensionAPI, events, etc.) see pi's own docs,
not this file.

## Aven / planning domain

| Term | Meaning |
|---|---|
| **aven** | Local-first task manager CLI (https://aven.raine.dev); replaced taskwarrior as planning state. Infers workspace + project from cwd (`personal` vs `salaryhero`); `aven doctor` checks routing. CLI primer lives in the global `aven` skill. |
| **Aven ref** | Task reference like `PMR-ZTVG` printed by aven commands (suffix identifies the task; prefix is project display context). Bare suffixes work when unambiguous. Refs stay out of commit messages/PRs/external systems. |
| **Plan gate (`plan-state`)** | Feature-ticket metadata: `draft` (interview done, plan.md incomplete) → `review` (plan.md complete, awaiting user) → `approved` (tree may be created). Only the user's explicit "approve <REF>" moves review → approved. Branching on it makes the flow resumable. |
| **`plan-path`** | Per-ticket metadata pointing at the absolute plan.md path — the only metadata the tree creation writes. `aven list --has-metadata plan-path --open` finds planned features. |
| **`plan.md`** | The "how" artifact (design, constraints, acceptance criteria), living on the filesystem — counterpart of the aven tree's "what/order". Path from `resolve_feature_path`: `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`, else `<git-toplevel>/.pi/plans/<date>-<slug>/plan.md`. `- [x]` items are done. |
| **Phase** | Epic child titled `"N. Phase: <name>"`, labels `[phase,impl]`, dep-chained on the previous phase so `aven list --ready` exposes one phase at a time. |
| **Subtask** | Epic child titled `"N.M <title>"`, label `[impl]`, depends on its phase. Aven does NOT sort by prefix — skills sort client-side; prefixes are for humans. |
| **Oneshot** | Shortcut for tickets whose description is already a complete spec: worker → tests → commit → done, no plan.md, no tree. |
| **Jira-synced ticket** | Ticket synced from Jira by `jira-aven-sync` (`jira-key`/`jira-url`/`jira-status` metadata, `jira` label) living in the Jira project's aven project. Never worked on directly — work happens on a **local epic** pulled into the repo's project (`jira-ref` metadata, dep-linked to the synced ticket). |
| **Pull-in (find-or-create)** | Workspace-wide `jira-key` lookup → repo-project `jira-ref` lookup → create local epic + `aven dep add` if missing. The whole flow then runs on the epic. |
| **`resolve_spec_path`** | Tool computing the spec path `<notes-root-or-repo>/notes/specs/<JIRA_ID>__<slug>.md` (slug = first 5 lowercase words, non-alnum stripped). |
| **`$LLM_NOTES_ROOT`** | Optional env var pointing at a centralized notes vault (outside any single repo) so specs for multiple repos live in one place: `$LLM_NOTES_ROOT/<repoName>/notes/specs/`. |
| **`$PERSONAL_FEATURES`** | Optional env var for the local-feature flow: plan.md hierarchies live at `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md` instead of `<repo>/.pi/plans/…`. |

## Code annotation conventions

| Term | Meaning |
|---|---|
| **`AIDEV-NOTE:`** | Comment aimed at AI + humans marking non-trivial, important, confusing, or bug-prone code. Grep for these before editing a file. Never delete without explicit instruction (root `AGENTS.md`). |
| **`AIDEV-TODO:` / `AIDEV-QUESTION:`** | Same family — deferred work or an open question for a human to resolve. |
| **`ponytail:`** | Marks a deliberate simplification with a named ceiling and upgrade trigger, e.g. `// ponytail: git rev-parse always works in a repo; remote URL is optional`. Signals "known limitation, not an oversight." |

## Extension/tool vocabulary specific to this repo

| Term | Meaning |
|---|---|
| **Pill** | A colored badge label pi-tool-pills renders in front of tool output (e.g. for `ls`, `read`, `bash`) — purely visual, defined in `packages/pi-tool-pills/pill.ts`. |
| **FastContext** | A local llama.cpp-served small model (`FastContext-1.0-4B-RL-Q4_K_M.gguf` by default) used by `pi-fastcontext` for cheap read-only codebase search, distinct from the primary conversation model. |
| **sem** | The external `@ataraxy-labs/sem` CLI providing entity-level (function/class/method) git analysis, wrapped by the `pi-sem` extension's tools (`sem_diff`, `sem_impact`, `sem_context`, `sem_log`, `sem_entities`, `sem_blame`, `sem_eval`). |
| **Subagent (pi-interactive-subagents)** | An agent (`scout`, `worker`, `planner`, `reviewer`, `test-runner`, …) spawned in a real multiplexer pane (cmux/tmux/zellij/WezTerm/Herdr). Fully async: `launchSubagent`/`watchSubagent` return immediately; results steer back into the main session as a new turn. Bundled agent definitions resolve project-local `.pi/agents/` → `~/.pi/agent/agents/` → bundled copy. Epimetheus memory is disabled inside subagent sessions (orphaned queue markers — see extensions.md). |
| **ocr / OpenCodeReview** | External `ocr` CLI used by `/review` for a second opinion: pure-runner scout subagents write `ocr <args> --format json --output <tmpfile>` results back as `ocr_result` steers. `ocr delegate preview`/`rule` emit the LLM-free spec + rules the "Review with ocr delegate rules" preset applies host-side. |
| **Companion package** | A pi package this repo depends on conceptually but does **not** vendor — installed separately via `pi install` so it loads from user settings, not this repo's `node_modules` (e.g. `condensed-milk-pi`, `pi-vcc`, `caveman-milk-pi`, `ponytail`, `pi-intercom`). See `README.md`. |
| **`getAgentDir()`** | Function from `@earendil-works/pi-coding-agent` that returns the Pi agent directory (`~/.pi/agent` by default, overridden by `PI_CODING_AGENT_DIR`). Always use this instead of hardcoding paths. |
| **`CONFIG_DIR_NAME`** | Constant from `@earendil-works/pi-coding-agent` for the project-level pi config directory name (`.pi`). Use instead of hardcoding `.pi` in path joins. |
| **`config.schema.json`** | JSON Schema file checked into each package that has user config. The TypeBox schema in source is the source of truth; `config.schema.json` is generated from it and scaffolded to the package directory at startup when missing. Supports editor autocompletion via `$schema` in user config files. |
