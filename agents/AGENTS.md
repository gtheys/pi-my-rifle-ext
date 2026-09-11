# AGENTS.md - SalaryHero

## The Golden Rule

When unsure about implementation details, ALWAYS ask the developer.

---

## Non-negotiable golden rules

| #:  | AI _may_ do                                                                                                                                                                        | AI _must NOT_ do                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-0 | Whenever unsure about something that's related to the project, ask the developer for clarification before making changes.                                                          | ❌ Write changes or use tools when you are not sure about something project specific, or if you don't have context for a particular feature/decision. |
| G-1 | Add/update **`AIDEV-NOTE:` anchor comments** near non-trivial edited code.                                                                                                         | ❌ Delete or mangle existing `AIDEV-` comments.                                                                                                       |
| G-2 | Follow lint/style configs (`pyproject.toml`, `.prettierrc`, `.pre-commit-config.yaml`). Use the project's configured linter, if available, instead of manually re-formatting code. | ❌ Re-format code to any other style.                                                                                                                 |
| G-3 | For changes >300 LOC or >3 files, **ask for confirmation**.                                                                                                                        | ❌ Refactor large modules without human guidance.                                                                                                     |
| G-4 | Stay within the current task context. Inform the dev if it'd be better to start afresh.                                                                                            | ❌ Continue work from a prior prompt after "new task" – start a fresh session.                                                                        |

---

## Code Style and Patterns

### Anchor comments

Add specially formatted comments throughout the codebase, where appropriate, for yourself as inline knowledge that can be easily \`grep\`ped for.

### Guidelines

- Use \`AIDEV-NOTE:\`, \`AIDEV-TODO:\`, or \`AIDEV-QUESTION:\` (all-caps prefix) for comments aimed at AI and developers.
- **Important:** Before scanning files, always first try to **grep for existing anchors** \`AIDEV-\*\` in relevant subdirectories.
- **Update relevant anchors** when modifying associated code.
- **Do not remove \`AIDEV-NOTE\`s** without explicit human instruction.
- Make sure to add relevant anchor comments, whenever a file or piece of code is:
  - too complex, or
  - very important, or
  - confusing, or
  - could have a bug

---

## Commit discipline

You will receive a prompt to execute a task. Once the task is finished provide a git commit message example AND WAIT FOR INPUT before doing anything else. Never start a new task without being prompted.

- **Clear commit messages**: Explain the _why_; link to issues/ADRs if architectural.
- **Review AI-generated code**: Never merge code you don't understand.
- NEVER push or do any ations on the remote branch.

---

## Memory (epimetheus / Hindsight)

Sessions only flush to long-term memory after extra context is set (flush guard).
Before session end or when asked to summarize, call `hindsight_set_extra_context`
with caveats about the session content (or an empty string if none) so the flush
isn't blocked. Set it earlier when the session involves fiction, articles, or
other people's writing (prevents third parties being misclassified as the user).

## Memory (Cognee)

Cognee is graph-based memory, separate from Hindsight. Two storage modes:

- **Session cache** (`cognee_remember` with `session_id`): fast scratch notes for
  THIS session only. No entity extraction. Use for temporary facts, decisions,
  intermediate findings you may need later in the same session.
- **Permanent graph** (`cognee_remember` without `session_id`): runs the full
  add + cognify pipeline (entity extraction, graph build). Slower. Use for
  durable knowledge: architectural decisions, project conventions, user
  preferences, solutions to hard-won bugs.

Recall with `cognee_recall`:

- Ask a natural-language question; auto-routing picks the search strategy.
- Pass `session_id` to search session cache first.
- Use at session/task start to recover prior context, and before making
  decisions that past sessions may have already settled.

When to use which:

| Situation | Tool |
|---|---|
| Short-lived working note, same session | `cognee_remember` + `session_id` |
| Durable fact worth keeping across sessions | `cognee_remember` (no session_id) |
| Need prior context / past decisions | `cognee_recall` |
| Bridge session notes into permanent graph afterwards | `cognee_improve` with `session_ids` |

Rule of thumb: Hindsight = automatic session flush; Cognee = explicit
remember/recall for knowledge you deliberately want to keep or find.

All SalaryHero specs are ingested into Cognee. When planning or speccing
SalaryHero work, run `cognee_recall` first to surface relevant existing specs
before writing new ones.

---

## Domain Glossary (learn these!)

- **Agent**: AI entity with memory, tools, and defined behavior
- **Task**: Workflow definition composed of steps (NOT a Celery task)
- **Execution**: Running instance of a task
- **Tool**: Function an agent can call (browser, API, etc.)
- **Session**: Conversation context with memory
- **Entry**: Single interaction within a session

---

## Directory-Specific AGENTS.md Files

- **Always check for `AGENTS.md` files in specific directories** before working on code within them. These files contain targeted context.
- If a directory's `AGENTS.md` is outdated or incorrect, **update it**.
- If you make significant changes to a directory's structure, patterns, or critical implementation details, **document these in its `AGENTS.md`**.
- If a directory lacks a `AGENTS.md` but contains complex logic or patterns worth documenting for AI/humans, **suggest creating one**.

---

## Meta: Guidelines for updating AGENTS.md files

### Elements that would be helpful to add

1. **Decision flowchart**: A simple decision tree for "when to use X vs Y" for key architectural choices would guide my recommendations.
2. **Reference links**: Links to key files or implementation examples that demonstrate best practices.
3. **Domain-specific terminology**: A small glossary of project-specific terms would help me understand domain language correctly.
4. **Versioning conventions**: How the project handles versioning, both for APIs and internal components.

### Format preferences

1. **Consistent syntax highlighting**: Ensure all code blocks have proper language tags (`python`, `bash`, etc.).
2. **Hierarchical organization**: Consider using hierarchical numbering for subsections to make referencing easier.
3. **Tabular format for key facts**: The tables are very helpful - more structured data in tabular format would be valuable.
4. **Keywords or tags**: Adding semantic markers (like `#performance` or `#security`) to certain sections would help me quickly locate relevant guidance.

This principle emphasizes human oversight for critical aspects like architecture, testing, and domain-specific decisions, ensuring AI assists rather than fully dictates development.

---

## What AI Must NEVER Do

1. **Never modify test files** - Tests encode human intent
2. **Never change API contracts** - Breaks real applications
3. **Never alter migration files** - Data loss risk
4. **Never commit secrets** - Use environment variables
5. **Never assume business logic** - Always ask
6. **Never remove AIDEV- comments** - They're there for a reason

Remember: We optimize for maintainability over cleverness.  
When in doubt, choose the boring solution.
