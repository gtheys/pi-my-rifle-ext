# Planning & Implementation Workflow

How a Jira ticket becomes a written spec, then a phased, resumable implementation —
end to end across the `pi-planning` extensions, taskwarrior, and the
`create-plan`/`iterate-plan`/`implement-plan` skills.

## Why taskwarrior, not a file in the repo

State for "what's the plan and where are we in it" lives in **taskwarrior**, external
to any single git repo, because implementation often spans multiple sessions and the
agent needs a durable, queryable source of truth for resume points. The spec's prose
lives in a markdown file; taskwarrior tracks structured progress against it.

## The two roles

| Extension | Skill it backs | Responsibility |
|---|---|---|
| `pi-planning/plan-tools` | `create-plan`, `iterate-plan` | Turn a Jira ticket into a spec file + phase/subtask task tree |
| `pi-planning/implement-plan` | `implement-plan` | Walk that task tree, advancing state, checkpointing phases |

Both share `packages/pi-planning/shared/tw-utils.ts` (`twExport`) — the only code they
have in common. Everything else about "how a spec is written" vs "how it's executed"
is intentionally separate.

## 1. Spec creation (`/plan <JIRA_ID>`)

`packages/pi-planning/plan-tools/index.ts`

1. `tw_get_ticket` — fetch the Jira ticket fields from taskwarrior (description,
   `jiradescription`, `jirasummary`, `jirastatus`, `jiraurl`, `jiraissuetype`,
   `jiraparent`, tags, project).
2. `tw_get_spec_task` — check whether a spec task already exists; if so, extract its
   file path from an annotation matching `Spec(repo=<repo>): <path>`
   (`extractSpecPath`). **This regex is the single link** between a taskwarrior task
   and a file on disk — if you ever need to change the annotation format, update the
   writer (`tw_create_spec_task`) and this parser together, and check nothing else in
   the repo depends on the old format (grep `Spec(repo=`).
3. `resolve_spec_path` — compute the canonical path:
   `<specDir>/notes/specs/<JIRA_ID>__<slug>.md`, where:
   - `specDir` = `$LLM_NOTES_ROOT/<repoName>` if `LLM_NOTES_ROOT` is set (centralized
     notes vault spanning multiple repos), else `<repo-root>/notes`.
   - `repoName` = `git rev-parse --show-toplevel` basename.
   - `slug` = Jira summary lowercased, non-alnum stripped, first 5 words, dash-joined.
4. `tw_create_spec_task` — create the taskwarrior spec task, tag `+spec`, set
   `work_state:approved`, project `SalaryHero.<project>`, and annotate it with
   `Spec(repo=<repo>): <relative-path>`.
5. `tw_create_phase` (per phase) — creates a `+impl +phase` task titled like
   `"N. Phase: <name>"`, `work_state:todo`. Returns a UUID.
6. `tw_create_impl_task` (per subtask) — creates a `+impl` task titled
   `"N.M <description>"`, `depends:<phase UUID>`, `work_state:todo`.

`/plan <JIRA_ID>` itself just routes: if a spec file already exists → **iterate-plan**
skill; otherwise → **create-plan** skill. The routing decision, not the file writing,
is what the command does — actual spec authoring is the skill's job (see
`skills/engineering/create-plan/SKILL.md` and `iterate-plan/SKILL.md`).

## 2. Task numbering convention (must match exactly)

- Phase task title: `"<N>. Phase: <Phase Name>"` — parsed by
  `parsePhaseNumber` (regex `^(\d+)\.\s*Phase:`) and `parsePhaseName`.
- Subtask title: `"<N>.<M> <description>"` — parsed by `parseSubtaskNumber`
  (regex `^(\d+\.\d+)`) and `parseSubtaskName`.
- Subtasks `depends:` their parent phase's UUID; sorting is purely by the numeric
  prefix in the title (`sortByPrefix` in `implement-plan/index.ts`), **not** by
  taskwarrior's own ordering or creation time. If you hand-edit a task title and break
  this pattern, `tw_execution_plan` will fail to place it correctly.

## 3. Execution (`/implement <JIRA_ID>`)

`packages/pi-planning/implement-plan/index.ts`

1. **`tw_execution_plan`** — fetches all `+impl` tasks for the Jira ID, groups them
   into phases with nested subtasks, sorted by numeric prefix, and computes:
   - `currentPhase` / `currentSubtask` — the **first non-done item**, i.e. the resume
     point. This is what makes `/implement` idempotent/resumable across sessions —
     call it again any time and it picks up exactly where it left off.
   - `totalSubtasks` / `doneSubtasks` for progress reporting.
2. **`tw_advance_task`** — transitions a task's `work_state` through
   `todo → inprogress → done`. When set to `done`, it also runs `task done` to close
   the taskwarrior task (`status:completed`) — `work_state` and taskwarrior `status`
   are two separate fields that must be kept in sync, and this tool is the only place
   that does both.
3. **`tw_phase_checkpoint`** — call *after* tests pass and the user has confirmed a
   phase is complete. Marks the phase task done and returns a ready-made git commit
   message template. It does **not** run tests or commit for you — that's a deliberate
   separation: tests are run via `run_tests`/`/run-tests`, and the actual `git commit`
   is a manual step the human confirms (see root `AGENTS.md` commit discipline: "wait
   for input before doing anything else").

## State machine per task

```
todo ──(tw_advance_task state=inprogress)──> inprogress ──(state=done)──> done (+ task done)
```

Applies uniformly to phase tasks and subtasks — same tool, same three states.

## Golden rule tie-in

Per root `agents/AGENTS.md`: never refactor task numbering, annotation formats, or
taskwarrior filters without checking every consumer (`plan-tools`, `implement-plan`,
and the skills that call these tools) — they all assume the exact same title/annotation
conventions described above.

## See also

- `skills/engineering/create-plan/SKILL.md`, `iterate-plan/SKILL.md`,
  `implement-plan/SKILL.md` — the prose workflows these tools back.
- [Extension reference](../architecture/extensions.md#pi-planning-plan-tools--implement-plan)
  for source-line pointers.
