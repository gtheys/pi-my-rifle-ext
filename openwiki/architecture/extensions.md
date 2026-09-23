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

## pi-interactive-subagents (vendored)

- **Files:** `packages/pi-interactive-subagents/pi-extension/subagents/index.ts` +
  `session.ts`, `status.ts`, `activity.ts`, `cmux.ts`, `subagent-done.ts`;
  agent definitions in `agents/` (claude-code, planner, reviewer, scout, visual-tester,
  worker).
- **Registers:** `subagent`/`subagent_interrupt`/`subagent_resume`-style tools,
  `/plan` dispatch command, orchestrator UI widget.
- **What:** Vendored from the upstream project into this monorepo (`ec79bc8`) so its
  programmatic API is importable as a workspace dependency (`@gtheys/pi-interactive-subagents`:
  `launchSubagent`, `watchSubagent`). Spawns sub-agents in real multiplexer panes
  (cmux/tmux/zellij/WezTerm/Herdr); results are **steered back** into the main session
  as async notifications that trigger a new turn. Fully non-blocking.
- **Agent resolution order:** project-local `.pi/agents/` → `~/.pi/agent/agents/` →
  the bundled copy under `agents/`.
- **`/plan <arg>` dispatch** (in-file AIDEV-NOTE): **aven-first** — Jira-shaped
  arguments and free text **both** inject the **feature-plan-aven** skill (the
  aven planner handles aven refs, aven-synced Jira IDs, and local features;
  the aven workspace is routed by cwd). If the repo's skill files can't be read
  (standalone install), it falls back to the bundled generic `plan-skill.md`.
  Note `pi-planning` also registers `/plan` — first registration wins by load
  order in the root `package.json` `pi.extensions`, so `pi-planning`'s `/plan`
  is effectively dead in the monorepo but kept for standalone npm installs of
  that package (see `README.md` "Rules of the road").
- **Subagent env:** epimetheus (Hindsight memory) is **disabled** in subagent
  sessions (`EPIMETHEUS_ENABLED=false`) — its pending-queue markers for
  ephemeral/crashed subagent sessions orphaned and warned on every parent quit;
  subagent work is retained via the parent session's steering summary.
- **`/reload` survival:** module-level timers and poll loops are keyed on
  `Symbol.for(...)` globals; a fresh module load aborts the previous load's
  poll controller (`POLL_ABORT_KEY`) so old closures can't keep polling.

## pi-ask-user-question

- **Files:** `packages/pi-ask-user-question/index.ts` (+ test)
- **Registers:** `ask_user_question` tool.
- **What:** Lets the agent pause and ask the user exactly one question through an
  interactive TUI dialog — free-form text, single-select, or multi-select — always
  with an **Other** free-text escape hatch. Esc cancels; the tool result carries a
  structured `details` object with `status: answered | cancelled | unavailable`.
- **Concurrency:** all pop-ups share a global UI mutex (keyed on `globalThis`) so
  concurrent calls — or races with other pop-up tools — serialize instead of
  corrupting the TUI.

## pi-prompt-snippets

- **Files:** `packages/pi-prompt-snippets/index.ts`, `snippets/*.md`
- **Registers:** alt+s keybinding + `/snippets` command; a widget showing active snippets.
- **What:** One-shot prompt rules — toggle snippets on, send a message, and the active
  bodies are prepended/appended to it. Toggles reset to all-off after each send and at
  session start (one-shot, not sticky). Snippet files are markdown with frontmatter
  (`name`, `description`, `placement: prepend|append`, `order`); the directory is
  created on session start if missing.

## pi-pr-digest

- **Files:** `packages/pi-pr-digest/index.ts`, `config.schema.json`
- **Registers:** `pr_digest` tool + `/pr-digest` command.
- **What:** Lists an author's open PRs in an org via the `gh` CLI with human
  comment/review status — bot activity filtered out. Backs the digest mode of the
  `teams-pr-notify` skill (reviewer-request table for PRs lacking human review).

## pi-worktree

- **Files:** `packages/pi-worktree/index.ts`, `branch.ts`, `bootstrap.ts`,
  `herdr.ts`, `remove-guards.ts`
