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

2. **If no Jira ID provided**, start the **local feature flow** (Step F below): delegate the entire flow to `/skill:feature-plan`. Do not ask for a Jira ID — local features have none.

## Step F: Local Feature Flow (no Jira ID)

Use this flow when the skill is invoked without a Jira ID. **Delegate the entire flow to `/skill:feature-plan`** — it owns the interview, the scout subagents, the interactive planner agent, the `resolve_feature_path` artifact folder (`$PERSONAL_FEATURES/<repo>/<date>-<slug>/plan.md`), and the taskwarrior hierarchy (feature task `+feature` `jirastatus:Local` → phases → subtasks). Do not re-implement any of it here.

After `feature-plan` completes, this skill's remaining responsibilities for the feature are Step 6 (review & iterate — update `plan.md` and the taskwarrior tree together) — everything else (path resolution, planner, hierarchy creation) already happened.

## Resolving the Spec File Location

Use the `resolve_spec_path` tool with the Jira ID and `jirasummary`. It handles repo name detection, `$LLM_NOTES_ROOT`, and slug generation automatically.

**⚠️ IMPORTANT — never create a local `notes/` directory in the repo.** If
`$LLM_NOTES_ROOT` is set in the environment, `resolve_spec_path` returns an
absolute path under `$LLM_NOTES_ROOT/<repo>/notes/specs/` — always use that
returned path verbatim (do not shorten it, do not fall back to a repo-relative
`notes/specs/...` path, do not `mkdir` a `notes/` folder in the repo yourself).
Only when `$LLM_NOTES_ROOT` is unset does the tool fall back to a repo-local
`notes/specs/` path. Check `echo $LLM_NOTES_ROOT` if unsure before writing.
For local features (Step F) this section does not apply — `feature-plan` uses
`resolve_feature_path` (`$PERSONAL_FEATURES` / `.pi/plans/`) instead.

Example result when `$LLM_NOTES_ROOT` is unset: `notes/specs/IMP-7070__implement-user-balance-write.md`
Example result when set: `$LLM_NOTES_ROOT/<repo>/notes/specs/IMP-7070__implement-user-balance-write.md`

## Step 0: Fetch Ticket Context from Taskwarrior

> **Skip this entire step for local features** (Step F flow delegates to `feature-plan`, which owns its own context gathering).

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

Before asking the user any questions, research the codebase **by spawning `scout` subagents** via the `subagent` tool (from the pi-interactive-subagents extension). Do not do deep codebase research in the main session yourself — scouts do it.

**Fallback:** if the `subagent` tool is not available (extension not loaded, no terminal multiplexer), do the research in the main session with `fast_context_search` / `grep` / `read` / `sem_context` — the rest of the flow is identical.

1. **Decompose research into focused scout tasks** — one scout per focus area. Typical areas:
   - Files/modules related to the ticket (map the territory + read the important files)
   - Similar existing features to model after
   - Conventions, patterns, and test setup for the affected area
   - Existing notes/specs about this feature (scout can grep the notes dir)

2. **Spawn the scouts** — parallel is fine, they are read-only:

   ```
   subagent({
     name: "scout: <focus area>",
     agent: "scout",
     task: "Ticket context: <jirasummary>\n\nExplore <specific area/question>. Read the relevant files FULLY. Report findings with file:line references using your output template.",
   })
   ```

   The `subagent` tool returns immediately. **End your turn after spawning** — the harness steers each `subagent_result` back into this session as a steer message when a scout finishes.

3. **Wait for ALL scout results** before proceeding. If a scout's report is thin or contradicts the ticket, spawn a follow-up scout for that specific gap.

4. **Analyze and verify understanding**:
   - Cross-reference the Jira description/acceptance criteria with the scout findings
   - Identify discrepancies between ticket and codebase
   - Note assumptions that need verification
   - Use `read` / `sem_context` yourself only to verify a specific load-bearing claim from a scout report

5. **Present informed understanding and focused questions**:

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

1. **If the user corrects a misunderstanding**, spawn a new scout to verify — don't just accept it.

2. **Create a research todo list** with markdown checkboxes to track exploration.

3. **Spawn follow-up scouts** for comprehensive research:
   - More specific files/areas the first round missed
   - Implementation details that affect the design
   - Similar implementations to copy patterns from

4. **Wait for ALL scout results** before proceeding.

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

2. **Write the spec** to the exact path the tool returned — never substitute a repo-local `notes/specs/...` path when `$LLM_NOTES_ROOT` is set.

3. **Use the template** at the end of this document.

4. **Open the spec for review** — call the `open_in_pane` tool with the spec path just written. It opens the file with nvim in a herdr pane (`spec-review`). Skippable on user request; if the tool reports herdr unavailable, continue anyway — the flow is never blocked by the pane step.

## Step 5: Create Taskwarrior Tasks

After the spec is written and approved, create the taskwarrior tracking structure.

> **Note:** All tasks are created under `SalaryHero.$PROJECT` — the tools handle this prefix automatically. Local features never reach this step (Step F delegates to `feature-plan`).

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

- `subagent` tool (pi-interactive-subagents) — **Required.** Spawns `scout` agents for codebase research in Steps 1 and 2. Requires a terminal multiplexer (see pi-interactive-subagents setup).
- `/skill:feature-plan` — **Required for local features (Step F).** Owns the entire local-feature flow (interview, scout, planner agent, artifact folder, taskwarrior hierarchy); create-plan delegates to it instead of re-implementing.
- `/skill:notes-locator` — Find existing specs, research docs, tickets, and PR descriptions in the notes directory (quick main-session lookups).
- `read` / `sem_context` — Verify specific load-bearing claims from scout reports.
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

1. **Spawn multiple scouts in parallel** for efficiency — they are read-only and cannot conflict
2. **Each scout should be focused** on a specific area
3. **Be EXTREMELY specific about directories** — if the ticket mentions "WUI", tell the scout `humanlayer-wui/`; never use generic terms
4. **Wait for all scout results** before synthesizing
5. **Verify results** — if a scout returns unexpected results, spawn a follow-up scout for that specific gap

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

For local features (Step F) the spec template is owned by `feature-plan` — see its plan.md structure. This template is Jira-only.

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
