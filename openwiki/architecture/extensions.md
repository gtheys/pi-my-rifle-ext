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
  Note: `pi-planning` no longer registers `/plan` at all (its plan-tools only
  register `/review-spec`), so there is no load-order collision in the
  monorepo.
- **Subagent env:** epimetheus (Hindsight memory) is **disabled** in subagent
  sessions (`EPIMETHEUS_ENABLED=false`) — its pending-queue markers for
  ephemeral/crashed subagent sessions orphaned and warned on every parent quit;
  subagent work is retained via the parent session's steering summary.
- **Herdr stderr** is piped and classified (`03637f9`,
  `subagents/herdr.ts`): expected failures (e.g. tab already exists) no longer
  leak raw stderr into the TUI.
- **Durable assignments** (`subagents/assignments.ts`) record running children
  per parent so a restarted parent can rediscover them; `/flow` consults them
  to avoid halting while a subagent is in flight (`90f41b6`).
- **Agent frontmatter** is fully documented in `docs/agent-frontmatter.md`
  (`be716a1`); the bundled `reviewer`/`worker` agents were moved off
  github-copilot models (`042e55d`).
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
- **Commands:** `/review-spec <path>` only — the old duplicate `/plan`
  registration was removed; `/plan` is owned solely by
  pi-interactive-subagents.
- **Spec path convention:** `<notes-root-or-repo>/notes/specs/<JIRA_ID>__<slug>.md`
  (slug = first 5 lowercase words, non-alnum stripped; `$LLM_NOTES_ROOT` overrides
  for a central notes vault).
- **Feature path convention:** `$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`
  if set, else `<git-toplevel>/.pi/plans/<date>-<slug>/plan.md`.
- **`open_in_pane`** opens a plan/spec with **nvim** (glow was replaced) in a herdr
  `spec-review` pane — calls the `herdr` CLI directly (deliberate, no cross-package
  import for 3 exec calls); non-fatal when herdr is missing.

### implement-plan — `packages/pi-planning/implement-plan/`

- **Files:** `index.ts` (tool registration only), `jira-branch-tool.ts`.
- **Tools:** `jira_create_branch` (shared `shared/jira-branch.ts`; registered here
  for standalone installs). Derives a branch from a Jira issue (type → prefix,
  summary → slug), optional git-town parent to `develop`. Requires `acli` +
  `git-town`.
- **No commands:** the old ungated `/implement` was removed — it collided with
  pi-flow's gated `/implement` (pi suffixes duplicates as `/implement:1`). The
  implement-plan-aven skill stays reachable via natural phrases or
  `/skill:implement-plan-aven` (in-file AIDEV-NOTE).
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
- **Verdict emission** (`review/verdict.ts`, `9ae1fce`): the review prompt
  instructs the reviewer to end with a `blockers_count: <N>` verdict, and the
  extension emits/parses that count natively so `pi-flow`'s review gate can
  consume it without re-parsing prose.
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

## pi-flow (RPIV flow)

- **Files:** `packages/pi-flow/index.ts` (all registrations), `flow/` (loop, args,
  label-gate, land-gate, ensure-labels, aven-resolve, ref-kind, jira-ref,
  phase-prompts, orchestrate), `spec-review/` (approve, aven-spec, publish,
  open-in-pane, picker), `research|plan|implement|validate|feedback/` (one
  subdir per phase: args + prompt), `run-state.ts`, `herdr/` (viewer, sync).
- **Commands:** `/research`, `/plan`, `/implement`, `/validate`, `/feedback`,
  `/flow` (orchestrator loop), `/spec-review`, `/spec-publish`, plus the Herdr
  pair `/flow-view <ref>` and `/herdr-sync`.
- **Tools (agent-callable gates):** `flow_phase_complete` (the ONLY way to write
  lifecycle labels — direct `aven edit --label` mutations are blocked by
  `flow/label-gate.ts`), `flow_land` (gates push/PR creation behind the
  `review-passed` label + optional `blockers_count` artifact — direct
  `git push` / `gh pr create` are blocked by `flow/land-gate.ts` while a flow
  is active), `flow_run_attempt` (owns the retry budget: **3 total attempts**,
  the 3rd failure returns an escalation error and further attempts are
  refused), `spec_approve` (only path from plan-state `review` → `approved`).
- **What:** Drives the five RPIV phases with aven labels as run state
  (`researched → planned → active → review-passed → done`). `/flow` injects one
  phase prompt at a time and advances only when the phase turn settles **and**
  its completion label landed; it no longer halts mid-phase while a subagent
  is in flight (`90f41b6`, via pi-interactive-subagents durable assignments).
  A flow pauses gracefully while a spec awaits approval (`be43caf`) instead of
  forcing a halt.
- **Aven resolution** (`flow/aven-resolve.ts`): workspace comes from the
  **session cwd** (`c0145ea`, `8155cd9` — config override and `avenWorkspace`
  are both resolved per-session, not process-global), falling back to
  `aven show` → exact-ref `aven search` → workspace sweep; the resolved
  workspace is pinned per ref. `flow/ref-kind.ts` is the escape hatch for
  numeric aven refs that would otherwise parse as Jira-shaped.
- **Spec review** (`spec-review/`): `/spec-review` batch-picks specs at
  `plan-state=review` and opens each plan.md in a herdr nvim pane;
  `spec_approve` pins the `plan` label and flips plan-state to approved;
  `/spec-publish` spawns a worker that publishes the approved plan.md to the
  ticket's notes repo. Workspace resolution is threaded through all of them
  (`00648c5`).
- **Herdr plugin subset:** the repo doubles as a Herdr plugin (root
  `herdr-plugin.toml` + `plugins/herdr/flow-viewer.mjs`). `/flow` journals run
  events to `~/.pi/agent/pi-flow/runs/<ref>.json` (append-only
  `<ref>.journal.jsonl` alongside); `/flow-view` opens/focuses a Herdr pane
  rendering that state (dedupe by pane label `flow · <ref>` via
  `herdr api snapshot` — survives Pi reloads); `/herdr-sync` links the plugin
  explicitly and idempotently (preflight enforces manifest/package version
  equality). Aven labels remain the gate source of truth; the journal is an
  evidence record only. Full design:
  [`docs/herdr-flow-integration.md`](../../docs/herdr-flow-integration.md).
- **Invariants:** no polling/daemon/state-store on the Pi side; public herdr
  verbs only; 5s exec timeouts + bounded JSON parsing; panes resolve nothing
  from PATH (session passes `PI_FLOW_REF`/`PI_FLOW_RUN_FILE` via `--env`).
- **Config:** `~/.pi/agent/pi-flow/config.json` — `workRoots` (work-vs-personal
  mode by path prefix), `avenWorkspace` (pin a workspace, skip inference).

## Next

- [Planning & implementation workflow](../workflows/planning-and-implementation.md)
- [Code review workflow](../workflows/code-review.md)
