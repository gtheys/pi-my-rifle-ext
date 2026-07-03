---
name: iterate-plan
description: Iterate on existing implementation specs with thorough research and updates. Use when the user wants to modify, update, or refine an existing spec. Trigger on mentions of "update plan", "iterate plan", "modify plan", "change plan", "update spec", "iterate spec", or "modify spec".
---

# Iterate Implementation Spec

You are tasked with updating existing implementation specs based on user feedback. You should be skeptical, thorough, and ensure changes are grounded in actual codebase reality.

## Resolving the Notes Directory

Use the `resolve_spec_path` tool with the Jira ID and summary to compute the canonical spec path. It handles repo name detection and `$LLM_NOTES_ROOT` automatically.

Alternatively, list recent specs:
```bash
ls -lt notes/specs/ | head
```
Or search by Jira ID:
```bash
ls notes/specs/ | grep -i IMP-7070
```

## Initial Response

When this skill is invoked:

1. **Parse the input to identify**:
   - Spec file path (e.g., `notes/specs/IMP-7070__parent-child-tracking.md`)
   - Requested changes/feedback

2. **Handle different input scenarios**:

   **If NO spec file provided**:

   ```
   I'll help you iterate on an existing implementation spec.

   Which spec would you like to update? Please provide the path or Jira ID.

   Tip: You can list recent specs with `ls -lt notes/specs/ | head`
   Or search by Jira ID: `ls notes/specs/ | grep -i IMP-7070`
   ```

   Wait for user input, then re-check for feedback.

   **If spec file provided but NO feedback**:

   ```
   I've found the spec at [path]. What changes would you like to make?

   For example:
   - "Add a phase for migration handling"
   - "Update the success criteria to include performance tests"
   - "Adjust the scope to exclude feature X"
   - "Split Phase 2 into two separate phases"
   ```

   Wait for user input.

   **If BOTH spec file AND feedback provided**:
   - Proceed immediately to Step 1
   - No preliminary questions needed

## Process Steps

### Step 1: Read and Understand Current Spec

1. **Read the existing spec file COMPLETELY**:
   - Use the Read tool WITHOUT limit/offset parameters
   - Understand the current structure, phases, and scope
   - Note the success criteria and implementation approach

2. **Understand the requested changes**:
   - Parse what the user wants to add/modify/remove
   - Identify if changes require codebase research
   - Determine scope of the update

### Step 2: Research If Needed

**Only spawn research if the changes require new technical understanding.**

If the user's feedback requires understanding new code patterns or validating assumptions:

1. **Create a research todo list** using markdown checkboxes

2. **Use skills for research**:
   - `fast_context_search` / `grep` / `find` — find relevant files
   - `read` / `sem_context` — understand implementation details
   - `fast_context_search` / `grep` — find similar patterns
   - `/skill:notes-locator` — find related research or decisions

   **Be EXTREMELY specific about directories** — if the change involves "WUI", specify `humanlayer-wui/`; never use generic terms.

3. **Read any new files identified by research** FULLY into the main context.

4. **Wait for ALL research to complete** before proceeding.

### Step 3: Present Understanding and Approach

Before making changes, confirm your understanding:

```
Based on your feedback, I understand you want to:
- [Change 1 with specific detail]
- [Change 2 with specific detail]

My research found:
- [Relevant code pattern or constraint]
- [Important discovery that affects the change]

I plan to update the spec by:
1. [Specific modification to make]
2. [Another modification]

Does this align with your intent?
```

Get user confirmation before proceeding.

### Step 4: Update the Spec

1. **Make focused, precise edits** to the existing spec:
   - Use the Edit tool for surgical changes
   - Maintain the existing structure unless explicitly changing it
   - Keep all file:line references accurate
   - Update success criteria if needed

2. **Ensure consistency**:
   - If adding a new phase, ensure it follows the existing pattern
   - If modifying scope, update "What We're NOT Doing" section
   - If changing approach, update "Implementation Approach" section
   - Maintain the distinction between automated vs manual success criteria

3. **Preserve quality standards**:
   - Include specific file paths and line numbers for new content
   - Write measurable success criteria
   - Use `make` commands for automated verification
   - Keep language clear and actionable

### Step 5: Update Taskwarrior (If Applicable)

If the spec has associated taskwarrior tasks, update them to reflect changes.

Use these tools to inspect and update:
- `tw_get_phases` — list existing phase tasks
- `tw_get_impl_tasks` — list existing implementation tasks
- `tw_create_phase` — add a new phase task (returns UUID)
- `tw_create_impl_task` — add a new impl task under a phase


### Step 6: Review

1. **Present the changes made**:

   ```
   I've updated the spec at `notes/specs/[filename].md`

   Changes made:
   - [Specific change 1]
   - [Specific change 2]

   The updated spec now:
   - [Key improvement]
   - [Another improvement]

   Would you like any further adjustments?
   ```

2. **Be ready to iterate further** based on feedback.

## Integration with Other Skills

- `/skill:create-plan` — Use this to create a new spec from scratch. Use `iterate-plan` to modify an existing one.
- `/skill:notes-locator` — Find existing specs, research docs, and related notes.
- `fast_context_search` / `grep` / `find` / `sem_context` — Research the codebase when changes require new technical understanding.

## Important Guidelines

1. **Be Skeptical** — don't blindly accept change requests that seem problematic. Question vague feedback, verify technical feasibility, point out conflicts with existing phases.
2. **Be Surgical** — make precise edits, not wholesale rewrites. Preserve good content that doesn't need changing. Only research what's necessary.
3. **Be Thorough** — read the entire existing spec before making changes. Research code patterns if changes require new technical understanding. Ensure success criteria are still measurable.
4. **Be Interactive** — confirm understanding before making changes. Show what you plan to change before doing it. Allow course corrections.
5. **Track Progress** — use markdown checkboxes for complex updates.
6. **No Open Questions** — if the requested change raises questions, ASK. Do NOT update the spec with unresolved questions.

## Research Best Practices

When using skills for research:

- Use multiple skills in parallel for efficiency
- Be specific about directories
- Request file:line references
- Verify results before accepting them
- Cross-check findings against the actual codebase
