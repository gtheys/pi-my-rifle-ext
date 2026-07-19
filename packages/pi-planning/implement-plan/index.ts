/**
 * Implement Plan Extension
 *
 * Provides typed taskwarrior tools for the implement-plan skill.
 * Replaces bash/jq pipelines with validated, structured tool calls.
 *
 * Tools:
 *   tw_execution_plan     - full sorted task tree for a Jira ID (phases + subtasks + work_state)
 *   tw_advance_task       - transition a task: todo → inprogress → done
 *   tw_phase_checkpoint   - mark phase done in TW + return commit message template
 *
 * Command:
 *   /implement <JIRA_ID>  - show execution plan and route to implement-plan skill
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { type TwTask, twExport } from '../shared/tw-utils.ts'

// AIDEV-NOTE: All taskwarrior commands use rc.confirmation:no to avoid interactive prompts.

// ── Types ─────────────────────────────────────────────────────────────────────

interface Subtask {
  uuid: string
  number: string // e.g. "2.3"
  name: string
  work_state: string
}

interface Phase {
  uuid: string
  number: number
  name: string
  work_state: string
  subtasks: Subtask[]
}

interface ExecutionPlan {
  jiraId: string
  phases: Phase[]
  currentPhase: Phase | null
  currentSubtask: Subtask | null
  totalSubtasks: number
  doneSubtasks: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePhaseNumber(description: string): number | null {
  const m = description.match(/^(\d+)\.\s*Phase:/i)
  const n = m?.[1]
  return n ? parseInt(n, 10) : null
}

function parseSubtaskNumber(description: string): string | null {
  const m = description.match(/^(\d+\.\d+)/)
  return m?.[1] ?? null
}

function parseSubtaskName(description: string): string {
  // Strip leading "N.M " prefix
  return description.replace(/^\d+\.\d+\s+/, '').trim()
}

function parsePhaseName(description: string): string {
  // Strip leading "N. Phase: " prefix
  return description.replace(/^\d+\.\s*Phase:\s*/i, '').trim()
}

function sortByPrefix(
  tasks: TwTask[],
  getKey: (t: TwTask) => number | null,
): TwTask[] {
  return [...tasks].sort((a, b) => {
    const ka = getKey(a) ?? 999
    const kb = getKey(b) ?? 999
    return ka - kb
  })
}

function sortSubtasks(tasks: TwTask[]): TwTask[] {
  return [...tasks].sort((a, b) => {
    const na = parseSubtaskNumber(a.description)
    const nb = parseSubtaskNumber(b.description)
    if (!na || !nb) return 0
    const [, am] = na.split('.').map(Number) as [number, number]
    const [, bm] = nb.split('.').map(Number) as [number, number]
    return am - bm
  })
}

function firstNonDone<T extends { work_state: string }>(items: T[]): T | null {
  return items.find((i) => i.work_state !== 'done') ?? null
}

// AIDEV-NOTE: Builds a full execution plan from raw TW tasks.
// Phases sorted by N. prefix, subtasks sorted by N.M prefix.
// currentPhase/currentSubtask point to the first non-done item — resume target.
function buildExecutionPlan(jiraId: string, allTasks: TwTask[]): ExecutionPlan {
  const phaseTasks = allTasks.filter(
    (t) => (t.tags ?? []).includes('phase') && (t.tags ?? []).includes('impl'),
  )
  const implOnlyTasks = allTasks.filter(
    (t) => (t.tags ?? []).includes('impl') && !(t.tags ?? []).includes('phase'),
  )

  const sortedPhases = sortByPrefix(phaseTasks, (t) =>
    parsePhaseNumber(t.description),
  )

  const phases: Phase[] = sortedPhases.map((pt) => {
    const subtaskRaw = implOnlyTasks.filter((t) =>
      (t.depends ?? []).includes(pt.uuid),
    )
    const sorted = sortSubtasks(subtaskRaw)
    const subtasks: Subtask[] = sorted.map((st) => ({
      uuid: st.uuid,
      number: parseSubtaskNumber(st.description) ?? st.description,
      name: parseSubtaskName(st.description),
      work_state: st.work_state ?? 'todo',
    }))

    return {
      uuid: pt.uuid,
      number: parsePhaseNumber(pt.description) ?? 0,
      name: parsePhaseName(pt.description),
      work_state: pt.work_state ?? 'todo',
      subtasks,
    }
  })

  const totalSubtasks = phases.reduce((n, p) => n + p.subtasks.length, 0)
  const doneSubtasks = phases.reduce(
    (n, p) => n + p.subtasks.filter((s) => s.work_state === 'done').length,
    0,
  )

  // Resume target: first non-done phase, then first non-done subtask within it
  const currentPhase = firstNonDone(phases)
  let currentSubtask: Subtask | null = null
  if (currentPhase) {
    currentSubtask = firstNonDone(currentPhase.subtasks)
  }

  return {
    jiraId,
    phases,
    currentPhase,
    currentSubtask,
    totalSubtasks,
    doneSubtasks,
  }
}

