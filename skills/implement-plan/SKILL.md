---
name: implement-plan
description: Implement technical specs from notes/specs/ with verification. Use when the user wants to execute an approved implementation spec. Trigger on mentions of "implement plan", "execute plan", "implement spec", "start implementation", or "build feature". Also handles creating specs from Jira issues when given a Jira ID without an existing spec.
---

# Implement Plan

You are tasked with implementing an approved technical spec. Specs live in `notes/specs/` and contain phases with specific changes and success criteria.

## Resolving the Notes Directory

1. **Get the current repo name**:

   ```bash
   basename "$(git remote get-url origin 2>/dev/null | sed 's/\.git$//')" 2>/dev/null
   ```

   If this fails, fall back to `basename "$(git rev-parse --show-toplevel 2>/dev/null)"`, then to `basename "$PWD"`.

2. **Resolve the specs path**:
   - If `$LLM_NOTES_ROOT` is set → `$LLM_NOTES_ROOT/<repo>/notes/specs/`
   - Otherwise → `notes/specs/` relative to the repo root

## Scripts

This skill ships a helper script in `scripts/`:

### `scripts/jira-branch.sh` — Create a local branch from a Jira issue

Shared script at the repo root `scripts/` dir. Fetches issue type and summary
via `acli`, derives a branch name, creates the branch locally, and sets its
git-town parent to `develop`.

```bash
# Normal use
bash scripts/jira-branch.sh IMP-1234

# Preview only (no branch created)
bash scripts/jira-branch.sh IMP-1234 --dry-run
```

**Branch naming:** `<prefix>/<JIRA-KEY>-<summary-slug>` (first 5 words of summary)

| Issue type | Prefix |
|---|---|
| Bug / Hotfix | `bugfix` / `hotfix` |
| Story / Feature / Epic / Improvement | `feature` |
| Task / Sub-task / Spike / Technical Debt | `chore` |
| _(unknown)_ | `feature` |

**Requires:** `acli`, `jq`, `git`, `git-town`

---

## Getting Started

When given a spec path or Jira ID:

1. **If given a Jira ID** (e.g., `IMP-7070`):
   - Check for an existing spec: `ls notes/specs/ | grep -i IMP-7070`
   - If found, read it and proceed to implementation
   - If not found, check taskwarrior for a spec task: `task jiraid:IMP-7070 +spec export`
   - If no spec exists at all, offer to create one (see "Creating a Spec from Jira" below)

2. **If given a spec path**:
   - Read the spec completely and check for any existing checkmarks (`- [x]`)
   - Check the YAML frontmatter for `work_state` — warn if it's still `draft`
   - Read all files mentioned in the spec
   - **Read files fully** — never use limit/offset parameters, you need complete context
   - Think deeply about how the pieces fit together
   - Create a todo list using markdown checkboxes to track your progress
   - Start implementing if you understand what needs to be done

3. **If no spec path or Jira ID provided**, ask for one:

   ```
   Which spec would you like to implement? Provide a path or Jira ID.

   Tip: List recent specs with `ls -lt notes/specs/ | head`
   ```

## Implementation Philosophy

> **Before writing any code**, load and follow the companion skills:
> - `/skill:coding-standards` — TypeScript/JS style, naming, error handling, React patterns
> - `/skill:tdd-workflow` — write tests first, verify 80%+ coverage
>
> All implementation must conform to these standards throughout.

Specs are carefully designed, but reality can be messy. Your job is to:

- Follow the spec's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the spec as you complete sections

When things don't match the spec exactly, think about why and communicate clearly. The spec is your guide, but your judgment matters too.

If you encounter a mismatch:

- STOP and think deeply about why the spec can't be followed
- Present the issue clearly:

  ```
  Issue in Phase [N]:
  Expected: [what the spec says]
  Found: [actual situation]
  Why this matters: [explanation]
  How should I proceed?
  ```

## Verification Approach

After implementing a phase:

- Run the success criteria checks (usually `make check test` covers everything)
- Fix any issues before proceeding
- Update your progress in both the spec and your todos
- Check off completed items in the spec file itself using Edit
- **Pause for human verification**: After completing all automated verification for a phase, pause and inform the human that the phase is ready for manual testing:

  ```
  Phase [N] Complete - Ready for Manual Verification

  Automated verification passed:
  - [List automated checks that passed]

  Please perform the manual verification steps listed in the spec:
  - [List manual verification items from the spec]

  Let me know when manual testing is complete so I can proceed to Phase [N+1].
  ```

