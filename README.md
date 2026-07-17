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
│   ├── pi-context/          # /context command
│   ├── pi-review/           # review + sonarqube + pr-quality
│   ├── pi-test-runner/      # run_tests tool + /run-tests
│   ├── pi-fastcontext/      # fast_context_search tool + /fastcontext
│   ├── pi-planning/         # plan-tools + implement-plan
│   ├── pi-sem/              # pi-sem semantic code tools
│   ├── pi-tool-pills/       # tool pill badges + Shiki diff rendering
│   ├── pi-desktop-notify/   # /notify command
│   └── pi-teams-transcript/ # teams_transcript tool (MS Graph)
├── skills/            # Skills (each in a subdirectory with SKILL.md)
│   ├── engineering/
│   ├── productivity/
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
| [`pi-review`](packages/pi-review/) (review) | `/review` command — code review for PRs, branches, uncommitted changes, or specific commits with semantic tool guidance | Code Review |
| [`pi-review`](packages/pi-review/) (sonarqube) | `/sonarqube` command — fetches SonarCloud coverage gaps and quality issues for a PR, generates actionable report | Code Quality |
| [`pi-review`](packages/pi-review/) (pr-quality) | `/pr-quality` command — combines GitHub PR review triage + SonarCloud analysis into a unified action plan | Code Quality |
| [`pi-tool-pills`](packages/pi-tool-pills/) | Colored pill badges for tool headers + Shiki-powered syntax-highlighted diffs for write/edit | UI Enhancement |
| [`pi-sem`](packages/pi-sem/) | Semantic code analysis tools — entity-level diff, impact analysis, context lookup, and blame via `pi-sem` | Code Analysis |
| [`pi-desktop-notify`](packages/pi-desktop-notify/) | `/notify` command — desktop notifications (notify-send) when pi finishes work after an idle period | Notifications |
| [`pi-test-runner`](packages/pi-test-runner/) | `run_tests` tool — discovers and runs JS/TS tests from `package.json` using an isolated subagent; results injected back when done ⚠️ *experimental/WIP* | Testing |
| [`pi-fastcontext`](packages/pi-fastcontext/) | `fast_context_search` tool + `/fastcontext` command — fast read-only codebase search via local Microsoft FastContext (llama.cpp); returns compact `file:line` citations | Code Search |
| [`pi-planning`](packages/pi-planning/) (plan-tools) | `/plan` command + taskwarrior tools (`tw_get_ticket`, `tw_get_spec_task`, `tw_get_phases`, `tw_get_impl_tasks`, `resolve_spec_path`, `tw_create_spec_task`, `tw_create_phase`, `tw_create_impl_task`) for spec/plan creation | Planning |
| [`pi-planning`](packages/pi-planning/) (implement-plan) | `/implement` command + taskwarrior tools (`tw_execution_plan`, `tw_advance_task`, `tw_phase_checkpoint`) for driving implementation from a spec | Planning |
| [`pi-context`](packages/pi-context/) | `/context` command — visualize current context/token usage as a colored grid overlay | UI Enhancement |
| [`pi-teams-transcript`](packages/pi-teams-transcript/) | `teams_transcript` tool — list/download Microsoft Teams meeting transcripts via Microsoft Graph (app-only auth) ⚠️ *work in progress* | Integrations |

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
| `aws-architecture-diagram` | Generate validated AWS architecture diagrams as draw.io XML using official AWS4 icon libraries; supports codebase analysis and interactive brainstorm modes |
| `coding-standards` | Universal coding standards, best practices, and patterns for TypeScript, JavaScript, React, and Node.js development |
| `create-plan` | Create detailed implementation plans from Jira tickets via taskwarrior |
| `debug` | Bootstrap a debugging session — investigates pod logs, DB state, and git history without editing files |
| `feature-ticket` | Interview-driven feature ticket creation for personal projects; records as Taskwarrior ticket |
| `gh-unresolved-comments` | Fetch unresolved PR review comments, classify as VALID/INVALID, auto-resolve stale threads, produce resolution plan |
| `implement-plan` | Execute an approved implementation spec by driving work from taskwarrior phase/subtask tree |
| `iterate-plan` | Iterate on existing implementation specs with thorough research and updates |
| `notes-locator` | Discover relevant documents in `notes/` or `$LLM_NOTES_ROOT` for a given topic or task |
| `pr-description` | Generate comprehensive PR descriptions following repository templates |
| `tdd-workflow` | TDD workflow enforcement with 80%+ coverage — unit, integration, and E2E |
| `teams-pr-notify` | Send PR review request as Adaptive Card to a Microsoft Teams channel via Power Automate |
| `worktrunk` | `wt` CLI for git worktree workflows — switching, creating, merging, hooks, LLM commit generation |

### Tools

| Skill | Description |
|-------|-------------|
| `acli` | Atlassian CLI reference — Jira work items, projects, boards, sprints, filters, dashboards, org admin |
| `cli-microsoft365` | CLI for Microsoft 365 — SharePoint, Entra ID, Teams, Power Platform, Graph API |
| `devctl` | `devctl` CLI guide for the SalaryHero local Kubernetes dev environment (minikube-based) |
| `sem` | Entity-aware code change analysis via pi-sem tools — diff, impact, context, blame, history |

### Productivity

| Skill | Description |
|-------|-------------|
| `writing-great-skills` | Reference for writing and editing skills well — vocabulary and principles |

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
