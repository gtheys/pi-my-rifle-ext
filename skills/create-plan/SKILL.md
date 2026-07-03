---
name: create-plan
description: Create detailed implementation plans from Jira tickets via taskwarrior. Use when the user wants to create a detailed implementation plan, spec, or technical specification. Fetches ticket context from taskwarrior. Trigger on mentions of "create plan", "implementation plan", "write a plan", "spec", "create plan from jira", "plan from ticket", or when a Jira ID (e.g. IMP-7070, DP-92) is provided alongside a plan request.
---

# Create Implementation Plan

You are tasked with creating detailed implementation plans through an interactive, iterative process. Ticket context comes from taskwarrior. You should be skeptical, thorough, and work collaboratively with the user.

## Initial Response

When this skill is invoked:

1. **If a Jira ID was provided** (e.g., `IMP-7070`, `DP-92`, `ENG-1234`):
   - Immediately fetch ticket details from taskwarrior
   - Skip the default message

2. **If no Jira ID provided**, respond with:

```
I'll help you create a detailed implementation plan from a Jira ticket.

Please provide the Jira ID (e.g., IMP-7070, DP-92) for the ticket you want to plan.

I'll fetch the ticket details from taskwarrior and work with you to create a comprehensive plan.
```

Then wait for the user's input.

## Resolving the Spec File Location

Use the `resolve_spec_path` tool with the Jira ID and `jirasummary`. It handles repo name detection, `$LLM_NOTES_ROOT`, and slug generation automatically.

Full example result: `notes/specs/IMP-7070__implement-user-balance-write.md`

## Step 0: Fetch Ticket Context from Taskwarrior

### 0.1 Fetch the Jira task

Use the `tw_get_ticket` tool with the Jira ID.

Key fields returned:

| Field | Purpose |
|-------|---------|
| `description` | Short description |
| `jiradescription` | Full Jira description (contains specs, AC, etc.) |
| `jirasummary` | Jira summary/title |
| `jirastatus` | Current Jira status |
| `jiraurl` | Link to Jira ticket |
| `jiraissuetype` | Issue type (Story, Bug, Task, etc.) |
| `jiraparent` | Parent epic key |
| `tags` | Task tags |
| `project` | Taskwarrior project |

If no task is found:

```
No taskwarrior task found for Jira ID "$JIRA_ID". Make sure bugwarrior has synced this ticket. You can run `bugwarrior pull` to sync, or provide the ticket details manually.
```

### 0.2 Fetch the spec task (if one exists)

Use the `tw_get_spec_task` tool with the Jira ID. The `specPath` field in the result contains the spec file path if an annotation exists. Read the spec file FULLY if it exists.

### 0.3 Fetch existing phases and implementation tasks

Use `tw_get_phases` and `tw_get_impl_tasks` tools with the Jira ID.

If phases/tasks already exist, review them to understand prior planning. Check `work_state` values for existing spec files.

### 0.4 Present summary to user

```
## Ticket: $JIRA_ID — $jirasummary

**Jira Status:** $jirastatus
**Issue Type:** $jiraissuetype
**URL:** $jiraurl

### Description:
[parsed jiradescription]

### Spec:
- Spec file: $path (if found)
- Spec work_state: $state (if found)

### Existing Planning:
- Phases: $count phases found (list work_states)
- Implementation tasks: $count tasks found

---

Based on this ticket, I understand we need to [accurate summary].
```

## Step 1: Research & Discovery

Before asking the user any questions, research the codebase:

1. **Spawn research tasks** using available skills:
   - `fast_context_search` / `grep` / `find` — find all files related to the ticket
   - `read` / `sem_context` — understand current implementation
   - `fast_context_search` / `grep` — find similar features to model after
   - `/skill:notes-locator` — find any existing notes about this feature

2. **Read all files identified by research** FULLY — never read files partially.

3. **Analyze and verify understanding**:
   - Cross-reference the Jira description/acceptance criteria with actual code
   - Identify discrepancies between ticket and codebase
   - Note assumptions that need verification

