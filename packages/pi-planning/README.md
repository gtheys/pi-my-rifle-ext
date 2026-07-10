# pi-planning

Pi extension that provides typed [taskwarrior](https://taskwarrior.org/) tools for the `create-plan`, `iterate-plan`, and `implement-plan` skills.

Replaces raw `bash`/`jq` pipelines with validated, structured tool calls.

## Extensions

| Entry | Description |
|---|---|
| `plan-tools/index.ts` | Tools for creating and managing specs and phase tasks (`tw_get_ticket`, `tw_create_spec_task`, `tw_create_phase`, `tw_create_impl_task`, …) |
| `implement-plan/index.ts` | Tools for driving implementation (`tw_execution_plan`, `tw_advance_task`, `tw_phase_checkpoint`) |

## Usage

Tools are registered automatically and consumed by the bundled skills. See the [create-plan](../../skills/engineering/create-plan/SKILL.md) and [implement-plan](../../skills/engineering/implement-plan/SKILL.md) skills for workflows.
