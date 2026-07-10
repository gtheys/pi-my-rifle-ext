/**
 * Plan Tools Extension
 *
 * Provides typed taskwarrior tools for the create-plan and iterate-plan skills,
 * replacing raw bash command construction with validated, reusable tool calls.
 *
 * Tools:
 *   tw_get_ticket         - fetch Jira ticket from taskwarrior
 *   tw_get_spec_task      - fetch spec task + extract spec file path from annotation
 *   tw_get_phases         - fetch phase tasks
 *   tw_get_impl_tasks     - fetch implementation tasks
 *   resolve_spec_path     - compute canonical spec file path
 *   tw_create_spec_task   - create spec task with annotation
 *   tw_create_phase       - create phase task, returns UUID
 *   tw_create_impl_task   - create impl task with depends:
 *
 * Command:
 *   /plan <JIRA_ID>  - smart routing: iterate if spec file exists, create otherwise
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { twExport } from '../shared/tw-utils.ts'

// AIDEV-NOTE: All taskwarrior commands use rc.confirmation:no to avoid interactive prompts.

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getRepoName(pi: ExtensionAPI): Promise<string> {
  // ponytail: git rev-parse --show-toplevel always works in a repo; remote URL is optional
  try {
    const r = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
    if (r.stdout.trim()) return r.stdout.trim().split('/').pop() ?? 'unknown'
  } catch {}
  return 'unknown'
}

async function resolveSpecPath(
  pi: ExtensionAPI,
  jiraId: string,
  summary: string,
): Promise<string> {
  const repoName = await getRepoName(pi)
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')

  const notesRoot = process.env['LLM_NOTES_ROOT']
  let specDir: string
  if (notesRoot) {
    specDir = join(notesRoot, repoName, 'notes', 'specs')
  } else {
    const r = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
    specDir = join(r.stdout.trim(), 'notes', 'specs')
  }

  return join(specDir, `${jiraId}__${slug}.md`)
}

// AIDEV-NOTE: Annotation format is "Spec(repo=<repo>): <relative-path>"
function extractSpecPath(task: any): string | null {
  const annotations: any[] = task.annotations ?? []
  for (const ann of annotations) {
    const match = (ann.description ?? '').match(/Spec\(repo=[^)]+\):\s*(.+)/)
    if (match) return (match[1] as string).trim()
  }
  return null
}

async function getTaskUuid(pi: ExtensionAPI, taskId: string): Promise<string> {
  const r = await pi.exec('task', [taskId, '_get', 'uuid'], {})
  return r.stdout.trim()
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Read tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'tw_get_ticket',
    label: 'TW: Get Ticket',
    description:
      'Fetch Jira ticket details from taskwarrior by Jira ID. Returns parsed task fields: description, jiradescription, jirasummary, jirastatus, jiraurl, jiraissuetype, jiraparent, tags, project.',
    promptSnippet: 'Fetch Jira ticket details from taskwarrior',
    parameters: Type.Object({
      jira_id: Type.String({
        description: 'Jira ticket ID, e.g. IMP-7070 or DP-92',
      }),
    }),
    async execute(_id, params) {
      const tasks = await twExport(pi, [`jiraid:${params.jira_id}`, '+jira'])
      if (tasks.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No taskwarrior task found for "${params.jira_id}". Run \`bugwarrior pull\` to sync, or provide ticket details manually.`,
            },
          ],
          details: { found: false },
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(tasks[0], null, 2) }],
        details: { found: true, task: tasks[0] },
      }
    },
  })

  pi.registerTool({
    name: 'tw_get_spec_task',
    label: 'TW: Get Spec Task',
    description:
      'Fetch the spec task for a Jira ticket. Returns the task and extracts the spec file path from its annotation (pattern: Spec(repo=<repo>): <path>). specPath is null if no annotation found.',
    promptSnippet: 'Fetch spec task and spec file path for a Jira ticket',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID' }),
    }),
    async execute(_id, params) {
      const tasks = await twExport(pi, [`jiraid:${params.jira_id}`, '+spec'])
      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text', text: `No spec task found for ${params.jira_id}.` },
          ],
          details: { found: false, specPath: null as string | null },
        }
      }
      const task = tasks[0]
      const specPath = extractSpecPath(task)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ task, specPath }, null, 2) },
        ],
        details: { found: true, task, specPath },
      }
    },
  })

  pi.registerTool({
    name: 'tw_get_phases',
    label: 'TW: Get Phases',
    description:
      'Fetch all phase tasks (+phase tag) for a Jira ticket from taskwarrior.',
    promptSnippet: 'Fetch phase tasks for a Jira ticket',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID' }),
    }),
    async execute(_id, params) {
      const tasks = await twExport(pi, [`jiraid:${params.jira_id}`, '+phase'])
      return {
        content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }],
        details: { count: tasks.length, tasks },
      }
    },
  })

  pi.registerTool({
    name: 'tw_get_impl_tasks',
    label: 'TW: Get Impl Tasks',
    description:
      'Fetch all implementation tasks (+impl tag) for a Jira ticket from taskwarrior.',
    promptSnippet: 'Fetch implementation tasks for a Jira ticket',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID' }),
    }),
    async execute(_id, params) {
      const tasks = await twExport(pi, [`jiraid:${params.jira_id}`, '+impl'])
      return {
        content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }],
        details: { count: tasks.length, tasks },
      }
    },
  })

  pi.registerTool({
    name: 'resolve_spec_path',
    label: 'Resolve Spec Path',
    description:
      'Compute the canonical spec file path for a Jira ticket. Resolves repo name from git remote, applies $LLM_NOTES_ROOT if set, generates a slug from the summary (max 5 words, lowercase, dashes). Returns the full absolute path.',
    promptSnippet: 'Compute the canonical spec file path for a Jira ticket',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID, e.g. IMP-7070' }),
      summary: Type.String({
        description: 'Jira summary/title used to generate the slug',
      }),
    }),
    async execute(_id, params) {
      const specPath = await resolveSpecPath(pi, params.jira_id, params.summary)
      return {
        content: [{ type: 'text', text: specPath }],
        details: { specPath },
      }
    },
  })

  // ── Write tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'tw_create_spec_task',
    label: 'TW: Create Spec Task',
    description:
      'Create a spec task in taskwarrior and annotate it with the spec file path. Sets work_state:approved and +spec tag. Project is prefixed with SalaryHero automatically. Returns the task UUID.',
    promptSnippet:
      'Create a spec task in taskwarrior with spec file annotation',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID' }),
      summary: Type.String({ description: 'Jira summary/title' }),
      project: Type.String({
        description:
          "Project suffix, e.g. 'backend'. Will be stored as SalaryHero.<project>.",
      }),
      repo: Type.String({
        description: 'Repository name for the spec annotation',
      }),
      spec_path: Type.String({
        description:
          'Relative spec file path, e.g. notes/specs/IMP-7070__slug.md',
      }),
    }),
    async execute(_id, params) {
      const addResult = await pi.exec(
        'task',
        [
          'add',
          `SPEC: ${params.jira_id} ${params.summary}`,
          `project:SalaryHero.${params.project}`,
          `jiraid:${params.jira_id}`,
          'work_state:approved',
          '+spec',
          'rc.confirmation:no',
        ],
        {},
      )

      const match = addResult.stdout.match(/Created task (\d+)/)
      if (!match)
        throw new Error(
          `Failed to create spec task: ${addResult.stdout} ${addResult.stderr}`,
        )

      const uuid = await getTaskUuid(pi, match[1]!)
      await pi.exec(
        'task',
        [
          uuid,
          'annotate',
          `Spec(repo=${params.repo}): ${params.spec_path}`,
          'rc.confirmation:no',
        ],
        {},
      )

      return {
        content: [
          {
            type: 'text',
            text: `Created spec task (UUID: ${uuid})\nAnnotated: Spec(repo=${params.repo}): ${params.spec_path}`,
          },
        ],
        details: { uuid },
      }
    },
  })

  pi.registerTool({
    name: 'tw_create_phase',
    label: 'TW: Create Phase',
    description:
      'Create a phase task in taskwarrior. Sets work_state:todo and +impl +phase tags. Returns the task UUID — pass this as depends_uuid to tw_create_impl_task.',
    promptSnippet:
      'Create a phase task in taskwarrior, returns UUID for depends',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID' }),
      phase_number: Type.Number({ description: 'Phase number, e.g. 1, 2, 3' }),
      phase_name: Type.String({
        description: "Phase name, e.g. 'Database Schema'",
      }),
      project: Type.String({
        description: 'Project suffix. Will be stored as SalaryHero.<project>.',
      }),
      repo: Type.String({ description: 'Repository name' }),
    }),
    async execute(_id, params) {
      const addResult = await pi.exec(
        'task',
        [
          'add',
          `${params.phase_number}. Phase: ${params.phase_name}`,
          `project:SalaryHero.${params.project}`,
          `jiraid:${params.jira_id}`,
          `repository:${params.repo}`,
          'work_state:todo',
          '+impl',
          '+phase',
          'rc.confirmation:no',
        ],
        {},
      )

      const match = addResult.stdout.match(/Created task (\d+)/)
      if (!match)
        throw new Error(
          `Failed to create phase task: ${addResult.stdout} ${addResult.stderr}`,
        )

      const uuid = await getTaskUuid(pi, match[1]!)

      return {
        content: [
          {
            type: 'text',
            text: `Created phase "${params.phase_number}. Phase: ${params.phase_name}" (UUID: ${uuid})`,
          },
        ],
        details: { uuid },
      }
    },
  })

  pi.registerTool({
    name: 'tw_create_impl_task',
    label: 'TW: Create Impl Task',
    description:
      'Create an implementation task in taskwarrior under a phase. Sets work_state:todo and +impl tag. Use the UUID from tw_create_phase as depends_uuid.',
    promptSnippet: 'Create an implementation task under a phase in taskwarrior',
    parameters: Type.Object({
      jira_id: Type.String({ description: 'Jira ticket ID' }),
      title: Type.String({
        description: "Task title, e.g. '1.1 Add migration for users table'",
      }),
      project: Type.String({
        description: 'Project suffix. Will be stored as SalaryHero.<project>.',
      }),
      repo: Type.String({ description: 'Repository name' }),
      depends_uuid: Type.String({
        description: 'UUID of the parent phase task from tw_create_phase',
      }),
    }),
    async execute(_id, params) {
      const addResult = await pi.exec(
        'task',
        [
          'add',
          params.title,
          `project:SalaryHero.${params.project}`,
          `jiraid:${params.jira_id}`,
          `repository:${params.repo}`,
          'work_state:todo',
          '+impl',
          `depends:${params.depends_uuid}`,
          'rc.confirmation:no',
        ],
        {},
      )

      const match = addResult.stdout.match(/Created task (\d+)/)
      if (!match)
        throw new Error(
          `Failed to create impl task: ${addResult.stdout} ${addResult.stderr}`,
        )

      const uuid = await getTaskUuid(pi, match[1]!)

      return {
        content: [
          {
            type: 'text',
            text: `Created impl task "${params.title}" (UUID: ${uuid})`,
          },
        ],
        details: { uuid },
      }
    },
  })

  // ── Command ────────────────────────────────────────────────────────────────

  // AIDEV-NOTE: Smart routing — checks for existing spec file to decide
  // between create-plan and iterate-plan flows.
  pi.registerCommand('plan', {
    description:
      'Create or iterate on an implementation plan for a Jira ticket',
    handler: async (args, ctx) => {
      const jiraId = args.trim().toUpperCase()
      if (!jiraId) {
        ctx.ui.notify('Usage: /plan <JIRA_ID>  e.g. /plan IMP-7070', 'warning')
        return
      }

      ctx.ui.notify(`Checking spec for ${jiraId}...`, 'info')

      let hasSpecFile = false
      try {
        const tasks = await twExport(pi, [`jiraid:${jiraId}`, '+spec'])
        if (tasks.length > 0) {
          const specRelPath = extractSpecPath(tasks[0])
          if (specRelPath) {
            const notesRoot = process.env['LLM_NOTES_ROOT']
            let fullPath: string
            if (notesRoot) {
              const repoName = await getRepoName(pi)
              fullPath = join(notesRoot, repoName, specRelPath)
            } else {
              const r = await pi.exec(
                'git',
                ['rev-parse', '--show-toplevel'],
                {},
              )
              fullPath = join(r.stdout.trim(), specRelPath)
            }
            hasSpecFile = existsSync(fullPath)
          }
        }
      } catch {
        // Default to create flow on any error
      }

      if (hasSpecFile) {
        ctx.ui.notify(`Spec exists → iterate-plan`, 'info')
        pi.sendUserMessage(`/skill:iterate-plan ${jiraId}`)
      } else {
        ctx.ui.notify(`No spec → create-plan`, 'info')
        pi.sendUserMessage(`/skill:create-plan ${jiraId}`)
      }
    },
  })
}
