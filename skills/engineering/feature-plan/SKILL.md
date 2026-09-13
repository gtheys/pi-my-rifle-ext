---
name: feature-plan
description: Plan a local feature (no Jira ticket) end to end — interview, scout, interactive planner agent, plan.md artifact, and a taskwarrior feature hierarchy. Trigger on "plan a feature", "feature plan", "I want to add/build X" for a personal project, "spec a feature", "design a feature for my personal project". Jira-linked tickets route to create-plan instead.
---

# Feature Plan

Turn a local feature idea into a plan and a taskwarrior hierarchy a worker can execute. No Jira, no `jiraid` UDA. The feature task is the top of the tree; the planner agent writes `plan.md`; `implement-plan` resumes from the result.

## The Flow

### 1. Quick assessment (~30s, main session)

Skim `README.md`, `AGENTS.md`, `package.json`, and the area the feature touches — just enough to brief the scout. Tech stack, project shape, relevant directory. Don't go deeper; that's the scout's job.

### 2. Resolve the plan artifact path

Call `resolve_feature_path` with the feature summary. It returns an absolute `plan.md` path (under `$PERSONAL_FEATURES/<repo>/<date>-<slug>/` when set, else repo-local `.pi/plans/<date>-<slug>/`). Use the returned path verbatim everywhere below — never hand-roll it.

### 3. Scout

Spawn read-only scout subagent(s) — parallel is fine:

```
subagent({
  name: "scout: <area>",
  agent: "scout",
  task: "Feature context: <summary>\n\nMap the affected area: file structure, key modules, conventions, similar existing features. Focus on what a planner needs before designing this feature. Save findings to: <artifact-folder>/scout-context.md",
});
```

End your turn after spawning. Wait for the `subagent_result` steer message(s), then read the scout context back.

### 4. Interview — one focused round

Feature-ticket pattern. Ask only what you can't infer from scout findings, grouped in a single message. Aim for 3–6 questions (behavior, scope, trigger/UX, constraints, edge cases, boundaries). Always offer the out: "...or say 'use your judgment' and I'll pick sensible defaults." If the user defers, pick defaults and mark them as assumptions.

### 5. Create the feature task

```bash
task add "<summary>" project:<repo> +feature priority:M jirastatus:Local rc.confirmation:no
FEATURE_UUID=$(task rc.verbose=off <id> _uuid | tail -1)
```

Annotate the interview answers:

```bash
task $FEATURE_UUID annotate "Goal: ..."
task $FEATURE_UUID annotate "Behavior: ..."
task $FEATURE_UUID annotate "Done when: ..."
task $FEATURE_UUID annotate "Out of scope: ..."
task $FEATURE_UUID annotate "Spec(repo=<repo>): <plan.md path>"
```

The pseudo-ID is `FEATURE-<first-8-uuid-chars>` — use it as the label everywhere downstream. `jirastatus:Local` distinguishes feature-flow tasks in reports and makes them visible in the default `task list` (which excludes `jirastatus:Backlog`).

### 6. Spawn the interactive planner

```
subagent({
  name: "💬 Planner: <summary>",
  agent: "planner",
  interactive: true,
  task: [
    "Plan: <request>",
    "",
    "Scout findings:",
    "<scout-context summary or path>",
    "",
    "Interview answers:",
    "<Goal/Behavior/Done when/Out of scope annotations>",
    "",
    "Write the final plan to: <absolute plan.md path>",
    "",
    "After writing the plan file, call the open_in_pane tool with that path to open it with nvim in a review pane. Skippable if the user declines or the tool is unavailable — never block on it.",
    "",
    "Taskwarrior output contract (use these exact commands):",
    "<paste the Taskwarrior output contract below>",
  ].join("\n"),
});
```

The planner runs its own methodology (requirements, approaches, premortem, plan) with the user — don't re-specify that. Your job is context + the output contract. Contract points:

- Feature UUID is the parent: phases `depends:$FEATURE_UUID`, subtasks `depends:$PHASE_UUID`.
- `N.` / `N.M` description prefixes are REQUIRED — the execution plan sorts by them.
- Capture each phase UUID right after its `task add` (same `_uuid` trick).
- Annotate the feature task and every phase with the plan.md path.
- The planner must NOT commit code and must NOT set `work_state` beyond `todo`.

### 7. Verify the hierarchy

After the planner exits:

```
tw_execution_plan({ feature_uuid: "<uuid>" })
```

(Short uuid prefix works too.) Present the returned tree to the user and ask them to review both `plan.md` and the tree. Fixups go through the planner's contract commands.

### 8. Fallback — no `subagent` tool

If the subagent extension isn't loaded, do the scout work in the main session (`fast_context_search` / `grep` / `read`), write `plan.md` yourself, and create the hierarchy directly with the identical commands from the contract below. Everything else — interview, feature task, verification — is unchanged.

After writing `plan.md` in the fallback path, call the `open_in_pane` tool with the plan path (nvim review pane). Skippable on user request; tool failure never blocks the flow.

## Taskwarrior output contract

Byte-identical commands for both the planner and the fallback. `$FEATURE_UUID` comes from step 5.

```bash
# Phase (capture UUID immediately — subtasks depend on it)
PHASE_UUID=$(task add "<N>. Phase: <name>" project:<repo> +phase +impl jirastatus:Local depends:$FEATURE_UUID work_state:todo 2>&1 | grep -oP 'task \K[0-9]+' | head -1 | xargs -I{} task rc.verbose=off {} _uuid | tail -1)

# Annotate the phase with the plan path
task $PHASE_UUID annotate "Spec(repo=<repo>): <plan.md path>"

# Subtask under the phase
task add "<N.M> <title>" project:<repo> +impl jirastatus:Local depends:$PHASE_UUID work_state:todo
```

Repeat per phase, incrementing `N` (`1.`, `2.`, ...); subtasks `1.1`, `1.2`, `2.1`, ...

## What We're NOT Doing

- No `jiraid` UDA — this is the defining marker of a local feature.
- No `SalaryHero.` project prefix — bare repo name.
- No branch automation — `jira_create_branch` stays Jira-only.

## Integration with Other Skills

- `/skill:create-plan` — the Jira sibling; delegate there when a Jira ID exists.
- `/skill:implement-plan` — resumes this hierarchy via `tw_execution_plan feature_uuid:<uuid>`.
- `/skill:feature-ticket` — quick-ticket sibling without the planner flow; use it when the user wants a ticket, not a plan.
