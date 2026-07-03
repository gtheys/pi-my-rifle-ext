---
name: taskwarrior-plan
description: Manage taskwarrior-based tickets — create, update, comment, and follow workflow patterns. Use when the user wants to work with taskwarrior tasks, create tickets, update status, or manage the spec/plan/dev workflow. Trigger on mentions of "taskwarrior", "tw", "ticket", "task", "jira", or workflow state transitions.
---

# Taskwarrior Plan Management

You are tasked with managing taskwarrior-based tickets, including creating tickets from notes documents, updating existing tickets, and following the team's specific workflow patterns.

This skill wraps your existing `jira-taskwarrior-workflow` and `taskwarrior` skills. It provides a project-agnostic interface for ticket management via taskwarrior.

## Initial Setup

First, verify that taskwarrior is available:

```bash
which task && task --version
```

If taskwarrior is not available, respond:

```
Taskwarrior is not installed or not in PATH. Please install taskwarrior and configure it before using ticket management.
```

If taskwarrior is available, respond based on the user's request.

## Team Workflow & Status Progression

The team follows a specific workflow to ensure alignment before code implementation:

1. **Triage** → All new tickets start here for initial review
2. **Spec Needed** → More detail is needed - problem to solve and solution outline necessary
3. **Research Needed** → Ticket requires investigation before spec can be written
4. **Research in Progress** → Active research/investigation underway
5. **Research in Review** → Research findings under review (optional step)
6. **Ready for Plan** → Research complete, ticket needs an implementation spec
7. **Plan in Progress** → Actively writing the implementation spec
8. **Plan in Review** → Spec is written and under discussion
9. **Ready for Dev** → Spec approved, ready for implementation
10. **In Dev** → Active development
11. **Code Review** → PR submitted

## Workflow Commands

### For general requests

```
I can help you with taskwarrior tickets. What would you like to do?
1. Create a new ticket from a notes document
2. Add a comment to a ticket
3. Search for tickets
4. Update ticket status or details
5. Run `/skill:create-plan` for the full spec → tasks → implement pipeline
```

### For specific create requests

```
I'll help you create a taskwarrior ticket from your notes. Please provide:
1. The path to the notes document (or topic to search for)
2. Any specific focus or angle for the ticket (optional)
```

Then wait for the user's input.

## Resolving the Notes Directory

When looking for notes documents, resolve the path:

1. **Get the current repo name**:

   ```bash
   basename "$(git remote get-url origin 2>/dev/null | sed 's/\.git$//')" 2>/dev/null
   ```

2. **Resolve the notes path**:
   - If `$LLM_NOTES_ROOT` is set → `$LLM_NOTES_ROOT/<repo>/notes/`
   - Otherwise → `notes/` relative to the repo root

## Ticket Creation from Notes

When creating a ticket from a notes document:

1. **Read the notes document** fully
2. **Extract key information**:
   - Problem to solve
   - Proposed solution
   - Acceptance criteria
   - Related files or components

3. **Create taskwarrior task**:

   ```bash
   task add "[Ticket Title]" project:eng priority:H
   task <uuid> annotate "Problem: [problem summary]"
   task <uuid> annotate "Solution: [solution summary]"
   task <uuid> annotate "Source: [path to notes document]"
   ```

4. **Set initial status**:

   ```bash
   task <uuid> modify work_state:todo
   ```

5. **Report the created ticket**:

   ```
   Created ticket [ID]: [Title]
   Status: [Initial status]
   Source: [Notes document path]
   ```

## Status Management

### Moving tickets through the workflow

```bash
# Move to research needed
task <uuid> modify work_state:research_needed

# Move to research in progress
task <uuid> modify work_state:research_inprogress

# Move to ready for plan
task <uuid> modify work_state:ready_for_plan

# Move to plan in progress
task <uuid> modify work_state:plan_inprogress

# Move to ready for dev
task <uuid> modify work_state:ready_for_dev

# Move to in dev
task <uuid> modify work_state:in_dev

# Move to code review
task <uuid> modify work_state:code_review
```

### Finding tickets by status

```bash
# All pending tickets
task status:pending list

# Tickets in specific state
task work_state:research_needed list
task work_state:ready_for_dev list

# High priority tickets
task priority:H status:pending list

# Tickets for a specific project
task project:eng status:pending list
```

## Query Patterns

### Finding the highest priority ticket

```bash
task status:pending priority:H list
task status:pending priority:M list
```

### Finding tickets ready for next stage

```bash
# Ready for research
task work_state:research_needed status:pending list

# Ready for plan
task work_state:ready_for_plan status:pending list

# Ready for dev
task work_state:ready_for_dev status:pending list
```

### Finding tickets by tag

```bash
task +spec list
task +impl list
task +jira list
```

## Integration with Other Skills

This skill works with:

- `/skill:create-plan` — Full spec → tasks → implement pipeline (use when a ticket is ready for planning)
- `/skill:notes-locator` — Find existing notes, specs, research, and tickets
- `/skill:taskwarrior` — Reference for query patterns and state management
- `/skill:implement-plan` — When a ticket is ready for development

## Important Guidelines

1. **Always use taskwarrior for state tracking** — don't maintain state in conversation
2. **Annotate with context** — always link back to source documents
3. **Be specific about status** — use the full workflow states, not just pending/done
4. **Respect the workflow** — don't skip stages without good reason
5. **Use `$LLM_NOTES_ROOT`** — when linking to notes documents, resolve the path correctly

## Quick Reference

```bash
# Create ticket
task add "Title" project:eng priority:H
task <uuid> annotate "Details..."

# Update status
task <uuid> modify work_state:ready_for_dev

# Add comment
task <uuid> annotate "Comment text..."

# Find tickets
task status:pending list
task work_state:ready_for_plan list
task project:eng priority:H list

# Complete ticket
task <uuid> done
```