function planSummary(plan: ExecutionPlan): string {
  const lines: string[] = [`Execution plan for ${plan.jiraId}:`]
  lines.push(
    `Progress: ${plan.doneSubtasks}/${plan.totalSubtasks} subtasks done`,
  )
  lines.push('')

  for (const phase of plan.phases) {
    const doneSubs = phase.subtasks.filter(
      (s) => s.work_state === 'done',
    ).length
    let icon: string
    if (phase.work_state === 'done') {
      icon = '✓'
    } else if (phase.work_state === 'inprogress') {
      icon = '▶'
    } else {
      icon = '○'
    }
    lines.push(
      `  ${icon} Phase ${phase.number}: ${phase.name} [${phase.work_state}] (${doneSubs}/${phase.subtasks.length})`,
    )
    for (const sub of phase.subtasks) {
      let sicon: string
      if (sub.work_state === 'done') {
        sicon = '  ✓'
      } else if (sub.work_state === 'inprogress') {
        sicon = '  ▶'
      } else {
        sicon = '  ○'
      }
      lines.push(`    ${sicon} ${sub.number} ${sub.name} [${sub.work_state}]`)
    }
  }

  if (plan.currentPhase) {
    lines.push('')
    if (plan.currentSubtask) {
      lines.push(
        `▶ Resume at: Phase ${plan.currentPhase.number} — subtask ${plan.currentSubtask.number} ${plan.currentSubtask.name}`,
      )
    } else {
      lines.push(
        `▶ Resume at: Phase ${plan.currentPhase.number} (all subtasks done, phase not closed)`,
      )
    }
  } else {
    lines.push('')
    lines.push('✓ All phases complete.')
  }

  return lines.join('\n')
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── tw_execution_plan ──────────────────────────────────────────────────────

  pi.registerTool({
    name: 'tw_execution_plan',
    label: 'TW: Execution Plan',
    description: [
      'Fetch the full sorted implementation task tree for a Jira ID.',
      'Returns phases (sorted by N. prefix) each with their subtasks (sorted by N.M prefix),',
      'work_state for every item, and currentPhase/currentSubtask pointing to the first',
      'non-done item — the resume target. Use this at the start of any implement-plan session.',
    ].join(' '),
    promptSnippet: 'Fetch full sorted implementation task tree for a Jira ID',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID, e.g. DP-121' }),
    }),
    async execute(_id, params) {
      const all = await twExport(pi, [`jiraid:${params.jira_id}`, '+impl'])
      if (all.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No impl tasks found for ${params.jira_id}. Run bugwarrior-pull or check the Jira ID.`,
            },
          ],
          details: {
            found: false,
            plan: undefined as ExecutionPlan | undefined,
          },
        }
      }

      const plan = buildExecutionPlan(params.jira_id, all)
      const summary = planSummary(plan)

      return {
        content: [{ type: 'text', text: summary }],
        details: { found: true, plan },
      }
    },
  })

  // ── tw_advance_task ────────────────────────────────────────────────────────

  // AIDEV-NOTE: Single entry point for all task state transitions.
  // When state=done: calls both `modify work_state:done` AND `task done`
  // so the task is closed in taskwarrior (status:completed).
  pi.registerTool({
    name: 'tw_advance_task',
    label: 'TW: Advance Task',
    description: [
      'Transition a taskwarrior task to a new work_state.',
      'Valid states: todo, inprogress, done.',
      'When state=done: also calls `task done` to close the task (status:completed).',
      'Use for both phase tasks and subtasks.',
    ].join(' '),
    promptSnippet: 'Transition a task to todo/inprogress/done',
    parameters: Type.Object({
      uuid: Type.String({ description: 'Task UUID' }),
      state: Type.Union(
        [
          Type.Literal('todo'),
          Type.Literal('inprogress'),
          Type.Literal('done'),
        ],
        { description: 'Target work_state' },
      ),
      description: Type.Optional(
        Type.String({
          description: 'Task description (for confirmation output only)',
        }),
      ),
    }),
    async execute(_id, params) {
      await pi.exec(
        'task',
        [
          params.uuid,
          'modify',
          `work_state:${params.state}`,
          'rc.confirmation:no',
        ],
        {},
      )

      if (params.state === 'done') {
        await pi.exec('task', [params.uuid, 'done', 'rc.confirmation:no'], {})
      }

      let label: string
      if (params.description) {
        label = `"${params.description}"`
      } else {
        label = params.uuid
      }
      return {
        content: [{ type: 'text', text: `Task ${label} → ${params.state}` }],
        details: { uuid: params.uuid, state: params.state },
      }
    },
  })

  // ── tw_phase_checkpoint ────────────────────────────────────────────────────

  // AIDEV-NOTE: Marks phase done in TW and returns a conventional commit message.
  // Does NOT run tests or commit — caller (skill) runs run_tests first, then
  // calls this, then presents the commit message to the user for confirmation.
  pi.registerTool({
    name: 'tw_phase_checkpoint',
    label: 'TW: Phase Checkpoint',
    description: [
      'Mark a phase task as done in taskwarrior and return a ready-made git commit message.',
      'Call this AFTER tests pass and AFTER user confirms the phase is complete.',
      'Does not run tests or commit — use run_tests before calling this.',
      'Returns commitMessage in details for the user to confirm before committing.',
    ].join(' '),
    promptSnippet: 'Mark phase done in TW and return git commit message',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID, e.g. DP-121' }),
      phase_uuid: Type.String({ description: 'UUID of the phase task' }),
      phase_number: Type.Number({ description: 'Phase number, e.g. 2' }),
      phase_name: Type.String({
        description: "Phase name, e.g. 'Database Schema'",
      }),
    }),
    async execute(_id, params) {
      await pi.exec(
        'task',
        [params.phase_uuid, 'modify', 'work_state:done', 'rc.confirmation:no'],
        {},
      )
      await pi.exec(
        'task',
        [params.phase_uuid, 'done', 'rc.confirmation:no'],
        {},
      )

      const commitMessage = `feat(${params.jira_id}): Phase ${params.phase_number} - ${params.phase_name}`

      return {
        content: [
          {
            type: 'text',
            text: [
              `Phase ${params.phase_number} "${params.phase_name}" marked done.`,
              ``,
              `Suggested commit message:`,
              `  ${commitMessage}`,
              ``,
              `Run: git add -u && git commit -m "${commitMessage}"`,
            ].join('\n'),
          },
        ],
        details: { uuid: params.phase_uuid, commitMessage },
      }
    },
  })

  // ── /implement command ─────────────────────────────────────────────────────

  // AIDEV-NOTE: Entry point for implement-plan skill.
  // Fetches + displays execution plan first so the user sees what's pending
  // before the skill starts executing. Routes to implement-plan skill.
  pi.registerCommand('implement', {
    description: 'Show execution plan and start implementing a Jira ticket',
    handler: async (args, ctx) => {
      const jiraId = args.trim().toUpperCase()
      if (!jiraId) {
        ctx.ui.notify(
          'Usage: /implement <JIRA_ID>  e.g. /implement DP-121',
          'warning',
        )
        return
      }

      ctx.ui.notify(`Fetching execution plan for ${jiraId}...`, 'info')

      // AIDEV-NOTE: Check issue type BEFORE evaluating impl tasks.
      // Bugs don't have spec/phase tasks — skip the "no impl tasks" guard for them.
      let isBug = false
      try {
        const ticketData = await twExport(pi, [`jiraid:${jiraId}`])
        const ticket = ticketData[0]
        if (ticket) {
          const issueType =
            (ticket as TwTask & { jiraissuetype?: string }).jiraissuetype ?? ''
          const tags = ticket.tags ?? []
          isBug = issueType === 'Bug' || tags.includes('bug')
        }
      } catch {
        // ignore — skill will handle it
      }

      let summary = ''
      try {
        const all = await twExport(pi, [`jiraid:${jiraId}`, '+impl'])
        if (all.length > 0) {
          const plan = buildExecutionPlan(jiraId, all)
          summary = `\n\n${planSummary(plan)}`
        } else if (!isBug) {
          ctx.ui.notify(
            `No impl tasks found for ${jiraId}. Has the plan been created? Try /plan ${jiraId}.`,
            'warning',
          )
          return
        }
      } catch (e) {
        ctx.ui.notify(`Could not fetch plan: ${e}`, 'warning')
        // Continue anyway — skill will handle it
      }

      pi.sendUserMessage(`/skill:implement-plan ${jiraId}${summary}`)
    },
  })
}
