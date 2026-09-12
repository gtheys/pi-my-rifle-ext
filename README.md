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
│   ├── pi-fastcontext/      # fast_context_search tool + /fastcontext
│   ├── pi-planning/         # plan-tools + implement-plan
│   ├── pi-sem/              # pi-sem semantic code tools
│   ├── pi-tool-pills/       # tool pill badges + Shiki diff rendering
│   ├── pi-desktop-notify/   # /notify command
│   ├── pi-aven-context/       # aven workspace state session-start context
│   ├── pi-teams-transcript/ # teams_transcript tool (MS Graph)
│   └── pi-pr-digest/        # pr_digest tool + /pr-digest command (gh CLI)
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

---

## Extensions

### Local Extensions

| Package | Description | Category |
|---------|-------------|----------|
| [`pi-bootstrap`](packages/pi-bootstrap/) | Startup bootstrap — symlinks `agents/AGENTS.md` to `~/.pi/agent/AGENTS.md` | Bootstrap |
| [`pi-ask-user-question`](packages/pi-ask-user-question/) | `ask_user_question` tool — pauses execution for interactive text / single-select / multi-select questions with an Other free-text escape hatch | Interaction |
| [`pi-prompt-snippets`](packages/pi-prompt-snippets/) | One-shot prompt snippets — alt+s / `/snippets` toggle menu, bodies prepended/appended to the next message, widget shows active set | Interaction |
| [`pi-review`](packages/pi-review/) (review) | `/review` command — code review for PRs, branches, uncommitted changes, or specific commits with semantic tool guidance | Code Review |
| [`pi-review`](packages/pi-review/) (sonarqube) | `/sonarqube` command — fetches SonarCloud coverage gaps and quality issues for a PR, generates actionable report | Code Quality |
| [`pi-review`](packages/pi-review/) (pr-quality) | `/pr-quality` command — combines GitHub PR review triage + SonarCloud analysis into a unified action plan | Code Quality |
| [`pi-tool-pills`](packages/pi-tool-pills/) | Colored pill badges for tool headers + Shiki-powered syntax-highlighted diffs for write/edit | UI Enhancement |
| [`pi-sem`](packages/pi-sem/) | Semantic code analysis tools — entity-level diff, impact analysis, context lookup, and blame via `pi-sem` | Code Analysis |
| [`pi-desktop-notify`](packages/pi-desktop-notify/) | `/notify` command — desktop notifications (notify-send) when pi finishes work after an idle period | Notifications |
| [`pi-test-runner`](packages/pi-test-runner/) | `run_tests` tool + `/test-runner` command — runs JS/TS tests from `package.json` in an isolated pi-interactive-subagents worker; visible in the orchestrator's subagents widget; results injected back when done ⚠️ *experimental/WIP* | Testing |
| [`pi-interactive-subagents`](packages/pi-interactive-subagents/) | `subagent` tool + `/plan` dispatch command — spawn scout/worker/planner sub-agents in cmux/tmux/zellij/wezterm/herdr panes, with a live status widget and programmatic `launchSubagent`/`watchSubagent` API; `/plan` routes to the create-plan/feature-plan skills (bundled generic workflow as fallback) | Orchestration |
| [`pi-fastcontext`](packages/pi-fastcontext/) | `fast_context_search` tool + `/fastcontext` command — fast read-only codebase search via local Microsoft FastContext (llama.cpp); returns compact `file:line` citations | Code Search |
| [`pi-planning`](packages/pi-planning/) (plan-tools) | Taskwarrior tools for spec/plan creation (`tw_get_ticket`, `tw_get_spec_task`, `tw_get_phases`, `tw_get_impl_tasks`, `resolve_spec_path`, `resolve_feature_path`, `tw_create_spec_task`, `tw_create_phase`, `tw_create_impl_task`, `jira_create_branch`) | Planning |
| [`pi-planning`](packages/pi-planning/) (implement-plan) | `/implement` command + taskwarrior tools (`tw_execution_plan` — by Jira ID **or** feature UUID, `tw_advance_task`, `tw_phase_checkpoint`) for driving implementation from a spec or feature tree | Planning |
| [`pi-aven-context`](packages/pi-aven-context/) | Session-start injection of live aven workspace state (`aven prime` tail: open issues, active/ready/blocked) as hidden custom-message context; non-fatal, idempotent | Context |
| [`pi-teams-transcript`](packages/pi-teams-transcript/) | `teams_transcript` tool — list/download Microsoft Teams meeting transcripts via Microsoft Graph (app-only auth) ⚠️ *work in progress* | Integrations |
| [`pi-pr-digest`](packages/pi-pr-digest/) | `pr_digest` tool + `/pr-digest` command — outstanding GitHub PRs in an org with human comment/review status (bots filtered) and reviewer-request table | Integrations |
| [`pi-worktree`](packages/pi-worktree/) | `worktree` tool — create/list/remove Herdr worktree workspaces with branch derivation, lockfile-based dependency bootstrap, `.env` snapshots, and a pi agent state dashboard | Git Workflow |

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
| `create-plan` | Create detailed implementation plans from Jira tickets via taskwarrior; codebase research runs in parallel `scout` subagents; local features delegate to `feature-plan` |
| `debug` | Bootstrap a debugging session — investigates pod logs, DB state, and git history without editing files |
| `feature-plan` | Plan a local feature (no Jira) end to end — interview, scout subagents, interactive planner agent, `plan.md` artifact under `$PERSONAL_FEATURES`, and a taskwarrior feature hierarchy (`jirastatus:Local`) |
| `feature-ticket` | Interview-driven feature ticket creation for personal projects; records as Taskwarrior ticket |
| `gh-unresolved-comments` | Fetch unresolved PR review comments, classify as VALID/INVALID, auto-resolve stale threads, produce resolution plan |
| `implement-plan` | Execute an approved implementation spec from the taskwarrior phase/subtask tree (Jira ID or feature UUID); each subtask is implemented by a sequential `worker` subagent |
| `iterate-plan` | Iterate on existing implementation specs with thorough research and updates |
| `notes-locator` | Discover relevant documents in `notes/` or `$LLM_NOTES_ROOT` for a given topic or task |
| `pr-description` | Generate comprehensive PR descriptions following repository templates |
| `tdd-workflow` | TDD workflow enforcement with 80%+ coverage — unit, integration, and E2E |
| `teams-pr-notify` | Send PR review request as Adaptive Card to a Microsoft Teams channel via Power Automate |

