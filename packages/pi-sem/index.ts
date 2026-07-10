import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  buildBlameArgs,
  buildContextArgs,
  buildEntitiesArgs,
  buildEvaluationReport,
  buildGitDiffArgs,
  buildGitNameOnlyArgs,
  buildImpactArgs,
  buildLogArgs,
  buildSemDiffArgs,
  compareCoverage,
  describeSelection,
  formatEvaluationReport,
  normalizeSelection,
  parseSemJsonOutput,
  pickImpactTargets,
  resolveSemInvocation,
  SEM_INSTALL_HINT,
  summarizeSemDiffPayload,
} from './core.mjs'

function errMsg(e: unknown): string {
  if (e instanceof Error) {
    return e.message
  }
  return String(e)
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  details: Record<string, unknown>
}

type ExecResult = {
  stdout: string
  stderr: string
  code: number
}

async function writeTruncatedOutput(
  prefix: string,
  content: string,
): Promise<string> {
  const dir = join(tmpdir(), `pi-sem-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${prefix}.txt`)
  await writeFile(file, content, 'utf8')
  return file
}

async function truncateToolText(
  prefix: string,
  content: string,
): Promise<{ text: string; tempFile?: string }> {
  const truncation = truncateHead(content, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  })
  if (!truncation.truncated) return { text: truncation.content }

  const tempFile = await writeTruncatedOutput(prefix, content)
  const notice = [
    '',
    `[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
    `Full output saved to: ${tempFile}]`,
  ].join('\n')

  return {
    text: `${truncation.content}${notice}`,
    tempFile,
  }
}

function formatCommand(
  invocation: { command: string; argsPrefix: string[] },
  args: string[],
): string {
  return [invocation.command, ...invocation.argsPrefix, ...args].join(' ')
}

async function runSem(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<
  ExecResult & {
    invocation: { command: string; argsPrefix: string[]; source: string }
  }
> {
  const invocation = resolveSemInvocation(cwd)
  try {
    const result = await pi.exec(
      invocation.command,
      [...invocation.argsPrefix, ...args],
      { signal },
    )
    if (result.code !== 0) {
      const stderr = result.stderr?.trim()
      const stdout = result.stdout?.trim()
      throw new Error(
        [
          `sem command failed (exit ${result.code}).`,
          stderr || stdout || 'No output from sem.',
          '',
          SEM_INSTALL_HINT,
        ].join('\n'),
      )
    }
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      code: result.code,
      invocation,
    }
  } catch (error) {
    const message = errMsg(error)
    if (message.includes('ENOENT') || message.includes('not found')) {
      throw new Error(['sem CLI not found.', '', SEM_INSTALL_HINT].join('\n'))
    }
    throw error
  }
}

async function runGit(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ExecResult> {
  const result = await pi.exec('git', args, { signal })
  if (result.code !== 0) {
    throw new Error(
      [
        `git command failed (exit ${result.code}).`,
        result.stderr?.trim() || result.stdout?.trim() || 'No output from git.',
      ].join('\n'),
    )
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.code,
  }
}

function parseJson(toolName: string, text: string): unknown {
  try {
    return parseSemJsonOutput(toolName, text)
  } catch (error) {
    const message = errMsg(error)
    throw new Error(`${toolName} returned invalid JSON: ${message}`)
  }
}

async function formatJsonResult(
  prefix: string,
  title: string,
  bullets: string[],
  payload: unknown,
  details: Record<string, unknown>,
): Promise<ToolResult> {
  const json = JSON.stringify(payload, null, 2)
  const content = [title, ...bullets, '', json].join('\n')
  const truncated = await truncateToolText(prefix, content)
  return {
    content: [{ type: 'text', text: truncated.text }],
    details: {
      ...details,
      payload,
      truncatedToFile: truncated.tempFile,
    },
  }
}

export default function (pi: ExtensionAPI) {
  const diffSelectionSchema = {
    staged: Type.Optional(
      Type.Boolean({ description: 'Use staged changes only.' }),
    ),
    commit: Type.Optional(
      Type.String({
        description: 'Diff a specific commit (e.g. HEAD or abc1234).',
      }),
    ),
    from: Type.Optional(
      Type.String({ description: 'Start ref for a commit range.' }),
    ),
    to: Type.Optional(
      Type.String({ description: 'End ref for a commit range.' }),
    ),
    fileExts: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Optional file extensions to filter sem diff by, for example ['.ts', '.md'].",
      }),
    ),
  }

  pi.registerTool({
    name: 'sem_diff',
    label: 'sem diff',
    description:
      'Semantic git diff with entity-level change detection. Use for change summaries, reviews, commit analysis, or when you need functions/classes/properties instead of raw line hunks.',
    promptSnippet:
      'Entity-level git diff with JSON output and rename-aware changed entities.',
    promptGuidelines: [
      'Use sem_diff when the user asks what changed, asks for a review summary, or wants commit/range analysis at the function/class/entity level.',
      'Prefer sem_diff for one-shot semantic overviews and entity counts, not as a universal replacement for raw git diff or file reads.',
      'When you only need to reason about one suspicious function/class, prefer sem_context; when you need blast radius or affected tests, prefer sem_impact.',
    ],
    parameters: Type.Object(diffSelectionSchema),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const selection = normalizeSelection(params)
      onUpdate?.({
        content: [
          { type: 'text', text: `Running sem diff for ${selection.label}...` },
        ],
        details: { selection },
      })

      const args = buildSemDiffArgs(params)
      const result = await runSem(pi, ctx.cwd, args, signal)
      const payload = parseJson('sem diff', result.stdout)
      const summary = summarizeSemDiffPayload(payload)
      return formatJsonResult(
        'sem-diff',
        `sem diff (${selection.label})`,
        [
          `- files with entity changes: ${summary.summary.fileCount}`,
          `- entities changed: ${summary.summary.total} (added ${summary.summary.added}, modified ${summary.summary.modified}, deleted ${summary.summary.deleted})`,
          `- command: ${formatCommand(result.invocation, args)}`,
        ],
        payload,
        {
          selection,
          command: formatCommand(result.invocation, args),
          commandSource: result.invocation.source,
          summary,
        },
      )
    },
  })

  pi.registerTool({
    name: 'sem_impact',
    label: 'sem impact',
    description:
      'Cross-file impact analysis for an entity. Use to estimate blast radius, dependents, dependencies, or affected tests before refactors and reviews.',
    promptSnippet:
      'Entity impact analysis with dependents, dependencies, and test-focused modes.',
    promptGuidelines: [
      'Use sem_impact when the user asks what might break, what depends on a function/class, or what tests are affected by a change.',
      'Prefer sem_impact during review before speculating about blast radius; use it to prove or disprove impact on other files, entrypoints, or tests.',
    ],
    parameters: Type.Object({
      entity: Type.String({
        description: 'Entity name to analyze, such as authenticateUser.',
      }),
      file: Type.Optional(
        Type.String({
          description:
            'Optional file path to disambiguate entities with the same name.',
        }),
      ),
      scope: Type.Optional(
        StringEnum(['all', 'deps', 'dependents', 'tests'] as const, {
          description:
            'Which part of the impact graph to return. Defaults to all.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [
          { type: 'text', text: `Running sem impact for ${params.entity}...` },
        ],
        details: { entity: params.entity, scope: params.scope ?? 'all' },
      })
      const args = buildImpactArgs(params)
      const result = await runSem(pi, ctx.cwd, args, signal)
      const payload = parseJson('sem impact', result.stdout)
      return formatJsonResult(
        'sem-impact',
        `sem impact (${params.entity})`,
        [
          `- scope: ${params.scope ?? 'all'}`,
          `- file: ${params.file ?? 'auto'}`,
          `- command: ${formatCommand(result.invocation, args)}`,
        ],
        payload,
        {
          entity: params.entity,
          file: params.file,
          scope: params.scope ?? 'all',
          command: formatCommand(result.invocation, args),
          commandSource: result.invocation.source,
        },
      )
    },
  })

  pi.registerTool({
    name: 'sem_context',
    label: 'sem context',
    description:
      'Token-budgeted semantic context for an entity. Use when you need just the relevant function/class plus dependencies and dependents, instead of reading many full files.',
    promptSnippet:
      'Token-budgeted entity context including dependencies and dependents.',
    promptGuidelines: [
      'Use sem_context when focused work on a single function/class needs compact relevant context instead of loading whole files.',
      'Prefer sem_context over large read operations when the task centers on one entity and you only need its dependencies and dependents.',
    ],
    parameters: Type.Object({
      entity: Type.String({
        description: 'Entity name to retrieve context for.',
      }),
      file: Type.Optional(
        Type.String({
          description: 'Optional file path to disambiguate the entity.',
        }),
      ),
      budget: Type.Optional(
        Type.Number({
          description:
            "Approximate token budget. Defaults to sem's default (8000).",
          minimum: 1,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [
          { type: 'text', text: `Running sem context for ${params.entity}...` },
        ],
        details: { entity: params.entity, budget: params.budget ?? 8000 },
      })
      const args = buildContextArgs(params)
      const result = await runSem(pi, ctx.cwd, args, signal)
      const header = [
        `sem context (${params.entity})`,
        `- file: ${params.file ?? 'auto'}`,
        `- budget: ${params.budget ?? 8000}`,
        `- command: ${formatCommand(result.invocation, args)}`,
        '',
        result.stdout.trim(),
      ].join('\n')
      const truncated = await truncateToolText('sem-context', header)
      return {
        content: [{ type: 'text', text: truncated.text }],
        details: {
          entity: params.entity,
          file: params.file,
          budget: params.budget ?? 8000,
          command: formatCommand(result.invocation, args),
          commandSource: result.invocation.source,
          truncatedToFile: truncated.tempFile,
        },
      }
    },
  })

  pi.registerTool({
    name: 'sem_log',
    label: 'sem log',
    description:
      'Entity-level history for a function/class/method. Use for debugging regressions, tracing how logic evolved, or understanding who changed a specific entity over time.',
    promptSnippet:
      'Entity-level git history for a single function, class, or method.',
    promptGuidelines: [
      'Use sem_log when the user asks how an entity evolved or which commits touched a particular function/class.',
    ],
    parameters: Type.Object({
      entity: Type.String({
        description: 'Entity name to trace through git history.',
      }),
      file: Type.Optional(
        Type.String({
          description:
            'Optional file path to disambiguate entities with the same name.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum commits to scan. Defaults to sem's default.",
          minimum: 1,
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: 'Show verbose content diffs between entity versions.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [
          { type: 'text', text: `Running sem log for ${params.entity}...` },
        ],
        details: { entity: params.entity, limit: params.limit },
      })
      const args = buildLogArgs(params)
      const result = await runSem(pi, ctx.cwd, args, signal)
      const payload = parseJson('sem log', result.stdout)
      let verboseLabel: string
      if (params.verbose) {
        verboseLabel = 'yes'
      } else {
        verboseLabel = 'no'
      }
      return formatJsonResult(
        'sem-log',
        `sem log (${params.entity})`,
        [
          `- file: ${params.file ?? 'auto'}`,
          `- limit: ${params.limit ?? 'default'}`,
          `- verbose: ${verboseLabel}`,
          `- command: ${formatCommand(result.invocation, args)}`,
        ],
        payload,
        {
          entity: params.entity,
          file: params.file,
          limit: params.limit,
          verbose: params.verbose ?? false,
          command: formatCommand(result.invocation, args),
          commandSource: result.invocation.source,
        },
      )
    },
  })

  pi.registerTool({
    name: 'sem_entities',
    label: 'sem entities',
    description:
      'List entities in a file with semantic types and ranges. Use to inventory a file before editing or to understand its structure quickly.',
    promptSnippet:
      'Entity inventory for a file: functions, classes, methods, properties, sections, and ranges.',
    promptGuidelines: [
      'Use sem_entities when you need a structural inventory of a file before drilling into specific entities.',
    ],
    parameters: Type.Object({
      file: Type.String({ description: 'File path to inspect.' }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [
          { type: 'text', text: `Running sem entities for ${params.file}...` },
        ],
        details: { file: params.file },
      })
      const args = buildEntitiesArgs(params)
      const result = await runSem(pi, ctx.cwd, args, signal)
      const payload = parseJson('sem entities', result.stdout)
      return formatJsonResult(
        'sem-entities',
        `sem entities (${params.file})`,
        [`- command: ${formatCommand(result.invocation, args)}`],
        payload,
        {
          file: params.file,
          command: formatCommand(result.invocation, args),
          commandSource: result.invocation.source,
        },
      )
    },
  })

  pi.registerTool({
    name: 'sem_blame',
    label: 'sem blame',
    description:
      'Entity-level blame for a file. Use to see who last touched each function/class/method instead of only line-based blame.',
    promptSnippet:
      'Entity-level blame for functions, classes, methods, and similar semantic units in a file.',
    promptGuidelines: [
      'Use sem_blame when the user asks who last changed a function/class or which commit most recently touched entities in a file.',
    ],
    parameters: Type.Object({
      file: Type.String({ description: 'File path to analyze.' }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [
          { type: 'text', text: `Running sem blame for ${params.file}...` },
        ],
        details: { file: params.file },
      })
      const args = buildBlameArgs(params)
      const result = await runSem(pi, ctx.cwd, args, signal)
      const payload = parseJson('sem blame', result.stdout)
      return formatJsonResult(
        'sem-blame',
        `sem blame (${params.file})`,
        [`- command: ${formatCommand(result.invocation, args)}`],
        payload,
        {
          file: params.file,
          command: formatCommand(result.invocation, args),
          commandSource: result.invocation.source,
        },
      )
    },
  })

  pi.registerTool({
    name: 'sem_eval',
    label: 'sem eval',
    description:
      'Evaluate semantic diff coverage and prompt-size impact versus raw git diff for the current repo, a commit, or a range. Use when you want to benchmark how much sem helps in practice.',
    promptSnippet:
      'Compare sem diff coverage and token footprint against raw git diff for the same selection.',
    promptGuidelines: [
      'Use sem_eval when the user asks whether sem helps, wants a benchmark, or asks for measurable impact compared with raw git diff.',
    ],
    parameters: Type.Object({
      ...diffSelectionSchema,
      includeImpact: Type.Optional(
        Type.Boolean({
          description: 'Also sample sem impact on a few changed entities.',
        }),
      ),
      impactLimit: Type.Optional(
        Type.Number({
          description:
            'How many changed entities to sample for impact analysis. Defaults to 3.',
          minimum: 1,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const selection = normalizeSelection(params)
      const includeImpact = params.includeImpact !== false
      const impactLimit = Math.max(1, Math.floor(params.impactLimit ?? 3))

      onUpdate?.({
        content: [
          {
            type: 'text',
            text: `Evaluating sem vs git diff for ${selection.label}...`,
          },
        ],
        details: { selection, includeImpact, impactLimit },
      })

      const semArgs = buildSemDiffArgs(params)
      const gitDiffArgs = buildGitDiffArgs(params)
      const gitNameArgs = buildGitNameOnlyArgs(params)

      const [semResult, gitDiffResult, gitNamesResult] = await Promise.all([
        runSem(pi, ctx.cwd, semArgs, signal),
        runGit(pi, ctx.cwd, gitDiffArgs, signal),
        runGit(pi, ctx.cwd, gitNameArgs, signal),
      ])

      const semPayload = parseJson('sem diff', semResult.stdout)
      const semSummary = summarizeSemDiffPayload(semPayload)
      const gitFiles = gitNamesResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      let impactTargets: ReturnType<typeof pickImpactTargets> = []
      if (includeImpact) {
        impactTargets = pickImpactTargets(semPayload, impactLimit)
      }
      const impactResults: Array<{
        entity: string
        file: string
        result: unknown
      }> = []
      for (const target of impactTargets) {
        const impactArgs = buildImpactArgs({
          entity: target.entity,
          file: target.file,
          scope: 'tests',
        })
        try {
          const impactResult = await runSem(pi, ctx.cwd, impactArgs, signal)
          impactResults.push({
            entity: target.entity,
            file: target.file,
            result: parseJson('sem impact', impactResult.stdout),
          })
        } catch (error) {
          impactResults.push({
            entity: target.entity,
            file: target.file,
            result: {
              error: errMsg(error),
            },
          })
        }
      }

      const report = buildEvaluationReport({
        selection,
        gitDiffText: gitDiffResult.stdout,
        gitFiles,
        semDiffText: semResult.stdout,
        semDiffJson: semPayload,
        impactResults,
      })
      const coverage = compareCoverage(gitFiles, semSummary.changedFiles)
      const reportText = formatEvaluationReport(report)
      const truncated = await truncateToolText('sem-eval', reportText)
      return {
        content: [{ type: 'text', text: truncated.text }],
        details: {
          selection,
          includeImpact,
          impactLimit,
          report,
          coverage,
          semSummary,
          commands: {
            sem: formatCommand(semResult.invocation, semArgs),
            gitDiff: ['git', ...gitDiffArgs].join(' '),
            gitNames: ['git', ...gitNameArgs].join(' '),
          },
          truncatedToFile: truncated.tempFile,
        },
      }
    },
  })
}
