# Skills, Prompts & Themes

## Skills (`skills/`)

Each skill is a directory with a `SKILL.md` (YAML frontmatter `name`/`description`
+ prose body) that pi loads and can invoke by name or by matching the description's
trigger phrases. Organized into three categories (`b237694c` reorg):

### `skills/engineering/` — day-to-day dev workflow

| Skill | Use for |
|---|---|
| `create-plan` | Turn a Jira ticket into a detailed spec via taskwarrior (backed by `pi-planning/plan-tools`) |
| `iterate-plan` | Update an existing spec based on feedback/new research |
| `implement-plan` | Execute an approved spec phase-by-phase from taskwarrior (backed by `pi-planning/implement-plan`) |
| `debug` | Investigation-only bootstrap: minikube pod logs, nonprod Postgres state, git history — **never edits files** |
| `gh-unresolved-comments` | Fetch + triage (VALID/INVALID) unresolved PR review threads, auto-resolve invalid ones |
| `pr-description` | Generate a PR description following the repo's template |
| `teams-pr-notify` | Post a PR review-request Adaptive Card to a Teams channel via Power Automate |
| `feature-ticket` | Interview a vague personal-project feature idea into a concrete Taskwarrior ticket |
| `notes-locator` | Find (not analyze) relevant docs under `notes/` or `$LLM_NOTES_ROOT` |
| `tdd-workflow` | Enforce TDD with 80%+ coverage (unit/integration/E2E) for new features/fixes/refactors |
| `coding-standards` | Universal TS/JS/React/Node conventions reference |
| `worktrunk` | Prefer the `wt` CLI over manual git worktree/branch juggling |
| `aws-architecture-diagram` | Generate validated AWS draw.io diagrams from code or interactively |

### `skills/tools/` — third-party CLI references

| Skill | Use for |
|---|---|
| `acli` | Atlassian CLI — Jira work items, projects, boards/sprints, org admin |
| `cli-microsoft365` | `m365` CLI — SharePoint, Entra ID, Teams, Power Platform, Graph |
| `devctl` | SalaryHero's local minikube dev environment CLI |
| `jira-status-timestamps` | Create datetime custom fields + Jira Automation rules stamping time-in-status |
| `qmd` | QMD markdown search — find notes, docs, wikis, and transcripts in local markdown collections; retrieve full documents with `qmd get`/`qmd multi-get` |
| `sem` | How/when to use the `pi-sem` tools (`sem_diff`, `sem_impact`, etc.) as a semantic lens, not a replacement, for raw git diff |

### `skills/productivity/`

| Skill | Use for |
|---|---|
| `writing-great-skills` | Meta-reference for writing/editing skills themselves — vocabulary and principles for predictable agent behavior. `disable-model-invocation: true` — only read on request, never auto-triggered |

## Relationship between skills and extensions

Skills are **prose workflows**; extensions are **typed tools/commands** those
workflows call. `create-plan`/`iterate-plan`/`implement-plan` don't shell out to raw
`task` commands themselves — they call the typed tools registered by
`pi-planning/plan-tools` and `pi-planning/implement-plan` (`tw_get_ticket`,
`tw_execution_plan`, etc.). Same pattern for `sem` (skill) → `pi-sem` (extension), and
`gh-unresolved-comments` (skill) → informs `/pr-quality`'s inline GraphQL query
(extension). When a skill references a JIRA_ID or a taskwarrior filter, trace it back
to the extension in [Extension reference](../architecture/extensions.md) for the exact
implementation.

## Prompts (`prompts/`)

Slash-command prompt templates, distinct from extension-registered commands — these
are plain markdown templates pi loads directly (no TypeScript logic).

- `prompts/git.md` — git-related prompt template (commit message guidance, etc.)

## Themes (`themes/`)

- `themes/tokyo-night.json` — the one theme shipped in this repo; loaded via the
  `pi.themes` manifest entry. `pi-tool-pills`' diff renderer reads theme config from
  `~/.pi/agent/settings.json` (fixed in `e58efbdd`) to pick colors consistent with
  whichever theme (including this one) is active.
