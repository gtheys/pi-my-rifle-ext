---
name: pr-description
description: Generate comprehensive PR descriptions following repository templates. Use when the user wants to create or update a PR description. Trigger on mentions of "PR description", "describe PR", "generate PR", or "pr desc".
---

# Generate PR Description

You are tasked with generating a comprehensive pull request description following the repository's standard template.

## Resolving the Notes Directory

Whatever route you take below, use the resolved **absolute** path directly in
all subsequent steps — don't store it in a variable.

**Primary — use the resolver tool.** When `resolve_notes_path` is available (it
is registered by the pi-flow extension), call it: it returns the canonical
notes directory, honoring `$LLM_NOTES_ROOT` when set and the repo-local
`notes/` directory otherwise. Pass `subdir: ""` for the notes root, or
`subdir: "prs"` to resolve the PR descriptions directory
(`<notes root>/prs/`) in one call — prefer the `prs` form for reading and
writing descriptions. Prefer this — it matches what the rest of the flow
tooling resolves to, and never hand-roll the path when the tool answered.

AIDEV-NOTE: resolver-with-fallback is deliberate — this skill must stay usable
when pi-flow is absent, so the tool is "call it when present" and the prose
below is explicitly the fallback, not the contract. Keep both in sync with
`resolveNotesPath()` in packages/pi-flow/plan-tools/helpers.ts.

**Fallback — only when the tool is unavailable** (pi-flow is not installed):

1. **Get the current repo name**:

   ```bash
   basename "$(git remote get-url origin 2>/dev/null | sed 's/\.git$//')" 2>/dev/null
   ```

   If this fails, fall back to `basename "$(git rev-parse --show-toplevel 2>/dev/null)"`, then to `basename "$PWD"`.

2. **Resolve the notes path** — check first with `echo $LLM_NOTES_ROOT`:
   - If `$LLM_NOTES_ROOT` is set → `$LLM_NOTES_ROOT/<repo>/notes/`
   - Otherwise → `notes/` relative to the repo root

   **⚠️ IMPORTANT — never create a local `notes/` directory in the repo.** When
   `$LLM_NOTES_ROOT` is set, always read from and write to the absolute
   `$LLM_NOTES_ROOT/<repo>/notes/prs/` path verbatim — do not fall back to a
   repo-relative `notes/prs/...` path, and do not `mkdir` a `notes/` folder in
   the repo yourself. Only when `$LLM_NOTES_ROOT` is unset do notes live at the
   repo-local `notes/` path.

3. **Template is shared, output is per-repo**:
   - The PR description **template** (`pr_description.md`) is **shared across all
     repos** at `$LLM_NOTES_ROOT/_default/notes/prs/pr_description.md` — a repo
     only needs its own copy to override. See Step 1 for the full fallback chain.
   - Generated descriptions (`{number}_description.md`) are written **per-repo**
     at the resolved PR descriptions directory (`<notes root>/prs/`).

## Steps

### 1. Read the PR Description Template

Resolve the template with a fallback chain — use the first one that exists:

1. Repo-specific override: `<resolved notes path>/prs/pr_description.md`
   (i.e. `$LLM_NOTES_ROOT/<repo>/notes/prs/pr_description.md`, or repo-local
   `notes/prs/pr_description.md` when `$LLM_NOTES_ROOT` is unset; this is the
   `prs` directory returned by `resolve_notes_path` with `subdir: "prs"`, plus
   the filename)
2. Shared default: `$LLM_NOTES_ROOT/_default/notes/prs/pr_description.md`
   (only when `$LLM_NOTES_ROOT` is set)

The shared default is the normal case.

If neither exists, inform the user:

```
No PR description template found. Checked:
  - $LLM_NOTES_ROOT/<repo>/notes/prs/pr_description.md
  - $LLM_NOTES_ROOT/_default/notes/prs/pr_description.md
Create a template so I know what format to follow.
```

