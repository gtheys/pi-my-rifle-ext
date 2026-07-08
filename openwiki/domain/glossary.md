# Glossary

Terms specific to this repo and the SalaryHero taskwarrior-driven planning workflow.
For pi's own SDK/extension vocabulary (ExtensionAPI, events, etc.) see pi's own docs,
not this file.

## Taskwarrior / planning domain

| Term | Meaning |
|---|---|
| **Jira ID** | e.g. `IMP-7070`, `DP-92` — the external ticket identifier that anchors a spec task and all its phase/subtask tasks in taskwarrior. |
| **Spec task** | A taskwarrior task tagged `+spec`, `work_state:approved`, annotated `Spec(repo=<repo>): <path>` pointing at the markdown spec file. Created by `tw_create_spec_task`. |
| **Spec file** | The markdown design doc at `notes/specs/<JIRA_ID>__<slug>.md` (or under `$LLM_NOTES_ROOT`). Source of truth for **how** to implement; taskwarrior is the source of truth for **what/order**. |
| **Phase** | A taskwarrior task tagged `+impl +phase`, titled `"N. Phase: <name>"`, representing one deliverable checkpoint (e.g. "1. Phase: Database Schema"). Parsed by `parsePhaseNumber`/`parsePhaseName` in `implement-plan/index.ts`. |
| **Subtask** | A taskwarrior task tagged `+impl`, titled `"N.M <description>"`, `depends:` on its parent phase's UUID. Parsed by `parseSubtaskNumber`/`parseSubtaskName`. |
| **`work_state`** | Custom taskwarrior UDA distinct from taskwarrior's own `status`. Values: `todo` → `inprogress` → `done`. `tw_advance_task` with `state:done` also calls `task done` to set taskwarrior's native `status:completed` — the two must be kept in sync via this one tool. |
| **Execution plan** | The structure `tw_execution_plan` returns: all phases (with nested subtasks) sorted by numeric prefix, plus `currentPhase`/`currentSubtask` (first non-done item = resume point) and progress counts. |
| **Phase checkpoint** | Calling `tw_phase_checkpoint` after tests pass + user confirms a phase is done — marks the phase task done and returns a commit-message template. Does not run tests or commit itself. |
| **`$LLM_NOTES_ROOT`** | Optional env var pointing at a centralized notes vault (outside any single repo) so specs for multiple repos live in one place: `$LLM_NOTES_ROOT/<repoName>/notes/specs/`. |
| **Spec annotation format** | `Spec(repo=<repo>): <relative-path>` — the exact regex-parsed string linking a spec task to its file. Don't change without updating both the writer and parser (`plan-tools/index.ts`). |

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
| **Subagent (test-runner)** | A fully detached pi process with its own session file, spawned by `run_tests`/`/run-tests` so a test run never blocks the calling conversation. Communicates results back solely via `pi-intercom`'s `contact_supervisor`. |
| **Companion package** | A pi package this repo depends on conceptually but does **not** vendor — installed separately via `pi install` so it loads from user settings, not this repo's `node_modules` (e.g. `condensed-milk-pi`, `pi-vcc`, `caveman-milk-pi`, `ponytail`, `pi-intercom`). See `README.md`. |