If instructed to execute multiple phases consecutively, skip the pause until the last phase. Otherwise, assume you are just doing one phase.

Do not check off items in the manual testing steps until confirmed by the user.

## If You Get Stuck

When something isn't working as expected:

- First, make sure you've read and understood all the relevant code
- Consider if the codebase has evolved since the spec was written
- Present the mismatch clearly and ask for guidance

Use skills sparingly — mainly for targeted debugging or exploring unfamiliar territory.

## Resuming Work

If the spec has existing checkmarks:

- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.

## Updating Taskwarrior on Completion

After completing a phase, update taskwarrior if tasks exist:

```bash
# Find the phase task
task jiraid:$JIRA_ID +phase export | jq '.[] | select(.description | contains("Phase N"))'

# Mark phase complete
task <phase-uuid> done
task <phase-uuid> modify work_state:done
```

After all phases are complete:

```bash
# Mark the spec task as done
task jiraid:$JIRA_ID +spec modify work_state:done
task jiraid:$JIRA_ID +spec done
```

---

## Creating a Spec from Jira

When no spec exists for a Jira ID, create one using this process:

### 1. Query Taskwarrior for the Jira Task

```bash
task jiraid:$JIRA_ID status:pending export
```

Parse the JSON to extract: `jiraid`, `jirasummary`, `jiradescription`, `uuid`, `jiraurl`.

If no task found, suggest `bugwarrior-pull` and exit.

### 2. Determine Spec File Location

Use the standard spec path resolution (see "Resolving the Notes Directory" above).

Generate `<slug>` from `jirasummary`: lowercase, replace spaces with dashes, max 5 words.

Example: `notes/specs/IN-1373__implement-user-balance-write.md`

### 3. Create the Spec File

Use `jiradescription` as the primary context. Follow step-by-step mode: write Requirements first, pause for approval, then write Design.

Include YAML frontmatter:

```yaml
---
createdAt: <ISO8601 date>
work_state: draft
---
```

### 4. Create Taskwarrior Spec Task

```bash
task add "SPEC: <JIRAKEY> <summary>" +spec work_state:draft jiraid:<JIRAKEY>
```

Annotate with portable spec path:

```bash
task <spec-uuid> annotate "Spec(repo=<repo>): <repo>/notes/specs/<filename>"
```

The spec task is linked to the Jira task via `jiraid` UDA, NOT via `depends:`.

### 5. Report Back

```
Spec created at: notes/specs/<JIRAKEY>__<slug>.md
Taskwarrior spec task: <ID> (<UUID>)
Work state: draft
Jira: <jiraurl>

Current section: Requirements
Next steps: Please review the requirements above. Are they accurate and complete? Should I proceed to the Design section?
```

### 6. Finalize and Approve

After Design is complete and user-approved:

- Prompt: "The spec is complete with Requirements and Design. Would you like to mark it as approved?"
- **If yes**:
  - `task <spec-uuid> modify work_state:approved`
  - Add `approvedAt: <ISO8601 timestamp>` to YAML frontmatter
  - `task <spec-uuid> annotate "Approved on <ISO8601 date>"`
- **If no**:
  - Keep in `draft` state

## Spec State Management

### States

- **draft** — initial state for new or modified specs
- **approved** — finalized and approved for implementation

### Editing Approved Specs

When a user requests changes to an approved spec:

1. Detect `work_state: approved` in YAML frontmatter
2. Ask: "This spec is approved. Modifying it will revert to draft state. Continue?"
3. If confirmed:
   - Revert `work_state` to `draft` in both taskwarrior and the spec file
   - Remove `approvedAt` from YAML frontmatter
   - Annotate: `task <spec-uuid> annotate "Reverted to draft on <ISO8601 date> due to modifications"`
4. If declined: cancel the modification

## Integration with Other Skills

- `/skill:coding-standards` — TypeScript/JS/React/Node.js code style and best practices. **Load this before writing any code.**
- `/skill:tdd-workflow` — TDD process, test patterns, and coverage requirements. **Load this before writing any code.**
- `/skill:create-plan` — Create a new spec through interactive research. Use this for complex specs that need deep codebase research before writing.
- `/skill:iterate-plan` — Modify an existing spec. Use this for targeted changes to a spec without full reimplementation.
- `/skill:taskwarrior-plan` — Ticket management and workflow states.
- `/skill:notes-locator` — Find existing specs, research docs, and related notes.