- **Registers:** `worktree` tool (actions `create` / `list` / `remove`).
- **What:** Parallel feature work via [Herdr](https://github.com/pi-edubot/herdr)
  worktree workspaces. `create` derives a branch from a Jira ID (acli), a
  conventional `name`+`type`, or a literal `branch`; creates the worktree, bootstraps
  dependencies by lockfile (bun/yarn/npm/pnpm/cargo/go — best-effort, failures never
  block creation, and the action waits for bootstrap to finish before returning),
  copies missing `.env*` files from the main checkout (point-in-time snapshot, never
  overwritten), and best-effort sets the git-town parent for the Jira flow.
  `list` joins worktrees with live pi agent states as a dashboard; `remove` refuses
  dirty worktrees without `force` and only deletes branches already **MERGED** on
  GitHub when `delete_branch` is set. Merge/push stay manual — removal only checks
  the result.

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

- **Files:** `packages/pi-test-runner/index.ts`, `subagent.ts`, `discover.ts`,
  `agents/test-runner.md`
- **Registers:** `run_tests` tool; `/run-tests`, `/test-runner` commands; `session_start`
  handler that scaffolds `config.schema.json` on first startup.
- **What:** Discovers test scripts from the nearest `package.json`
  (`discoverTestScripts`), then spawns a **`test-runner` agent** via `pi-interactive-subagents`
  programmatic API (`subagent.ts` wraps `launchSubagent` + `watchSubagent`) so the run
  shows in the orchestrator's subagents widget and doesn't block the calling
  conversation. Results come back when the subagent finishes — its result is steered
  into the session. (Replaced an earlier detached-process + `pi-intercom`
  `contact_supervisor` design; the full `ExtensionContext` is passed through so the
  subagent widget renders.)
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

Aven-era slimmed-down package: task management lives in **aven** (see
`feature-plan-aven` / `implement-plan-aven` skills and
[the planning workflow](../workflows/planning-and-implementation.md)); every
`tw_*` taskwarrior tool was deleted. What remains: canonical path resolution,
nvim-in-pane plan review, and Jira branch derivation. Both siblings follow
**one-tool-per-file** layout, wired from each `index.ts`.

### plan-tools — `packages/pi-planning/plan-tools/`

- **Files:** `index.ts`, `helpers.ts`, `open-in-pane.ts`, `resolve-spec-path.ts`,
  `resolve-feature-path.ts`.
- **Tools:** `resolve_spec_path`, `resolve_feature_path`, `open_in_pane`.
- **Commands:** `/plan <JIRA_ID>` (duplicate registration — see
  pi-interactive-subagents above for who wins) and `/review-spec <path>`.
- **Spec path convention:** `<notes-root-or-repo>/notes/specs/<JIRA_ID>__<slug>.md`
  (slug = first 5 lowercase words, non-alnum stripped; `$LLM_NOTES_ROOT` overrides
  for a central notes vault).
- **Feature path convention:** `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`
  if set, else `<git-toplevel>/.pi/plans/<date>-<slug>/plan.md`.
- **`open_in_pane`** opens a plan/spec with **nvim** (glow was replaced) in a herdr
  `spec-review` pane — calls the `herdr` CLI directly (deliberate, no cross-package
  import for 3 exec calls); non-fatal when herdr is missing.

### implement-plan — `packages/pi-planning/implement-plan/`

- **Files:** `index.ts` (the `/implement` command), `jira-branch-tool.ts`.
- **Tools:** `jira_create_branch` (shared `shared/jira-branch.ts`; registered here
  for standalone installs). Derives a branch from a Jira issue (type → prefix,
  summary → slug), optional git-town parent to `develop`. Requires `acli` +
  `git-town`.
- **Command:** `/implement <AVEN-REF | JIRA-ID>` — routes to the
  **implement-plan-aven** skill (execution state lives in aven, not here).
- See [Planning workflow](../workflows/planning-and-implementation.md) for the
  full aven data model and plan-state gate.

## pi-review (review + sonarqube + pr-quality)

Three extensions sharing `packages/pi-review/shared/sonarqube-utils.ts`.

### review — `packages/pi-review/review/review.ts`

- **Command:** `/review [pr <n>|pr <url>|uncommitted|branch <name>|commit <sha>|folder <paths...>|custom "<instructions>"]`
  with an interactive selector when called with no args.
- **What:** Prompts the agent to review code changes. When a supported multiplexer is
  available, `/review` **spawns a `reviewer` subagent** via `pi-interactive-subagents`
  programmatic API (`launchSubagent`, `d90713f`) — findings steer back into the session
  when the review completes. The legacy in-session path remains as fallback when
  there's no mux or the spawn fails; with a mux available, every mode runs in the
  subagent.
- **PR reviews are worktree-based by default:** with Herdr + mux, the PR is fetched
  into a dedicated `review/pr-<n>` branch in its own Herdr worktree; the worktree
  (and branch) is auto-removed when all jobs finish. Fresh worktrees run
  `yarn install` with `GH_TOKEN` propagated. Only the legacy no-Herdr path
  in-place-checks-out the PR and requires a clean tree.
- **ocr second opinion:** with the `ocr` binary on PATH, every diff-based target
  also spawns a pure-runner **scout** subagent running
  `ocr <args> --format json --output <tmpfile>` and catting it back — the JSON
  steers in as an `ocr_result` message. Target mapping: PR →
  `review --from <base> --to <worktree-branch>`; base branch →
  `--from <merge-base> --to HEAD`; uncommitted → workspace `review`; commit →
  `--commit <sha>`; folder → `scan --path <paths>`. PR worktrees are refcounted
  (`pending` = reviewer + ocr scout) so a fast reviewer can't tear the worktree
  out from under a still-running scout.
- **ocr delegate preset:** "Review with ocr delegate rules" — the reviewer subagent
  itself runs `ocr delegate preview` + `ocr delegate rule` (LLM-free) and applies
  the resolved rules to the diff; no ocr LLM configuration needed.
- Injects semantic-tool guidance (`buildSemReviewGuidance` from `sem-guidance.mjs`)
  so the review prompt tells the agent to prefer `sem_diff`/`sem_impact` when
  `pi-sem` is available.
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

## pi-teams-transcript

- **Files:** `packages/pi-teams-transcript/index.ts` (+ test), `config.schema.json`
- **Registers:** `teams_transcript` tool; `/teams-transcript-sync`,
  `/teams-transcript-summarize`, `/teams-transcript-weekly`, and
  `/teams-transcript-push` commands.
- **What:** Microsoft Graph (app-only) access to Teams meeting transcripts:
  list meetings, list/download transcripts, plus sync/summarize/weekly/push
  workflows over synced `.vtt` + `.md` stubs. `/teams-transcript-push` pushes
  notes + raw transcripts into a remote ZenNotes workspace vault via the `zn`
  CLI (config `znServer`/`znToken` or `ZENNOTES_SERVER`/`ZENNOTES_REMOTE_TOKEN`),
  dedup-checked per file and moved to `outDir/pushed/` so re-runs are no-ops.
- Tenant settings gate everything (Graph access master switch, speaker
  attribution) — see the README troubleshooting table for the exact 403 modes.

## pi-sudo

- **Files:** `packages/pi-sudo/index.ts` (+ test)
- **Registers:** `sudo_run` tool.
- **What:** Executes a shell command as root behind a two-stage overlay: an
  Allow/Deny confirmation showing the command + the AI's stated reason, then an
  inline masked password field (60s inactivity timeout auto-denies). The password
  is piped to `sudo -S` on stdin — never written to disk, never in tool results
  (fixed a leak into command stdin in `484faa8`). Requires TUI mode; every call
  re-prompts (no PAM caching).

## pi-aven-context

- **Files:** `packages/pi-aven-context/index.ts` (+ test)
- **Registers:** `session_start` handler only — no commands, no config.
- **What:** Runs `aven prime` from the session cwd and injects the live portion
  (local conventions, open issues, active/ready/blocked breakdown) as a hidden
  custom message at session start. The static CLI primer head is stripped (the
  `aven` skill already provides it). Non-fatal — a missing/slow `aven` binary
  silently skips; idempotent across resume/fork/reload via an existing-entry
  check on the session branch.

## Next

- [Planning & implementation workflow](../workflows/planning-and-implementation.md)
- [Code review workflow](../workflows/code-review.md)