4. **Present informed understanding and focused questions**:

   ```
   Based on the ticket and my research of the codebase, I understand we need to [accurate summary].

   I've found that:
   - [Current implementation detail with file:line reference]
   - [Relevant pattern or constraint discovered]
   - [Potential complexity or edge case identified]

   Questions that my research couldn't answer:
   - [Specific question requiring human judgment]
   - [Business logic clarification]
   ```

   Only ask questions you genuinely cannot answer through code investigation.

## Step 2: Deeper Research

After getting initial clarifications:

1. **If the user corrects a misunderstanding**, spawn new research to verify — don't just accept it.

2. **Create a research todo list** with markdown checkboxes to track exploration.

3. **Use skills for comprehensive research**:
   - `fast_context_search` / `grep` / `find` — find more specific files
   - `read` / `sem_context` — understand implementation details
   - `fast_context_search` / `grep` — find similar implementations
   - `/skill:notes-locator` — find research, specs, or decisions

4. **Wait for ALL research to complete** before proceeding.

5. **Present findings and design options** with pros/cons, referencing specific file:line locations.

## Step 3: Plan Structure Development

Once aligned on approach:

1. **Create initial plan outline** and get feedback on structure before writing details.

   ```
   Here's my proposed plan structure:

   ## Overview
   [1-2 sentence summary]

   ## Implementation Phases:
   1. [Phase name] - [what it accomplishes]
   2. [Phase name] - [what it accomplishes]
   3. [Phase name] - [what it accomplishes]

   Does this phasing make sense? Should I adjust the order or granularity?
   ```

2. **Get feedback on structure** before writing details.

## Step 4: Detailed Plan Writing

After structure approval:

1. **Resolve the spec path** using the `resolve_spec_path` tool with the Jira ID and `jirasummary`.

2. **Write the spec** to the resolved path.

3. **Use the template** at the end of this document.

## Step 5: Create Taskwarrior Tasks

After the spec is written and approved, create the taskwarrior tracking structure.

> **Note:** All tasks are created under `SalaryHero.$PROJECT` — the tools handle this prefix automatically.

### 5.1 Create spec task (if not already existing)

Check with `tw_get_spec_task`. If no spec task exists, use `tw_create_spec_task` with:
- `jira_id`, `summary`, `project`, `repo`
- `spec_path` — the relative path returned by `resolve_spec_path` (relative portion, e.g. `notes/specs/IMP-7070__slug.md`)

### 5.2 Create phase and implementation tasks

For each phase in the spec:

1. Use `tw_create_phase` — returns the phase UUID
2. Use `tw_create_impl_task` for each task under that phase, passing the phase UUID as `depends_uuid`

### 5.3 Report created structure

Present the full task hierarchy:

```
Taskwarrior hierarchy created for $JIRA_ID:

📋 Spec: SPEC: $JIRA_ID $jirasummary
   └── Spec file: notes/specs/$JIRA_ID__$SLUG.md

📦 Phase 1: <phase-name> [todo]
   ├── 1.1 <task-title> [todo]
   ├── 1.2 <task-title> [todo]
   └── 1.3 <task-title> [todo]

📦 Phase 2: <phase-name> [todo]
   ├── 2.1 <task-title> [todo]
   └── 2.2 <task-title> [todo]
```

## Step 6: Review & Iterate

1. **Present the draft spec location** and taskwarrior summary.
2. **Iterate based on feedback** — update both the spec file AND taskwarrior tasks.
3. **Continue refining** until the user is satisfied.

## Integration with Other Skills

This skill works with:

- `/skill:taskwarrior-plan` — Ticket management, status transitions, and workflow states. Reference this for `work_state` values.
- `/skill:notes-locator` — Find existing specs, research docs, tickets, and PR descriptions in the notes directory.
- `fast_context_search` / `grep` / `find` — Find source files related to the ticket.
- `read` / `sem_context` — Understand current implementation details.
- `fast_context_search` / `grep` — Find similar features to model after.
- `/skill:implement-plan` — When the spec is approved and ready for development.

