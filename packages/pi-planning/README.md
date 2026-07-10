# pi-planning

Pi extension that provides typed [taskwarrior](https://taskwarrior.org/) tools for the `create-plan`, `iterate-plan`, and `implement-plan` skills.

Replaces raw `bash`/`jq` pipelines with validated, structured tool calls.

## Extensions

| Entry | Description |
|---|---|
| `plan-tools/index.ts` | Tools for creating and managing specs and phase tasks |
| `implement-plan/index.ts` | Tools for driving implementation from a taskwarrior phase/subtask tree |

---

## plan-tools — Spec & Plan Creation

Typed tools for the `create-plan` and `iterate-plan` skills.

### Tools

| Tool | Description |
|------|-------------|
| `tw_get_ticket` | Fetch Jira ticket details from taskwarrior by Jira ID |
| `tw_get_spec_task` | Fetch spec task + extract spec file path from annotation |
| `tw_get_phases` | Fetch all phase tasks (`+phase` tag) for a Jira ticket |
| `tw_get_impl_tasks` | Fetch all implementation tasks (`+impl` tag) for a Jira ticket |
| `resolve_spec_path` | Compute canonical spec file path (respects `$LLM_NOTES_ROOT`) |
| `tw_create_spec_task` | Create spec task in taskwarrior and annotate it with the spec file path |
| `tw_create_phase` | Create a phase task; returns UUID for use as `depends_uuid` |
| `tw_create_impl_task` | Create an implementation subtask under a phase |

### Command

```
/plan <JIRA-ID>    — create or iterate on an implementation plan
```

---

## implement-plan — Spec Execution

Typed tools for the `implement-plan` skill, driving work from the taskwarrior phase/subtask tree.

### Tools

| Tool | Description |
|------|-------------|
| `tw_execution_plan` | Fetch full sorted phase + subtask tree; returns `currentPhase`/`currentSubtask` resume pointers |
| `tw_advance_task` | Transition a task to `todo`, `inprogress`, or `done` |
| `tw_phase_checkpoint` | Mark phase done and return a ready-made git commit message |

### Command

```
/implement <JIRA-ID>    — show execution plan and start implementing
```

---

## Usage

Tools are registered automatically and consumed by the bundled skills. See the [create-plan](../../skills/engineering/create-plan/SKILL.md) and [implement-plan](../../skills/engineering/implement-plan/SKILL.md) skills for workflows.
