---
description: Create git commits with conventional commit messages, user approval, and no AI attribution
argument-hint: "<message>"
---

# Commit Changes

You are tasked with creating git commits for the changes made during this session.

## Process:

1. **Think about what changed:**
   - Review the conversation history and understand what was accomplished
   - Run `git status` to see current changes
   - Run `git diff` to understand the modifications
   - Consider whether changes should be one commit or multiple logical commits

2. **Plan your commit(s):**
   - Identify which files belong together
   - Draft clear, descriptive commit messages using Conventional Commits format
   - Focus on why the changes were made, not just what

3. **Present your plan to the user:**
   - List the files you plan to add for each commit
   - Show the commit message(s) you'll use
   - Ask: "I plan to create [N] commit(s) with these changes. Shall I proceed?"

4. **Execute upon confirmation:**
   - Use `git add` with specific files (never use `-A` or `.`)
   - Create commits with your planned messages
   - Run `npx commitlint --edit .git/COMMIT_EDITMSG` to validate the commit message
   - If commitlint fails, fix the message and amend the commit
   - Show the result with `git log --oneline -n [number]`

## User Intent

$ARGUMENTS

---

## Conventional Commits Format

```
type(scope): [JIRA-ID] subject

body
```

If the user provides a Jira ID, include it in brackets at the start of the subject.

```
feat(api): [PROJ-123] add user authentication endpoint
fix(auth): [PROJ-456] resolve token expiry edge case
```

No Jira ID provided = omit brackets entirely.

<!-- AIDEV-NOTE: PMR-902B — personal-mode counterpart to the Jira bracket rule above; mirrors packages/pi-flow/implement/prompt.ts BRANCH_RULES, keep the two in sync. Brackets belong in commit subjects only — git refnames reject `[`, so branches use the bare feat/<REF>-<slug> shape. -->
During a personal-mode PIV flow, embed the flow's aven feature ref the same way:

```
feat(pi-flow): [PMR-AB12] add retry budget to flow_run_attempt
```

The ref comes from the active flow (never invented). Outside a flow, plain
conventional subjects — omit brackets entirely.

### Types

- `feat:` — new feature (correlates with MINOR in SemVer)
- `fix:` — bug fix (correlates with PATCH in SemVer)
- `BREAKING CHANGE:` — breaking API change (correlates with MAJOR in SemVer)
- `build:` — build system or external dependencies
- `chore:` — maintenance tasks, no production code change
- `ci:` — CI/CD configuration
- `docs:` — documentation only
- `style:` — formatting, whitespace, semicolons (no code change)
- `refactor:` — code restructuring without behavior change
- `perf:` — performance improvement
- `test:` — adding or correcting tests

### Scope

Pick the most meaningful scope based on what the commit touches. Optional but recommended.

```
feat(api): add user authentication endpoint
fix(auth): resolve token expiry edge case
docs(readme): update installation instructions
refactor(core): extract validation logic into shared module
```

### Rules

- Subject line: imperative mood, lowercase, no period, max 72 chars
- Body: explain the **why**, not the what. Be detailed.
- Breaking changes: add `BREAKING CHANGE:` footer or `!` after type (`feat!:`)

## Important:

- **NEVER add co-author information or AI attribution**
- Commits should be authored solely by the user
- Do not include any "Generated with Claude" or "Generated with AI" messages
- Do not add "Co-Authored-By" lines
- Write commit messages as if the user wrote them

## Remember:

- You have the full context of what was done in this session
- Group related changes together
- Keep commits focused and atomic when possible
- The user trusts your judgment - they asked you to commit
- Always write a detailed body explaining the rationale