## Important Guidelines

1. **Jira ID is the source of truth** — all context comes from taskwarrior queries
2. **Always verify the Jira task exists** before proceeding
3. **Be Skeptical** — question vague requirements, identify issues early, don't assume — verify with code
4. **Be Interactive** — get buy-in at each step, don't write the full spec in one shot
5. **Be Thorough** — read all referenced code COMPLETELY, use parallel skill invocations, include specific file:line references
6. **Be Practical** — focus on incremental, testable changes, consider migration and rollback
7. **Track Progress** — use markdown checkboxes
8. **No Open Questions in Final Spec** — every decision must be made before finalizing
9. **Separate success criteria** into Automated and Manual verification
10. **Use `make` commands** for automated verification steps when available

## Research Best Practices

1. **Spawn multiple skills in parallel** for efficiency
2. **Each skill should be focused** on a specific area
3. **Be EXTREMELY specific about directories** — if the ticket mentions "WUI", specify `humanlayer-wui/`; never use generic terms
4. **Wait for all research to complete** before synthesizing
5. **Verify results** — if a skill returns unexpected results, spawn follow-up research

## Common Implementation Patterns

**Database Changes**: schema/migration → store methods → business logic → API → clients

**New Features**: research existing patterns → data model → backend logic → API endpoints → UI

**Refactoring**: document current behavior → plan incremental changes → maintain backwards compatibility → migration strategy

## Success Criteria Format

Always separate into two categories:

```markdown
### Success Criteria:

#### Automated Verification:
- [ ] Migration runs: `make migrate`
- [ ] Unit tests pass: `make test-component`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `make lint`

#### Manual Verification:
- [ ] Feature works as expected in UI
- [ ] Performance acceptable under load
- [ ] Edge case handling verified
```

## Spec Template

```markdown
# [$JIRA_ID] $Title Implementation Plan

## Overview

[Brief description of what we're implementing and why]

**Jira Ticket:** [$JIRA_ID]($jiraurl)
**Issue Type:** $jiraissuetype

## Current State Analysis

[What exists now, what's missing, key constraints discovered]

## Desired End State

[Specification of the desired end state and how to verify it]

### Key Discoveries:
- [Important finding with file:line reference]
- [Pattern to follow]
- [Constraint to work within]

## What We're NOT Doing

[Explicitly list out-of-scope items to prevent scope creep]

## Implementation Approach

[High-level strategy and reasoning]

## Phase 1: [Descriptive Name]

### Overview
[What this phase accomplishes]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

```[language]
// Specific code to add/modify
```

### Success Criteria

#### Automated Verification

- [ ] [Command]: `make test-component`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `npm run lint`

#### Manual Verification

- [ ] Feature works as expected when tested via UI
- [ ] Edge case handling verified manually

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding.

---

## Phase 2: [Descriptive Name]

[Similar structure...]

---

## Testing Strategy

### Unit Tests

- [What to test]

### Integration Tests

- [End-to-end scenarios]

### Manual Testing Steps

1. [Specific verification step]

## Performance Considerations

[Any performance implications]

## Migration Notes

[If applicable]

## References

- Jira ticket: [$JIRA_ID]($jiraurl)
- Taskwarrior: `task jiraid:$JIRA_ID +impl list`
- Spec file: `notes/specs/$JIRA_ID__$SLUG.md`

```

## Taskwarrior Integration Guidelines

1. **Always check for existing tasks** before creating new ones — use `tw_get_spec_task`, `tw_get_phases`, `tw_get_impl_tasks`
2. **Link via `jiraid` UDA** — all tools handle this automatically
3. **Annotate with context** — `tw_create_spec_task` adds the spec file annotation automatically
4. **Report task hierarchy** after creation — show the full structure to the user
5. **Nest projects under `SalaryHero`** — all tools prefix project with `SalaryHero.` automatically