Read the template carefully to understand all sections and requirements.

### 2. Identify or Create the PR

- Check if the current branch has an associated PR:

  ```bash
  gh pr view --json url,number,title,state 2>/dev/null
  ```

- **If a PR exists:** use its number for the rest of the skill.

- **If no PR exists** (and not on main/master): **create one** — do not list
  other PRs or ask the user. The description generated in Step 7 will replace
  the placeholder body in Step 9.

  1. Determine the base branch from the template's stated base (SalaryHero repos
     use `develop`). If the template doesn't name one, use the repo's default
     branch (`gh repo view --json defaultBranchRef`).
  2. Create the PR with a placeholder body:

     ```bash
     gh pr create --base <base> --body "Pending description"
     ```

     If the branch isn't pushed yet, `gh pr create` pushes it first. Capture
     the PR number from the output.

  3. Use the new PR number in all subsequent steps.

### 3. Check for Existing Description

- Check if `notes/prs/{number}_description.md` already exists at the resolved notes path
- If it exists, read it and inform the user you'll be updating it
- Consider what has changed since the last description was written

### 4. Gather Comprehensive PR Information

- Get the full PR diff: `gh pr diff {number}`
- If you get an error about no default remote repository, instruct the user to run `gh repo set-default`
- Get commit history: `gh pr view {number} --json commits`
- Review the base branch: `gh pr view {number} --json baseRefName`
- Get PR metadata: `gh pr view {number} --json url,title,number,state`

### 5. Analyze the Changes Thoroughly

Think deeply about the code changes, their architectural implications, and potential impacts:

- Read through the entire diff carefully
- For context, read any files that are referenced but not shown in the diff
- Understand the purpose and impact of each change
- Identify user-facing changes vs internal implementation details
- Look for breaking changes or migration requirements

### 6. Handle Verification Requirements

- Look for any checklist items in the "How to verify it" section of the template
- For each verification step:
  - If it's a command you can run (`make check test`, `npm test`, etc.), run it
  - If it passes, mark the checkbox as checked: `- [x]`
  - If it fails, keep it unchecked and note what failed: `- [ ]` with explanation
  - If it requires manual testing, leave unchecked and note for user
- Document any verification steps you couldn't complete

### 7. Generate the Description

- Fill out each section from the template thoroughly
- Be specific about problems solved and changes made
- Focus on user impact where relevant
- Include technical details in appropriate sections
- Write a concise changelog entry
- Ensure all checklist items are addressed (checked or explained)

### 8. Save the Description

- Write the completed description to `notes/prs/{number}_description.md` at the resolved notes path
- Show the user the generated description

### 9. Update the PR

- Update the PR description directly:

  ```bash
  gh pr edit {number} --body-file <resolved-path>/notes/prs/{number}_description.md
  ```

- Confirm the update was successful
- If any verification steps remain unchecked, remind the user to complete them before merging

### 10. Watch Checks and Trigger PR Quality

After updating the PR description, kick off background check watching:

```
/pr-watch {number}
```

This returns immediately — the extension spawns a detached background process that polls `gh pr checks` every 60s. When all checks pass it automatically triggers `/pr-quality`. If a check fails it notifies via the pi status bar.

You can continue with other work after invoking `/pr-watch`.

---

## Integration with Other Skills

- `/skill:notes-locator` — Find existing PR descriptions, specs, and related notes.
- `/skill:create-plan` — If the PR implements a spec, reference it in the description.
- `read` / `sem_context` / `fast_context_search` — For deeper understanding of changed code when the diff isn't enough context.

## Important Notes

- This command works across different repositories — always read the local template
- Be thorough but concise — descriptions should be scannable
- Focus on the "why" as much as the "what"
- Include any breaking changes or migration notes prominently
- If the PR touches multiple components, organize the description accordingly
- Always attempt to run verification commands when possible
- Clearly communicate which verification steps need manual testing
