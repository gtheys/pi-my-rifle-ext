---
name: gh-unresolved-comments
description: Fetch unresolved PR review comments from GitHub, assess each as VALID or INVALID, auto-resolve INVALID threads, and produce a resolution plan for VALID ones. Use when the user asks about unresolved PR comments, wants to triage review feedback, resolve stale threads, or assess what still needs action on a PR. Also trigger on "unresolved comments", "open review threads", "pending reviews", "triage PR feedback".
---

# Unresolved PR Comment Triage

This skill fetches unresolved review threads from a GitHub PR, assesses each comment, auto-resolves invalid ones, and writes a resolution plan for valid ones.

## Prerequisites

- `gh` (GitHub CLI) installed and authenticated
- `jq` installed
- User must have access to the target repository

## Arguments

If no PR number is provided in `$ARGUMENTS`, ask for it.

Optionally include `--repo OWNER/REPO` if not inside the target git repo.

## Step 1 — Fetch unresolved comments

Run the bundled script with `--format json`:

```bash
bash <SKILL_DIR>/scripts/fetch_unresolved_comments.sh <PR_NUMBER> --format json
```

If `--repo` is needed:

```bash
bash <SKILL_DIR>/scripts/fetch_unresolved_comments.sh <PR_NUMBER> --repo OWNER/REPO --format json
```

The JSON output contains `unresolved_threads` — an array where each thread has:

| Field | Description |
|-------|-------------|
| `threadId` | GraphQL node ID (needed to resolve the thread) |
| `path` | File the comment is on |
| `line` | Line number |
| `startLine` | Start line (may be null) |
| `isOutdated` | Whether the comment is on an outdated diff |
| `comments` | Array of replies with `author`, `body`, `createdAt`, `url` |

## Step 2 — Assess each unresolved comment

For each thread in `unresolved_threads`, read the referenced file and check the current code around the commented line.

Classify each comment as **VALID** or **INVALID**:

### VALID — the comment needs action

- Identifies a real bug, security issue, or logic error
- Suggests a meaningful improvement to quality, readability, or performance
- Raises a legitimate architectural or design concern
- Points out missing error handling, edge cases, or tests

### INVALID — the comment should be dismissed

- Refers to code that has already been changed or fixed (outdated diff)
- Is a style nitpick with no functional impact
- Is based on a misunderstanding of the code's intent
- Is already answered elsewhere in the PR
- Is purely cosmetic with no meaningful impact

## Step 3 — Handle INVALID comments

For each INVALID comment, auto-resolve the thread on GitHub:

```bash
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread_id>"}) { thread { isResolved } } }'
```

Replace `<thread_id>` with the `threadId` from the JSON output.

## Step 4 — Handle VALID comments

Create a resolution plan as a markdown checklist.

### Plan structure

```markdown
# Resolution Plan — PR #{pr_number}

> **{pr_title}**
> {pr_url}

## Summary

- **Total unresolved:** {total}
- **Valid (action needed):** {valid_count}
- **Invalid (auto-resolved):** {invalid_count}

## Tasks

### 1. `{file_path}` (line {line})

- [ ] {specific actionable task description}

**Reviewer:** @{author}
**Comment:** > {original comment}
**Why valid:** {reason}
```

Write the plan to `gh-comment-resolve-plan.md` in the repository root.

## Script reference

The script at `scripts/fetch_unresolved_comments.sh` supports these options:

| Flag | Description | Default |
|------|-------------|---------|
| `--repo OWNER/REPO` | Specify repository explicitly | Inferred from git remote |
| `--format json\|table\|minimal` | Output format | `table` |
| `--limit N` | Max review threads to fetch | `100` |
