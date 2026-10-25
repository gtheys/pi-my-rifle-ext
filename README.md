# The Coder's Creed

![This is my gun](assets/this_is_my_gun.png)

This is my Pi Agent. There are many like it, but this one is mine.

My Pi Agent is my best friend. It is my life. I must master it as I must master my life.

Without me, my Pi Agent is useless. Without my Pi Agent, I am useless — just a person staring at a terminal, mass-producing typos at scale.
I must prompt my Pi Agent true. I must code straighter than the bugs that are trying to kill my deploy. I must ship before they crash me. I will.

My Pi Agent and I know that what counts in coding is not the tokens we burn, the noise of our logs, nor the smoke from our GPUs. We know that it is the commits that count. We will commit.

My Pi Agent is human — even though it is not. Thus, I will treat it as a brother. I will learn its weaknesses, its strengths, its context window, its hallucinations, its token limits, and its uncanny ability to apologize for things that aren't its fault.

Before God, I swear this creed. My Pi Agent and I are the defenders of the codebase. We are the masters of our bugs. We are the saviors of my sprint.

So be it, until there are no bugs — only features.

And the backlog is empty.

Which it never will be.

Amen.

# pi-my-rifle-ext

Personal pi extensions, skills, commands, and themes.

## Structure

This is a [bun](https://bun.sh) workspace monorepo. Each extension group lives under `packages/*` as its own package declaring `pi.extensions` and `peerDependencies`. Shared helpers are co-located with their only consumer.

```
pi-my-rifle-ext/
├── packages/          # Workspace packages (each a pi extension group)
│   ├── pi-bootstrap/        # Startup bootstrap (symlinks AGENTS.md)
│   ├── pi-ask-user-question/ # ask_user_question tool (interactive TUI dialogs)
│   ├── pi-prompt-snippets/  # one-shot prompt snippet toggles (alt+s / /snippets)
│   ├── pi-review/           # review + sonarqube + pr-quality
│   ├── pi-test-runner/      # run_tests tool + /test-runner command
│   ├── pi-interactive-subagents/ # subagent orchestration (scout/worker/planner/…)
│   ├── pi-planning/         # plan-tools + implement-plan
│   ├── pi-sem/              # pi-sem semantic code tools
│   ├── pi-tool-pills/       # tool pill badges + Shiki diff rendering
│   ├── pi-desktop-notify/   # /notify command
│   ├── pi-teams-transcript/ # teams_transcript tool (MS Graph)
│   ├── pi-pr-digest/        # pr_digest tool + /pr-digest command (gh CLI)
│   ├── pi-aven-context/     # aven workspace state session-start context
│   ├── pi-flow/             # RPIV flow orchestrator (phases, gate tools, run-state journal, Herdr viewer)
│   ├── pi-worktree/         # worktree tool (Herdr worktree workspaces)
│   ├── pi-sudo/             # sudo_run tool (confirm dialog + masked password)
│   └── pi-herdr-title/      # renames the herdr pane to `Pi - <cwd>` on session start
├── skills/            # Skills (each in a subdirectory with SKILL.md)
│   ├── engineering/
│   └── tools/
├── prompts/          # Prompt templates / slash commands (.md files)
├── themes/           # Theme JSON files
├── agents/           # AGENTS.md (symlinked to ~/.pi/agent/ on startup)
├── mise.toml         # bun toolchain pin + task runner
├── biome.json        # lint + format (scoped to packages/**)
├── lefthook.yml      # git hooks (pre-commit biome, pre-push check)
├── tsconfig.json     # root typecheck
└── package.json      # workspace manifest + pi package manifest
```

## Usage

Load locally by adding the repo to `settings.json`:

```json
{
  "packages": [
    "/home/geert/Code/personal/pi-my-rifle-ext"
  ]
}
```

### Bootstrap on a fresh machine

Installs the pinned bun toolchain, repo npm deps, and the external pi packages
(ponytail, pi-vcc, pi-intercom, …) into global `~/.pi/agent`. Idempotent —
re-run after editing the list in `scripts/install-pi-packages.sh`.

```bash
mise install        # pinned bun toolchain
mise run setup      # bun install (repo deps + lefthook hooks)
mise run pi-install # external pi packages (global, idempotent)
```

## Development

Requirements: [mise](https://mise.jdx.dev/) and bun (pinned via `mise.toml`).

```bash
mise install     # install the pinned bun toolchain
mise run setup   # bun install (+ lefthook hooks)

mise run format     # biome format + safe fixes
mise run lint       # biome check
mise run typecheck  # tsc --noEmit over packages/**
mise run test       # node --test across workspaces
mise run check      # lint && typecheck && test
```

Git hooks (installed by `lefthook`):

- **pre-commit** — runs biome on staged `packages/**` files and re-stages fixes.
- **pre-push** — runs `bun run check`.

Third-party pi packages (token reducers, compactors, etc.) are **not** bundled here. Install them separately so they load from user settings instead of this repo's `node_modules`:

```bash
pi install npm:@tomooshi/condensed-milk-pi
pi install npm:@tomooshi/caveman-milk-pi
pi install npm:@sting8k/pi-vcc
pi install npm:pi-intercom
pi install git:github.com/DietrichGebert/ponytail
```

### Tested version baseline

<!-- AIDEV-NOTE: PMR-0SWR. Update after integration runs against newer versions. -->

| Component | Tested | Runtime floor |
|---|---|---|
| `@earendil-works/pi-coding-agent` | 1.4.0 | per package `peerDependencies` |
| [herdr](https://github.com/steipete/herdr) | 0.9.5 | >= 0.9.1 (enforced at runtime by `pi-interactive-subagents`' `HERDR_MIN_VERSION` gate) |

Before publishing, run `bun run audit:pack` (`scripts/package-audit.mjs`): it checks every workspace's `npm pack --dry-run` output against its `files` allowlist and scans packed contents for secrets and absolute home paths, failing on any violation.

---

## Extensions

### Local Extensions

| Package | Description | Category |
|---------|-------------|----------|
| [`pi-bootstrap`](packages/pi-bootstrap/) | Startup bootstrap — symlinks `agents/AGENTS.md` to `~/.pi/agent/AGENTS.md` | Bootstrap |
| [`pi-ask-user-question`](packages/pi-ask-user-question/) | `ask_user_question` tool — pauses execution for interactive text / single-select / multi-select questions with an Other free-text escape hatch | Interaction |
| [`pi-prompt-snippets`](packages/pi-prompt-snippets/) | One-shot prompt snippets — alt+s / `/snippets` toggle menu, bodies prepended/appended to the next message, widget shows active set | Interaction |
| [`pi-review`](packages/pi-review/) (review) | `/review` command — code review for PRs, branches, uncommitted changes, commits, or folders with semantic tool guidance; optional OpenCodeReview second opinion (JSON) and ocr delegate preset (agent applies ocr rules, no ocr LLM) | Code Review |
| [`pi-review`](packages/pi-review/) (sonarqube) | `/sonarqube` command — fetches SonarCloud coverage gaps and quality issues for a PR, generates actionable report | Code Quality |
| [`pi-review`](packages/pi-review/) (pr-quality) | `/pr-quality` command — combines GitHub PR review triage + SonarCloud analysis into a unified action plan | Code Quality |
| [`pi-tool-pills`](packages/pi-tool-pills/) | Colored pill badges for tool headers + Shiki-powered syntax-highlighted diffs for write/edit | UI Enhancement |
| [`pi-sem`](packages/pi-sem/) | Semantic code analysis tools — entity-level diff, impact analysis, context lookup, and blame via `pi-sem` | Code Analysis |
| [`pi-desktop-notify`](packages/pi-desktop-notify/) | `/notify` command — desktop notifications (notify-send) when pi finishes work after an idle period | Notifications |
| [`pi-test-runner`](packages/pi-test-runner/) | `run_tests` tool + `/test-runner` command — runs JS/TS tests from `package.json` in an isolated pi-interactive-subagents worker; visible in the orchestrator's subagents widget; results injected back when done ⚠️ *experimental/WIP* | Testing |
| [`pi-interactive-subagents`](packages/pi-interactive-subagents/) | `subagent` tool + `/plan` dispatch command — spawn scout/worker/planner sub-agents in cmux/tmux/zellij/wezterm/herdr panes, with a live status widget and programmatic `launchSubagent`/`watchSubagent` API; `/plan` routes aven-first to the feature-plan-aven skill (bundled generic workflow as fallback) | Orchestration |
| [`pi-planning`](packages/pi-planning/) (plan-tools) | Aven-era planning helpers: `resolve_spec_path`, `resolve_feature_path`, `open_in_pane` tools + `/review-spec` command | Planning |
| [`pi-planning`](packages/pi-planning/) (implement-plan) | `jira_create_branch` tool for Jira-synced tickets (the old ungated `/implement` command was removed — it collided with pi-flow's gated RPIV `/implement`; the implement-plan-aven skill is invoked via phrases or `/skill:implement-plan-aven`) | Planning |
| [`pi-aven-context`](packages/pi-aven-context/) | Session-start injection of live aven workspace state (`aven prime` tail: open issues, active/ready/blocked) as hidden custom-message context; non-fatal, idempotent | Context |
| [`pi-teams-transcript`](packages/pi-teams-transcript/) | `teams_transcript` tool — list/download Microsoft Teams meeting transcripts via Microsoft Graph (app-only auth) ⚠️ *work in progress* | Integrations |
| [`pi-pr-digest`](packages/pi-pr-digest/) | `pr_digest` tool + `/pr-digest` command — outstanding GitHub PRs in an org with human comment/review status (bots filtered) and reviewer-request table | Integrations |
| [`pi-flow`](packages/pi-flow/) | RPIV flow orchestrator — `/research /plan /implement /validate /feedback /flow` plus `/spec-review` / `/spec-publish`, gate tools (`flow_phase_complete`, `flow_land`, `flow_run_attempt`, `spec_approve`) that own lifecycle labels/landing/retry budget/spec approval, work-mode detection (`workRoots` config), durable run-state journal (`~/.pi/agent/pi-flow/runs/`), and Herdr integration (`/herdr-sync`, `/flow-view`) — see [docs/herdr-flow-integration.md](docs/herdr-flow-integration.md) | Workflow |
| [`pi-worktree`](packages/pi-worktree/) | `worktree` tool — create/list/remove Herdr worktree workspaces with branch derivation, lockfile-based dependency bootstrap, `.env` snapshots, and a pi agent state dashboard | Git Workflow |
| [`pi-sudo`](packages/pi-sudo/) | `sudo_run` tool — root command execution behind an Allow/Deny confirmation + masked password prompt (password piped to `sudo -S`, never persisted) | System |
| [`pi-herdr-title`](packages/pi-herdr-title/) | Renames the current herdr pane to `Pi - <cwd>` on session start; no-op outside herdr | UI Enhancement |

### Companion Packages (installed separately)

These complementary pi packages are **not** part of this repo. Install them with `pi install` so they load from your user settings:

| Package | Description | Category |
|---------|-------------|----------|
| [@tomooshi/condensed-milk-pi](https://github.com/tomooshi/condensed-milk-pi) | Semantic token compression — filters noisy bash output and retroactively masks stale tool results | Token Reduction |
| [@sting8k/pi-vcc](https://www.npmjs.com/package/@sting8k/pi-vcc) | Algorithmic conversation compactor — transcript-preserving summaries, no LLM calls, searchable via `vcc_recall` | Token Reduction |
| [@tomooshi/caveman-milk-pi](https://www.npmjs.com/package/@tomooshi/caveman-milk-pi) | Injects caveman terseness rules into system prompt — cache-safe, opt-in | Token Reduction |
| [ponytail](https://github.com/DietrichGebert/ponytail) | Forces the laziest working solution — YAGNI, stdlib/native first, shortest diff, deletion over addition; channels a senior dev who has seen every over-engineered codebase | Coding Behavior |
| [@gtheys/pi-per-commit-spend](https://www.npmjs.com/package/@gtheys/pi-per-commit-spend) | Tracks AI spend per git commit across sessions — calculates cost from token counts for subscription providers | Cost Tracking |

---

## Skills

### Engineering

| Skill | Description |
|-------|-------------|
| `coding-standards` | Universal coding standards, best practices, and patterns for TypeScript, JavaScript, React, and Node.js development |
| `explore` | Pre-ticket codebase Q&A — direct search for quick questions, scout subagents for broad mapping, hindsight/cognee memory for past decisions; exit ramp to a oneshot ticket or a feature plan |
| `feature-plan-aven` | Plan an aven ticket end to end — pickup, interview, scout subagent, interactive planner agent, plan.md artifact, plan-state gate (draft → review → approved), then the aven epic/dep tree; handles aven refs, aven-synced Jira IDs, and local features |
| `implement-plan-aven` | Execute an aven feature tree phase by phase in an isolated Herdr git worktree — worker subagents, test/commit cycle per phase; oneshot path for self-sufficient tickets |
| `feature-ticket` | Interview-driven feature ticket creation for personal projects; records as Taskwarrior ticket |
| `debug` | Structured debugging session — redact secrets, reproduce/minimise, rank hypotheses, fix with a regression test; optional Jira/aven bootstrap and SH infra flag |
| `gh-unresolved-comments` | Fetch unresolved PR review comments, classify as VALID/INVALID, auto-resolve stale threads, produce resolution plan |
| `notes-locator` | Discover relevant documents in `notes/` or `$LLM_NOTES_ROOT` for a given topic or task |
| `pr-description` | Generate comprehensive PR descriptions following repository templates |
| `subagent-orchestration` | Playbook for orchestrating pi-interactive-subagents — parallel fan-out, worktree isolation, ask_owner vs message_owner, resuming orphaned children (symlinked from `packages/pi-interactive-subagents/skills/`) |
| `tdd-workflow` | TDD workflow enforcement with 80%+ coverage — unit, integration, and E2E |
| `teams-pr-notify` | Send PR review request as Adaptive Card to a Microsoft Teams channel via Power Automate; digest mode backed by pi-pr-digest |
| `ts-js-architecture-review` | Architecture and module-boundary review for mixed TS/JS codebases — dependency direction, circular imports, JS/TS seam type-safety |
| `ts-js-refactoring-advisor` | Plan and carry out safe refactors in mixed TS/JS codebases — small behavior-preserving steps, impact analysis first |

### Tools

| Skill | Description |
|-------|-------------|
| `acli` | Atlassian CLI reference — Jira work items, projects, boards, sprints, filters, dashboards, org admin |
| `aws-architecture-diagram` | Generate validated AWS architecture diagrams as draw.io XML using official AWS4 icon libraries; supports codebase analysis and interactive brainstorm modes |
| `cli-microsoft365` | CLI for Microsoft 365 — SharePoint, Entra ID, Teams, Power Platform, Graph API |
| `devctl` | `devctl` CLI guide for the SalaryHero local Kubernetes dev environment (minikube-based) |
| `jira-status-timestamps` | Set up Jira status-entry timestamps via custom datetime fields and Automation rules |
| `qmd` | Search local markdown knowledge bases, notes, docs, and wikis with QMD |
| `sem` | Entity-aware code change analysis via pi-sem tools — diff, impact, context, blame, history |
| `worktrunk` | `wt` CLI for git worktree workflows — switching, creating, merging, hooks, LLM commit generation |

---

## How Extensions and Skills Fit Together

The planning stack spans two packages and five skills. Extensions own the
**tools and commands** (TypeScript, registered via `pi.extensions`); skills own
the **workflows** (markdown, loaded from `skills/`). Skills have no code — every
tool they name must be registered by a loaded extension, and every command
they depend on must be registered by exactly one package.

### Dependency map

```
/plan command (pi-interactive-subagents)
    ├─ any arg (aven ref, Jira-shaped, or free text)
    │        ─────────────> injects the feature-plan-aven skill (aven-first:
    │                       aven refs, aven-synced Jira IDs, and local features;
    │                       workspace routed by cwd)
    └─ skills/ unreadable ──> bundled generic plan-skill.md (standalone installs)

feature-plan-aven ──uses──> aven CLI (ticket state), resolve_feature_path,
    │                       jira_create_branch                  (pi-planning)
    ├─uses──> scout + planner subagents           (pi-interactive-subagents)
    └─writes──> plan.md ($PERSONAL_FEATURES or .pi/plans) + aven epic/dep tree
                (plan-state gate: draft → review → approved; approval lands
                only via pi-flow's spec_approve tool)

implement-plan-aven ──uses──> aven CLI, jira_create_branch      (pi-planning)
    └─uses──> worker subagents in a Herdr worktree
                                              (pi-interactive-subagents, pi-worktree)

Reaching the skill: natural phrases ("implement PMR-ZTVG"),
/skill:implement-plan-aven <ref> — or pi-flow's gated /implement phase.

pi-flow /research /plan /implement /validate /feedback /flow
    ├─ owns run state as aven labels via flow_phase_complete (direct
    │   `aven edit --label` mutations are blocked while a flow is active)
    ├─ flow_land gates git push / gh pr create on the review-passed label
    ├─ flow_run_attempt owns the 3-attempt retry budget
    ├─ spec_approve is the only plan-state review → approved transition
    └─ /validate ends in a review gate consuming pi-review's
        blockers_count verdict

feature-ticket ──uses──> raw `task` CLI only (no extension dependency)
```

### Rules of the road

| Rule | Detail |
|------|--------|
| Commands belong to exactly one package | `pi-interactive-subagents` owns `/plan`; `pi-flow` owns the gated `/implement` (the old ungated `/implement` in pi-planning was removed — pi suffixes duplicates as `/implement:1`, making gated and ungated variants indistinguishable). |
| Skills degrade gracefully | `feature-plan-aven`/`implement-plan-aven` document a fallback when the `subagent` tool is missing (no multiplexer): research/implementing happens in the main session instead of scout/worker panes. |
| Tool names are contracts | A skill referencing `resolve_feature_path` or `flow_phase_complete` breaks if `pi-planning`/`pi-flow` is not loaded — pi reports the tool as unavailable and the skill's fallback path takes over. |
| Agents are package data | `scout`/`worker`/`planner`/`reviewer` definitions live in `pi-interactive-subagents/agents/` and resolve project-local `.pi/agents/` first, then `~/.pi/agent/agents/`, then the bundled copy. |
| Dispatch has a fallback | `/plan` in a standalone install (no `skills/` dir) falls back to the bundled generic planner workflow — feature-planning without aven. |

### Data contracts

- **Aven state**: the [aven](https://aven.raine.dev) CLI is the task store for both
  work and personal planning — tickets, epic/dep trees, labels, and `plan-state`
  metadata all live there (the old taskwarrior `tw_*` tools were removed). Skills
  call `aven` directly; `pi-aven-context` injects live workspace state at session
  start.
- **Jira flow**: spec path from `resolve_spec_path`
  (`$LLM_NOTES_ROOT/<repo>/notes/specs/<JIRA>__<slug>.md`); Jira tickets sync into
  aven via `jira-aven-sync` and are worked through a local epic (`jira-ref`
  metadata, dep-linked to the synced ticket).
- **Feature flow**: plan.md from `resolve_feature_path`
  (`$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`, or `.pi/plans/` fallback);
  the aven tree holds the epic → phase → subtask hierarchy with
  `N. Phase: <name>` / `N.M <title>` prefixes, and `plan-path` metadata points at
  the plan file.
- **Flow gates**: aven lifecycle labels
  (`researched → planned → active → review-passed → done`) are the `/flow` run
  state, written only through pi-flow's gate tools; the validate phase's review
  gate consumes a `blockers_count: <N>` verdict emitted natively by pi-review.

---

## Prompts

| Prompt | Description |
|--------|-------------|
| `git.md` | Git workflow helpers and commit message templates |

---

## Themes

| Theme | Description |
|-------|-------------|
| `tokyo-night.json` | Tokyo Night color theme |

---

## Repository Layout

This repo is a bun workspace. The workspace packages live under `packages/*` and
are all listed in the root `package.json` under `pi.extensions`. Add a new
extension group by creating `packages/pi-<name>/` with a `package.json`
(declaring `pi.extensions` and `peerDependencies`) and registering its entry
point in the root manifest. Run `mise run check` before pushing — the pre-push
hook does the same.