### Tools

| Skill | Description |
|-------|-------------|
| `acli` | Atlassian CLI reference — Jira work items, projects, boards, sprints, filters, dashboards, org admin |
| `atlas` | Database schema management and migrations with Atlas CLI — generate, diff, lint, test, and apply migrations; ORM schema support |
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
    ├─ arg matches JIRA ID ──> injects create-plan skill
    ├─ free text ───────────> injects feature-plan skill
    └─ skills/ unreadable ──> bundled generic plan-skill.md (standalone installs)

create-plan ──uses──> tw_get_ticket, tw_get_spec_task, tw_get_phases,
    │                 tw_get_impl_tasks, resolve_spec_path,
    │                 tw_create_spec_task, tw_create_phase,
    │                 tw_create_impl_task, jira_create_branch   (pi-planning)
    ├─uses──> scout subagents                                (pi-interactive-subagents)
    └─for local features──> delegates to feature-plan

feature-plan ──uses──> resolve_feature_path, tw_execution_plan (pi-planning)
    ├─uses──> scout + planner subagents                      (pi-interactive-subagents)
    └─writes──> taskwarrior hierarchy + plan.md ($PERSONAL_FEATURES or .pi/plans)

iterate-plan ──uses──> same tool set as create-plan

implement-plan ──uses──> tw_execution_plan (jira_id or feature_uuid),
    │                     tw_advance_task, tw_phase_checkpoint (pi-planning)
    └─uses──> worker subagents                               (pi-interactive-subagents)

/implement command (pi-planning implement-plan/index.ts)
    └─ pre-populates the execution plan for the implement-plan skill

feature-ticket ──uses──> raw `task` CLI only (no extension dependency)
```

### Rules of the road

| Rule | Detail |
|------|--------|
| Commands belong to exactly one package | Both `pi-interactive-subagents` and `pi-planning` register `/plan`; the **first registration wins** (load order = root `package.json` `pi.extensions`). `pi-planning`'s `/plan` is effectively dead — kept only because standalone npm installs of `pi-planning` load it without the subagents package. |
| Skills degrade gracefully | `create-plan`/`feature-plan`/`implement-plan` all document a fallback when the `subagent` tool is missing (no multiplexer): research/implementing happens in the main session instead of scout/worker panes. |
| Tool names are contracts | A skill referencing `tw_execution_plan` breaks if `pi-planning` is not loaded — pi reports the tool as unavailable and the skill's fallback path takes over. |
| Agents are package data | `scout`/`worker`/`planner`/`reviewer` definitions live in `pi-interactive-subagents/agents/` and resolve project-local `.pi/agents/` first, then `~/.pi/agent/agents/`, then the bundled copy. |
| Dispatch has a fallback | `/plan` with free text in a standalone install (no `skills/` dir) falls back to the bundled generic planner workflow — feature-planning without taskwarrior. |

### Data contracts

- **Jira flow**: spec path from `resolve_spec_path` (`$LLM_NOTES_ROOT/<repo>/notes/specs/<JIRA>__<slug>.md`), annotated as `Spec(repo=<repo>): <path>` on the spec task; hierarchy under `SalaryHero.<project>` via `tw_create_*` tools.
- **Feature flow**: plan.md from `resolve_feature_path` (`$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`, or `.pi/plans/` fallback), annotated on the feature task; hierarchy via raw `task` CLI with `jirastatus:Local`, `+feature`/`+phase`/`+impl` tags, `N.`/`N.M` description prefixes (the execution plan sorts by them).

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
