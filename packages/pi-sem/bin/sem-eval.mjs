#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  buildEvaluationReport,
  buildGitDiffArgs,
  buildGitNameOnlyArgs,
  buildImpactArgs,
  buildSemDiffArgs,
  formatEvaluationReport,
  normalizeSelection,
  parseSemJsonOutput,
  pickImpactTargets,
  resolveSemInvocation,
  SEM_INSTALL_HINT,
} from '../core.mjs'

function printHelp() {
  process.stdout.write(
    [
      'Usage: sem-eval [options]',
      '',
      'Compare sem diff with raw git diff for the same selection.',
      '',
      'Options:',
      '  --staged                 Evaluate staged changes',
      '  --commit <sha>           Evaluate a specific commit',
      '  --from <ref> --to <ref>  Evaluate a commit range',
      '  --file-ext <ext>         Filter diff by extension (repeatable)',
      '  --no-impact              Skip sem impact samples',
      '  --impact-limit <n>       Number of entities for impact samples (default: 3)',
      '  --format <markdown|json> Output format (default: markdown)',
      '  --help                   Show this help',
    ].join('\n') + '\n',
  )
}

function parseArgs(argv) {
  const options = {
    staged: false,
    commit: undefined,
    from: undefined,
    to: undefined,
    fileExts: [],
    includeImpact: true,
    impactLimit: 3,
    format: 'markdown',
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--staged') {
      options.staged = true
      continue
    }
    if (arg === '--commit') {
      options.commit = argv[++i]
      continue
    }
    if (arg === '--from') {
      options.from = argv[++i]
      continue
    }
    if (arg === '--to') {
      options.to = argv[++i]
      continue
    }
    if (arg === '--file-ext') {
      options.fileExts.push(argv[++i])
      continue
    }
    if (arg === '--no-impact') {
      options.includeImpact = false
      continue
    }
    if (arg === '--impact-limit') {
      options.impactLimit = Number(argv[++i])
      continue
    }
    if (arg === '--format') {
      options.format = argv[++i] ?? 'markdown'
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error) {
    const message = result.error.message || String(result.error)
    if (message.includes('ENOENT') || message.includes('not found')) {
      throw new Error(
        ['Required command not found.', '', SEM_INSTALL_HINT].join('\n'),
      )
    }
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed (exit ${result.status}).`,
        result.stderr?.trim() || result.stdout?.trim() || 'No output.',
      ].join('\n'),
    )
  }

  return result.stdout ?? ''
}

try {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    process.exit(0)
  }

  const selection = normalizeSelection(options)
  const semInvocation = resolveSemInvocation(process.cwd())
  const semArgs = buildSemDiffArgs(options)
  const gitDiffArgs = buildGitDiffArgs(options)
  const gitNameArgs = buildGitNameOnlyArgs(options)

  const semText = run(semInvocation.command, [
    ...semInvocation.argsPrefix,
    ...semArgs,
  ])
  const semJson = parseSemJsonOutput('sem_eval', semText)
  const gitDiffText = run('git', gitDiffArgs)
  const gitNamesText = run('git', gitNameArgs)
  const gitFiles = gitNamesText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const impactResults = []
  if (options.includeImpact) {
    const targets = pickImpactTargets(
      semJson,
      Math.max(1, Math.floor(options.impactLimit || 3)),
    )
    for (const target of targets) {
      const impactArgs = buildImpactArgs({
        entity: target.entity,
        file: target.file,
        scope: 'tests',
      })
      try {
        const impactText = run(semInvocation.command, [
          ...semInvocation.argsPrefix,
          ...impactArgs,
        ])
        impactResults.push({
          entity: target.entity,
          file: target.file,
          result: parseSemJsonOutput('sem impact', impactText),
        })
      } catch (error) {
        impactResults.push({
          entity: target.entity,
          file: target.file,
          result: {
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  }

  const report = buildEvaluationReport({
    selection,
    gitDiffText,
    gitFiles,
    semDiffText: semText,
    semDiffJson: semJson,
    impactResults,
  })

  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatEvaluationReport(report)}\n`)
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
