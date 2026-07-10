# Extension Reference

Deep-dive on each `packages/*` extension: what it registers, key files, and
non-obvious implementation decisions worth knowing before you touch it.

## pi-bootstrap

- **File:** `packages/pi-bootstrap/index.ts` (37 lines)
- **Registers:** `session_start` handler (only on `reason === 'startup'`).
- **What:** Symlinks this repo's `agents/AGENTS.md` → `~/.pi/agent/AGENTS.md` so the
  global agent picks up this repo's rules automatically. If a file/symlink already
  exists at the target, it **warns and skips** rather than overwriting — the user's
  existing AGENTS.md always wins.
- **Gotcha:** if you edit `agents/AGENTS.md` expecting it to take effect, check
  whether the symlink was ever actually created (it silently no-ops if something
  else is already there).

## pi-context

- **File:** `packages/pi-context/context.ts`
- **Registers:** `/context` command.
- **What:** Renders a colored grid overlay of current context/token usage, broken
  down by system prompt, user/assistant messages, thinking, per-tool-type results,
  compaction summaries, images, and free space. Token counts are estimated locally
  (`~4 chars/token`), not fetched from the provider — good enough for a rough visual,
  not billing-accurate.

## pi-desktop-notify

- **File:** `packages/pi-desktop-notify/index.ts` (158 lines)
- **Registers:** `session_start`, `agent_start`, `agent_end` handlers; `/notify` command.
- **What:** Fires a `notify-send` desktop notification when the agent finishes work,
  but only if the user has been idle for `idleThresholdMs` (default 30s) — avoids
  spamming during rapid back-and-forth. State (`enabled`, `idleThresholdMs`) persists
  across sessions via a custom entry type (`desktop-notify-state`), replayed by
  scanning entries backward on `session_start`.
- **Commands:** `/notify`, `/notify on|off`, `/notify idle [seconds]`.

## pi-fastcontext

- **File:** `packages/pi-fastcontext/index.ts` (1015 lines — largest single file)
- **Registers:** `fast_context_search` tool; `/fastcontext` command; `session_start` handler that scaffolds `config.schema.json` on first startup.
- **What:** Read-only codebase search backed by a **local** FastContext model server
  (llama.cpp, OpenAI-compatible API, default `http://127.0.0.1:8772/v1`, default model
  `FastContext-1.0-4B-RL-Q4_K_M.gguf`). It's a lightweight agent loop that gives the
  small local model its own read/grep/glob tools capped tightly (`MAX_READ_LINES=120`,
  `MAX_GREP_RESULTS=40`, `MAX_TOOL_CHARS=5000`) and forces it to finalize within
  `maxTurns` (default 6), returning compact `file:line` citations instead of full file
  contents to the calling (larger, more expensive) model.
- **Config:** TypeBox schema (`FastContextConfigSchema`) validates `JSON.parse` →
  `unknown` at the boundary; `Value.Check()` rejects malformed files gracefully.
  `config.schema.json` is checked-in and refreshed at startup when missing.
  Config resolution order: built-in defaults → `getAgentDir()/fastcontext.json` →
  `<cwd>/.pi/fastcontext.json` → `FASTCONTEXT_*` env vars (last wins).
- **Why it exists:** avoid burning the primary model's context/turns on broad
  exploratory search when a cheap local model can return citations instead.

## pi-tool-pills

- **Files:** `packages/pi-tool-pills/index.ts`, `pill.ts`, `diff-renderer.ts`
- **Registers:** re-registers `ls`, `read`, `find`, `grep`, `bash` (colored pill labels
  + collapsed output, 15-line default) and `write`/`edit` (Shiki syntax-highlighted
  diffs via `registerDiffTools`).
- **What:** Pure **rendering** layer — it wraps the harness's own
  `create*ToolDefinition` factories and only changes how results are displayed in the
  TUI, not tool behavior/semantics. Diff theme config loads from
  `~/.pi/agent/settings.json` (fixed in `e58efbdd`).
