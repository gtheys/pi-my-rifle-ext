# Skills, Prompts & Themes

## Skills (`skills/`)

Each skill is a directory with a `SKILL.md` (YAML frontmatter `name`/`description`
+ prose body) that pi loads and can invoke by name or by matching the description's
trigger phrases. Organized into two categories (`f7258cd` split tool references out of engineering):

### `skills/engineering/` — day-to-day dev workflow

| Skill | Use for |
|---|---|
| `explore` | Pre-ticket codebase Q&A — quick questions via direct search, broad mapping via scout subagents, "why" questions via hindsight/cognee memory; no aven state until an explicit exit ramp (create ticket / plan it / nothing) |
| `feature-plan-aven` | Plan an aven ticket end to end — pickup, scout subagent, `resolve_feature_path` plan.md, interview, interactive planner agent, plan-state gate (draft → review → approved), then the epic/dep tree. Handles aven refs, aven-synced Jira IDs (pull-in), and local features; worktree-orchestrated |
| `implement-plan-aven` | Execute an approved aven feature tree phase by phase (`/implement` routes here) — worker subagents, test/commit cycle per phase, resume via first-non-done. Oneshot path for self-sufficient tickets; worktree mode is the hard default |
| `feature-ticket` | Interview a vague personal-project feature idea into a concrete Taskwarrior ticket |
| `debug` | Structured root-cause workflow: redact secrets, tight feedback loop, reproduce/minimise, rank hypotheses, fix with a regression test; optional Jira-ID bootstrap and SH flag (SalaryHero pod-log/DB commands); aven bug flow via `debug <aven-ref>` (findings land as ticket notes); investigate-only until the user approves a fix |
| `gh-unresolved-comments` | Fetch + triage (VALID/INVALID) unresolved PR review threads, auto-resolve invalid ones |
| `pr-description` | Generate a PR description following the repo's template; auto-creates the PR when none exists for the branch |
| `teams-pr-notify` | Post a PR review-request Adaptive Card to a Teams channel via Power Automate; digest mode backed by `pi-pr-digest` |
| `notes-locator` | Find (not analyze) relevant docs under `notes/` or `$LLM_NOTES_ROOT` |
| `tdd-workflow` | Enforce the red→green loop: tests at agreed public seams, 80%+ coverage; `references/` holds mocking, patterns, project-setup, and test-writing deep-dives |
| `coding-standards` | Universal TS/JS/React/Node conventions reference |

### `skills/tools/` — third-party CLI references

| Skill | Use for |
|---|---|
| `acli` | Atlassian CLI — Jira work items, projects, boards/sprints, org admin |
| `atlas` | Atlas CLI — database schema management and migrations (generate, diff, lint, apply; ORM schema support) |
| `aws-architecture-diagram` | Generate validated AWS draw.io diagrams from code or interactively |
| `cli-microsoft365` | `m365` CLI — SharePoint, Entra ID, Teams, Power Platform, Graph |
| `devctl` | SalaryHero's local minikube dev environment CLI |
| `jira-status-timestamps` | Create datetime custom fields + Jira Automation rules stamping time-in-status |
| `qmd` | QMD markdown search — find notes, docs, wikis, and transcripts in local markdown collections; retrieve full documents with `qmd get`/`qmd multi-get` |
| `sem` | How/when to use the `pi-sem` tools (`sem_diff`, `sem_impact`, etc.) as a semantic lens, not a replacement, for raw git diff |
| `worktrunk` | Prefer the `wt` CLI over manual git worktree/branch juggling |

## Relationship between skills and extensions

Skills are **prose workflows**; extensions are **typed tools/commands** those
workflows call. `feature-plan-aven`/`implement-plan-aven` drive the **aven CLI**
directly (the aven skill at `~/.pi/agent/skills/aven/` holds the CLI primer;
`pi-aven-context` injects live workspace state at session start) and call the
slimmed `pi-planning` tools (`resolve_spec_path`, `resolve_feature_path`,
`jira_create_branch`). Same pattern for `sem` (skill) → `pi-sem` (extension), and
`gh-unresolved-comments` (skill) → informs `/pr-quality`'s inline GraphQL query
(extension). When a skill references an aven ref or filter, trace it back to the
extension in [Extension reference](../architecture/extensions.md) for the exact
implementation. The full dependency map (commands → skills → tools → subagents)
lives in `README.md` "How Extensions and Skills Fit Together"; the canonical
planning flow doc is `docs/aven-feature-flow.md`.

## Prompts (`prompts/`)

Slash-command prompt templates, distinct from extension-registered commands — these
are plain markdown templates pi loads directly (no TypeScript logic).

- `prompts/git.md` — git-related prompt template (commit message guidance, etc.)

## Themes (`themes/`)

- `themes/tokyo-night.json` — the one theme shipped in this repo; loaded via the
  `pi.themes` manifest entry. `pi-tool-pills`' diff renderer reads theme config from
  `~/.pi/agent/settings.json` (fixed in `e58efbdd`) to pick colors consistent with
  whichever theme (including this one) is active.
