---
name: create-plan
description: Create detailed implementation plans via taskwarrior. Use when the user wants to create a detailed implementation plan, spec, or technical specification. Trigger on mentions of "create plan", "implementation plan", "write a plan", "spec", "create plan from jira", "plan from ticket", a Jira ID (e.g. IMP-7070, DP-92) alongside a plan request, or a local feature request with no Jira ID (e.g. "plan a feature", "spec a feature", "I want to add/build X"). Jira ID is optional — without one, the skill interviews the user and creates a local `+feature` taskwarrior ticket.
---

# Create Implementation Plan

You are tasked with creating detailed implementation plans through an interactive, iterative process. Ticket context comes from taskwarrior. You should be skeptical, thorough, and work collaboratively with the user.

## Initial Response

When this skill is invoked:

1. **If a Jira ID was provided** (e.g., `IMP-7070`, `DP-92`, `ENG-1234`):
   - Immediately fetch ticket details from taskwarrior
   - Skip the default message

2. **If no Jira ID provided**, start the **local feature flow** (Step F below): delegate the interview and ticket creation to the `/skill:feature-ticket` skill, then continue with the spec phase. Do not ask for a Jira ID — local features have none.

## Step F: Local Feature Flow (no Jira ID)

Use this flow when the skill is invoked without a Jira ID. The feature lives entirely in taskwarrior — no Jira ticket, no `jiraid` UDA, `+feature` tag. The feature task replaces the Jira ticket as the top of the task tree.

### F.1 Delegate interview + ticket creation to `/skill:feature-ticket`

The `feature-ticket` skill owns the interview-and-create flow — don't re-implement it here. Invoke `/skill:feature-ticket` and let it run to completion: it grounds in the project, runs one focused interview round, drafts the ticket content, and writes the taskwarrior task with `+feature` (and `Goal:` / `Done when:` / etc. annotations).

Hard requirements to enforce on the ticket it creates (tell the skill, or verify afterwards):

- **No `jiraid` UDA** — leave it blank. This is the defining marker of a local feature.
- `+feature` tag — required, distinguishes local features from Jira-synced tasks.
- Project is the bare repo/app name — **no `SalaryHero.` prefix**.

### F.2 Capture the feature task UUID

After `feature-ticket` creates the task, capture its UUID — downstream steps use it as the parent for the spec and phase tasks:

```bash
FEATURE_UUID=$(task rc.verbose=off <id> _uuid | tail -1)
```

If the numeric id isn't already known, find the newest feature task:

```bash
FEATURE_UUID=$(task rc.verbose=off rc.report._x.columns=uuid rc.report._x.filter=+feature _x | tail -1)
```

### F.3 Continue to spec phase

Proceed to **Step 1: Research & Discovery**. Skip Step 0's `tw_get_ticket` (there is no Jira task) — the feature-ticket annotations are the ticket context. In Steps 4 and 5, use the local-feature variants documented there (bash taskwarrior, not the `tw_*` tools — those key off `jiraid` and don't fit features).

## Resolving the Spec File Location

Use the `resolve_spec_path` tool with the Jira ID and `jirasummary`. It handles repo name detection, `$LLM_NOTES_ROOT`, and slug generation automatically.

**⚠️ IMPORTANT — never create a local `notes/` directory in the repo.** If
`$LLM_NOTES_ROOT` is set in the environment, `resolve_spec_path` returns an
absolute path under `$LLM_NOTES_ROOT/<repo>/notes/specs/` — always use that
returned path verbatim (do not shorten it, do not fall back to a repo-relative
`notes/specs/...` path, do not `mkdir` a `notes/` folder in the repo yourself).
Only when `$LLM_NOTES_ROOT` is unset does the tool fall back to a repo-local
`notes/specs/` path. Check `echo $LLM_NOTES_ROOT` if unsure before writing.

Example result when `$LLM_NOTES_ROOT` is unset: `notes/specs/IMP-7070__implement-user-balance-write.md`
Example result when set: `$LLM_NOTES_ROOT/<repo>/notes/specs/IMP-7070__implement-user-balance-write.md`

## Step 0: Fetch Ticket Context from Taskwarrior

> **Skip this entire step for local features** (Step F flow). There is no Jira task to fetch — use the F.1 interview notes as ticket context and jump to Step 1.

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

1. **Resolve the spec path** using the `resolve_spec_path` tool with the Jira ID and `jirasummary`. For local features (Step F), pass `jira_id="FEATURE-<short-uuid-8>"` where `<short-uuid-8>` is the first 8 chars of `$FEATURE_UUID`, and the feature summary as `summary`. The resulting filename reads `FEATURE-<uuid8>__<slug>.md` and ties the spec to the feature task.

2. **Write the spec** to the exact path the tool returned — never substitute a repo-local `notes/specs/...` path when `$LLM_NOTES_ROOT` is set.

3. **Use the template** at the end of this document.

## Step 5: Create Taskwarrior Tasks

After the spec is written and approved, create the taskwarrior tracking structure.