- **Dependency note:** pulls in `shiki`/`@shikijs/cli` for highlighting — the only
  package in this repo with a real third-party rendering dependency.

## pi-test-runner ⚠️ experimental/WIP

- **Files:** `packages/pi-test-runner/index.ts` (495 lines), `discover.ts`, `runner.ts`
- **Registers:** `run_tests` tool; `/run-tests`, `/test-runner` commands; `session_start`
  handler that scaffolds `config.schema.json` on first startup.
- **What:** Discovers test scripts from the nearest `package.json`
  (`discoverTestScripts`), then spawns a **fully detached pi subagent** with its own
  session file (`generateSessionFile`, `spawnTestSubagent`) so the test run doesn't
  block or bloat the calling conversation. Results come back exclusively through
  `pi-intercom`'s `contact_supervisor` channel.
- **Config:** TypeBox schema (`TestRunnerConfigSchema`) validates `JSON.parse` →
  `unknown` at the boundary via `Value.Check()`. `config.schema.json` checked-in and
  scaffolded at startup when missing. Persisted at `getAgentDir()/test-runner/config.json`
  — **not** `pi.appendEntry()`, because that API is session-scoped.
- **Commands:** `/run-tests [script]` (fire-and-forget), `/test-runner switch`,
  `/test-runner back`, `/test-runner model`.

## pi-sem

- **Files:** `packages/pi-sem/index.ts` (625 lines), `core.d.mts`, `bin/sem-eval.mjs`
- **Registers:** 7 tools — `sem_diff`, `sem_impact`, `sem_context`, `sem_log`,
  `sem_entities`, `sem_blame`, `sem_eval` (see `pi.registerTool` calls at
  `index.ts:205,250,308,368,432,469,506`).
- **What:** Thin typed wrapper around the external `sem` CLI
  (`@ataraxy-labs/sem`, an **optional** dependency — the extension must degrade
  gracefully if it's not installed; see `SEM_INSTALL_HINT` in the shared `core.mjs`).
  Provides entity-level (function/class/method) git diff, blast-radius/impact
  analysis, budgeted context retrieval, and history — richer than raw
  `git diff`/`git blame` for reasoning about a single function across commits.
- **Output truncation:** large outputs are written to a temp file under
  `os.tmpdir()/pi-sem-<timestamp>/` and the tool result references that path instead
  of dumping megabytes into the conversation (`writeTruncatedOutput`,
  `truncateToolText`).
- Full usage guidance lives in the paired `skills/tools/sem/SKILL.md`.

## pi-planning (plan-tools + implement-plan)

Two extensions in one package, sharing `packages/pi-planning/shared/tw-utils.ts`
(`twExport` — runs `task <filter> export` and parses the JSON).

### plan-tools — `packages/pi-planning/plan-tools/index.ts` (435 lines)

- **Tools:** `tw_get_ticket`, `tw_get_spec_task`, `tw_get_phases`, `tw_get_impl_tasks`,
  `resolve_spec_path`, `tw_create_spec_task`, `tw_create_phase`, `tw_create_impl_task`.
- **Command:** `/plan <JIRA_ID>` — smart routing: if a spec file already exists for the
  ticket, hands off to the **iterate-plan** skill; otherwise **create-plan**.
- **Spec path convention:** `<notes-root-or-repo>/notes/specs/<JIRA_ID>__<slug>.md`,
  where slug = first 5 lowercase words of the Jira summary, non-alnum stripped
  (`resolveSpecPath`, `index.ts:41`). `$LLM_NOTES_ROOT` overrides where specs live,
  letting a central notes vault span multiple repos.
- **Spec annotation format:** `Spec(repo=<repo>): <relative-path>` — parsed by
  `extractSpecPath` (`index.ts:68`) via regex. This is the **only** link between a
  taskwarrior spec task and its file on disk — don't change the format without
  updating both `plan-tools` and any skill that reads it.

### implement-plan — `packages/pi-planning/implement-plan/index.ts` (426 lines)

- **Tools:** `tw_execution_plan`, `tw_advance_task`, `tw_phase_checkpoint`.
- **Command:** `/implement <JIRA_ID>` — shows the execution plan, routes to the
  **implement-plan** skill.
- **`tw_execution_plan`** is the important one: it fetches all `+impl` tasks for a
  Jira ID, parses phase numbers out of descriptions matching `^(\d+)\.\s*Phase:`
  (`parsePhaseNumber`) and subtask numbers matching `^(\d+\.\d+)` (`parseSubtaskNumber`),
  sorts by numeric prefix, and computes `currentPhase`/`currentSubtask` — the first
  non-done item — as the **resume target**. This is what lets `/implement` be safely
  re-run mid-way through a multi-session implementation.
- See [Planning workflow](../workflows/planning-and-implementation.md) for the full
  task lifecycle and taskwarrior data model.

## pi-review (review + sonarqube + pr-quality)

Three extensions sharing `packages/pi-review/shared/sonarqube-utils.ts`.

### review — `packages/pi-review/review/review.ts`

- **Command:** `/review [pr <n>|pr <url>|uncommitted|branch <name>|commit <sha>|folder <paths...>|custom "<instructions>"]`
  with an interactive selector when called with no args.
- **What:** Prompts the agent to review code changes; injects semantic-tool guidance
  (`buildSemReviewGuidance` from `sem-guidance.mjs`) so the review prompt tells the
  agent to prefer `sem_diff`/`sem_impact` when `pi-sem` is available.
- **Constraint:** PR review mode requires a clean working tree (it checks out the PR
  branch locally) — will refuse if there are uncommitted tracked-file changes.
- **Session state:** tracks the origin session ID for a "fresh session per review"
  pattern; module-level state (`reviewOriginId`, `endReviewInProgress`) is deliberate
  and assumes a single active review at a time (documented in-file).
- Project-specific guidelines: if `REVIEW_GUIDELINES.md` exists next to `.pi/`, its
  contents are appended to the review prompt.

### sonarqube — `packages/pi-review/sonarqube/sonarqube.ts`

- **Command:** `/sonarqube [pr-number] [--severity=...] [--types=...]`
- **What:** Analysis-only rewrite of legacy `salaryhero/opencode/bin/sonar-*` bash
  scripts. Auto-detects PR number from current branch and Sonar project config from
  `sonar-project.properties` if not given explicitly. Fetches coverage gaps
  (`analyzeCoverage`) and quality issues (`analyzeIssues`/`fetchAllIssues`) from
  SonarCloud, filterable by severity/type.
- **Requires:** `SONARQUBE_TOKEN` env var.

### pr-quality — `packages/pi-review/pr-quality/index.ts` (642 lines)

- **Commands:** `/pr-quality [pr-number]`, `/pr-watch`.
- **What:** Combines GitHub PR unresolved review threads (via inline `gh api graphql`,
  `REVIEW_THREADS_QUERY`) with SonarCloud analysis for the same PR into one unified
  LLM context message. The agent is expected to: triage each thread VALID/INVALID,
  auto-resolve INVALID threads through the GraphQL API, cross-reference VALID
  comments with Sonar issues by file, and **fix issues immediately** — deliberately
  no plan file is written (changed in `f68b45b5`, replacing an earlier
  plan-file-based flow).
- **`/pr-watch`:** background-polls GitHub Actions/status checks
  (`checkActionsComplete`, via `statusCheckRollup`, ignoring `SKIPPED` checks) using a
  plain `setInterval` loop — replaced an earlier detached-bash+sentinel-file+`fs.watch`
  approach (`202b3de7`) that was flaky. When checks complete, it triggers `/pr-quality`
  automatically. Cleans up its interval on `session_shutdown`.

## Next

- [Planning & implementation workflow](../workflows/planning-and-implementation.md)
- [Code review workflow](../workflows/code-review.md)