> **Note:** All tasks are created under `SalaryHero.$PROJECT` — the tools handle this prefix automatically. **Local features (Step F) are the exception:** use the project verbatim (no `SalaryHero.` prefix) and use the raw-taskwarrior variants documented under 5.1 and 5.2.

### 5.1 Create spec task (if not already existing)

Check with `tw_get_spec_task`. If no spec task exists, use `tw_create_spec_task` with:
- `jira_id`, `summary`, `project`, `repo`
- `spec_path` — the relative path returned by `resolve_spec_path` (relative portion, e.g. `notes/specs/IMP-7070__slug.md`)

#### Local feature variant (no `jiraid`)

The `tw_*` tools key off `jiraid` and don't fit local features — use raw taskwarrior instead. Create a separate spec task that depends on the feature ticket, mirroring the SalaryHero data model:

```bash
# Spec task depends on the feature ticket
SPEC_UUID=$(task add "SPEC: <summary>" project:<project> +spec depends:$FEATURE_UUID work_state:approved 2>&1 | grep -oP 'task \K[0-9]+' | head -1 | xargs -I{} task rc.verbose=off {} _uuid | tail -1)

# Annotate with spec path (same format tw_create_spec_task uses)
task $SPEC_UUID annotate "Spec(repo=<repo>): <relpath>"
```

The `<relpath>` is the relative portion of the path from `resolve_spec_path` (e.g. `notes/specs/FEATURE-<uuid8>__<slug>.md`).

### 5.2 Create phase and implementation tasks

For each phase in the spec:

1. Use `tw_create_phase` — returns the phase UUID
2. Use `tw_create_impl_task` for each task under that phase, passing the phase UUID as `depends_uuid`

#### Local feature variant (no `jiraid`)

Use raw taskwarrior. Phases depend on the spec task UUID (mirroring SalaryHero structure); subtasks depend on their phase UUID:

```bash
# Phase task
PHASE_UUID=$(task add "<N>. Phase: <phase-name>" project:<project> +phase +impl depends:$SPEC_UUID work_state:todo 2>&1 | grep -oP 'task \K[0-9]+' | head -1 | xargs -I{} task rc.verbose=off {} _uuid | tail -1)

# Implementation subtask
task add "<N.M> <task-title>" project:<project> +impl depends:$PHASE_UUID work_state:todo
```

The `description` prefixes (`1. Phase:`, `1.1`) matter — `tw_execution_plan` and the implement-plan skill sort by them.

### 5.3 Report created structure

Present the full task hierarchy. For Jira-linked plans:

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

For local features, prepend the feature ticket and substitute `FEATURE-<uuid8>` for `$JIRA_ID`:

```
🎟️ Feature: <summary> [+feature]
   └── UUID: $FEATURE_UUID

📋 Spec: SPEC: <summary> [+spec]
   └── Spec file: notes/specs/FEATURE-<uuid8>__<slug>.md

📦 Phase 1: <phase-name> [todo]
   ...
```

## Step 6: Review & Iterate

1. **Present the draft spec location** and taskwarrior summary.
2. **Iterate based on feedback** — update both the spec file AND taskwarrior tasks.
3. **Continue refining** until the user is satisfied.

## Integration with Other Skills

This skill works with:

- `/skill:feature-ticket` — **Required for local features (Step F).** Owns the interview and taskwarrior ticket creation; create-plan delegates to it instead of re-implementing the flow.
- `/skill:notes-locator` — Find existing specs, research docs, tickets, and PR descriptions in the notes directory.
- `fast_context_search` / `grep` / `find` — Find source files related to the ticket.
- `read` / `sem_context` — Understand current implementation details.
- `fast_context_search` / `grep` — Find similar features to model after.
- `/skill:implement-plan` — When the spec is approved and ready for development.

## Important Guidelines

1. **Jira ID is the source of truth for Jira-linked plans** — all context comes from taskwarrior queries. For local features (Step F), the feature task UUID plays that role and there is no Jira ID.
2. **Always verify the Jira task exists** before proceeding (skip for local features — you just created it).
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

For local features (Step F), substitute `FEATURE-<uuid8>` for `$JIRA_ID`, drop the `**Jira Ticket:**` and `**Issue Type:**` lines, and replace `$jiraurl` with the feature task UUID reference.

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
- Spec file: path returned by `resolve_spec_path` (`$LLM_NOTES_ROOT/<repo>/notes/specs/$JIRA_ID__$SLUG.md` if `$LLM_NOTES_ROOT` is set, else `notes/specs/$JIRA_ID__$SLUG.md`)

```

## Taskwarrior Integration Guidelines

1. **Always check for existing tasks** before creating new ones — use `tw_get_spec_task`, `tw_get_phases`, `tw_get_impl_tasks`
2. **Link via `jiraid` UDA** — all tools handle this automatically
3. **Annotate with context** — `tw_create_spec_task` adds the spec file annotation automatically
4. **Report task hierarchy** after creation — show the full structure to the user
5. **Nest projects under `SalaryHero`** — all tools prefix project with `SalaryHero.` automatically
