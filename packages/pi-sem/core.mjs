import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const THIS_DIR = dirname(fileURLToPath(import.meta.url))

export const SEM_INSTALL_HINT = [
  'Install sem via one of these options:',
  '- npm install @ataraxy-labs/sem',
  '- brew install sem-cli',
  '- cargo install --git https://github.com/Ataraxy-Labs/sem sem-cli',
].join('\n')

const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

function cleanString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeExtensions(fileExts) {
  if (!Array.isArray(fileExts)) return []
  const seen = new Set()
  const normalized = []
  for (const value of fileExts) {
    const cleaned = cleanString(value)
    if (!cleaned) continue
    const ext = cleaned.startsWith('.') ? cleaned : `.${cleaned}`
    if (seen.has(ext)) continue
    seen.add(ext)
    normalized.push(ext)
  }
  return normalized
}

function baseSelection(selection = {}) {
  return {
    staged: selection.staged === true,
    commit: cleanString(selection.commit),
    from: cleanString(selection.from),
    to: cleanString(selection.to),
    fileExts: normalizeExtensions(selection.fileExts),
  }
}

export function normalizeSelection(selection = {}) {
  const normalized = baseSelection(selection)
  return {
    ...normalized,
    label: describeSelection(normalized),
  }
}

export function describeSelection(selection = {}) {
  const normalized = baseSelection(selection)
  if (normalized.staged) return 'staged changes'
  if (normalized.commit) return `commit ${normalized.commit}`
  if (normalized.from || normalized.to) {
    const from = normalized.from ?? '<missing-from>'
    const to = normalized.to ?? '<missing-to>'
    return `range ${from}..${to}`
  }
  return 'working tree changes'
}

export function validateDiffSelection(selection = {}) {
  const normalized = baseSelection(selection)
  const modes = [
    normalized.staged ? 'staged' : null,
    normalized.commit ? 'commit' : null,
    normalized.from || normalized.to ? 'range' : null,
  ].filter(Boolean)

  if (modes.length > 1) {
    return {
      ok: false,
      error: 'Use only one diff selector: staged, commit, or from/to range.',
      normalized,
    }
  }

  if (
    (normalized.from && !normalized.to) ||
    (!normalized.from && normalized.to)
  ) {
    return {
      ok: false,
      error: 'Range comparisons require both from and to refs.',
      normalized,
    }
  }

  return { ok: true, normalized }
}

export function gitPathspecsFromExtensions(fileExts = []) {
  const normalized = normalizeExtensions(fileExts)
  if (normalized.length === 0) return []
  return ['--', ...normalized.map((ext) => `:(glob)**/*${ext}`)]
}

export function buildSemDiffArgs(selection = {}) {
  const validation = validateDiffSelection(selection)
  if (!validation.ok) throw new Error(validation.error)
  const { normalized } = validation
  const args = ['diff']
  if (normalized.staged) args.push('--staged')
  if (normalized.commit) args.push('--commit', normalized.commit)
  if (normalized.from && normalized.to)
    args.push('--from', normalized.from, '--to', normalized.to)
  if (normalized.fileExts.length > 0)
    args.push('--file-exts', ...normalized.fileExts)
  args.push('--format', 'json')
  return args
}

export function buildGitDiffArgs(selection = {}) {
  const validation = validateDiffSelection(selection)
  if (!validation.ok) throw new Error(validation.error)
  const { normalized } = validation
  const pathspecs = gitPathspecsFromExtensions(normalized.fileExts)

  if (normalized.commit)
    return ['show', '--format=', '--unified=3', normalized.commit, ...pathspecs]
  if (normalized.staged)
    return ['diff', '--staged', '--unified=3', ...pathspecs]
  if (normalized.from && normalized.to)
    return ['diff', '--unified=3', normalized.from, normalized.to, ...pathspecs]
  return ['diff', '--unified=3', ...pathspecs]
}

export function buildGitNameOnlyArgs(selection = {}) {
  const validation = validateDiffSelection(selection)
  if (!validation.ok) throw new Error(validation.error)
  const { normalized } = validation
  const pathspecs = gitPathspecsFromExtensions(normalized.fileExts)

  if (normalized.commit)
    return ['show', '--format=', '--name-only', normalized.commit, ...pathspecs]
  if (normalized.staged)
    return ['diff', '--staged', '--name-only', ...pathspecs]
  if (normalized.from && normalized.to)
    return ['diff', '--name-only', normalized.from, normalized.to, ...pathspecs]
  return ['diff', '--name-only', ...pathspecs]
}

export function buildImpactArgs({ entity, file, scope = 'all' }) {
  const entityName = cleanString(entity)
  if (!entityName) throw new Error('sem impact requires an entity name.')
  const args = ['impact', entityName]
  if (scope === 'deps') args.push('--deps')
  if (scope === 'dependents') args.push('--dependents')
  if (scope === 'tests') args.push('--tests')
  if (cleanString(file)) args.push('--file', cleanString(file))
  args.push('--json')
  return args
}

export function buildContextArgs({ entity, file, budget }) {
  const entityName = cleanString(entity)
  if (!entityName) throw new Error('sem context requires an entity name.')
  const args = ['context', entityName]
  if (cleanString(file)) args.push('--file', cleanString(file))
  if (Number.isFinite(budget) && Number(budget) > 0)
    args.push('--budget', String(Math.floor(Number(budget))))
  return args
}

export function buildLogArgs({ entity, file, limit, verbose }) {
  const entityName = cleanString(entity)
  if (!entityName) throw new Error('sem log requires an entity name.')
  const args = ['log', entityName]
  if (cleanString(file)) args.push('--file', cleanString(file))
  if (Number.isFinite(limit) && Number(limit) > 0)
    args.push('--limit', String(Math.floor(Number(limit))))
  if (verbose) args.push('-v')
  args.push('--json')
  return args
}

export function buildEntitiesArgs({ file }) {
  const targetFile = cleanString(file)
  if (!targetFile) throw new Error('sem entities requires a file path.')
  return ['entities', targetFile, '--json']
}

export function buildBlameArgs({ file }) {
  const targetFile = cleanString(file)
  if (!targetFile) throw new Error('sem blame requires a file path.')
  return ['blame', targetFile, '--json']
}

export function resolveSemInvocation(cwd = process.cwd()) {
  const candidates = []

  try {
    const pkgPath = require.resolve('@ataraxy-labs/sem/package.json', {
      paths: [cwd, THIS_DIR],
    })
    const pkgDir = dirname(pkgPath)
    const wrapperPath = join(pkgDir, 'bin', 'sem.js')
    if (existsSync(wrapperPath)) {
      candidates.push({
        command: process.execPath,
        argsPrefix: [wrapperPath],
        source: '@ataraxy-labs/sem',
      })
    }
  } catch {
    // Ignore and fall back.
  }

  const localBin = join(
    cwd,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'sem.cmd' : 'sem',
  )
  if (existsSync(localBin)) {
    candidates.push({
      command: localBin,
      argsPrefix: [],
      source: 'project node_modules/.bin',
    })
  }

  candidates.push({
    command: process.platform === 'win32' ? 'sem.exe' : 'sem',
    argsPrefix: [],
    source: 'PATH',
  })

  return candidates[0]
}

export function stripAnsi(text = '') {
  return String(text).replace(ANSI_PATTERN, '')
}

export function parseSemJsonOutput(toolName, text) {
  const cleaned = stripAnsi(text).trim()
  if (
    (toolName === 'sem diff' || toolName === 'sem_eval') &&
    (cleaned.length === 0 || /^No changes detected\.?$/i.test(cleaned))
  ) {
    return {
      summary: { fileCount: 0, added: 0, modified: 0, deleted: 0, total: 0 },
      changes: [],
    }
  }
  return JSON.parse(cleaned)
}

export function estimateTokens(text = '') {
  return Math.max(0, Math.ceil(Buffer.byteLength(String(text), 'utf8') / 4))
}

export function countLines(text = '') {
  if (text.length === 0) return 0
  return String(text).split(/\r?\n/).length
}

export function sizeBytes(text = '') {
  return Buffer.byteLength(String(text), 'utf8')
}

export function formatPercent(numerator, denominator) {
  if (!denominator) return '0%'
  return `${Math.round((numerator / denominator) * 100)}%`
}

export function summarizeSemDiffPayload(payload) {
  const summary =
    typeof payload === 'object' &&
    payload &&
    typeof payload.summary === 'object' &&
    payload.summary
      ? payload.summary
      : {}
  const changes = Array.isArray(payload?.changes) ? payload.changes : []
  const files = new Map()
  const entityTypes = new Map()

  for (const change of changes) {
    const filePath = cleanString(change?.filePath) ?? '<unknown>'
    if (!files.has(filePath)) files.set(filePath, [])
    files.get(filePath).push(change)

    const entityType = cleanString(change?.entityType) ?? 'unknown'
    entityTypes.set(entityType, (entityTypes.get(entityType) ?? 0) + 1)
  }

  const changedFiles = [...files.keys()].sort()
  const topChanges = changes.slice(0, 12).map((change) => ({
    changeType: cleanString(change?.changeType) ?? 'changed',
    entityType: cleanString(change?.entityType) ?? 'entity',
    entityName: cleanString(change?.entityName) ?? '<unknown>',
    filePath: cleanString(change?.filePath) ?? '<unknown>',
  }))

  return {
    summary: {
      fileCount:
        Number(summary.fileCount ?? changedFiles.length) || changedFiles.length,
      added: Number(summary.added ?? 0) || 0,
      modified: Number(summary.modified ?? 0) || 0,
      deleted: Number(summary.deleted ?? 0) || 0,
      total: Number(summary.total ?? changes.length) || changes.length,
    },
    changes,
    changedFiles,
    changesByFile: Object.fromEntries(
      [...files.entries()].map(([file, value]) => [file, value.length]),
    ),
    entityTypeCounts: Object.fromEntries(
      [...entityTypes.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
    topChanges,
  }
}

export function compareCoverage(gitFiles = [], semFiles = []) {
  const gitSet = new Set(
    gitFiles.map((file) => cleanString(file)).filter(Boolean),
  )
  const semSet = new Set(
    semFiles.map((file) => cleanString(file)).filter(Boolean),
  )
  const covered = [...gitSet].filter((file) => semSet.has(file)).sort()
  const missing = [...gitSet].filter((file) => !semSet.has(file)).sort()
  const extra = [...semSet].filter((file) => !gitSet.has(file)).sort()

  return {
    gitFiles: [...gitSet].sort(),
    semFiles: [...semSet].sort(),
    covered,
    missing,
    extra,
    coveragePercent: formatPercent(covered.length, gitSet.size),
  }
}

export function pickImpactTargets(payload, limit = 3) {
  const changes = Array.isArray(payload?.changes) ? payload.changes : []
  const targets = []
  const seen = new Set()

  for (const change of changes) {
    const entityName = cleanString(change?.entityName)
    const filePath = cleanString(change?.filePath)
    const changeType = cleanString(change?.changeType)
    if (!entityName || !filePath) continue
    if (changeType === 'deleted') continue
    const key = `${filePath}::${entityName}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({
      entity: entityName,
      file: filePath,
      entityType: cleanString(change?.entityType) ?? 'entity',
      changeType: changeType ?? 'modified',
    })
    if (targets.length >= limit) break
  }

  return targets
}

function countNestedItems(value) {
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== 'object') return 0

  for (const key of [
    'tests',
    'affectedTests',
    'impactedTests',
    'dependents',
    'affected',
    'items',
  ]) {
    if (Array.isArray(value[key])) return value[key].length
  }

  let total = 0
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) total += nested.length
  }
  return total
}

export function summarizeImpactResult(result) {
  if (!result || typeof result !== 'object') {
    return { inferredCount: 0, keys: [], preview: result }
  }

  return {
    inferredCount: countNestedItems(result),
    keys: Object.keys(result).sort(),
    preview: result,
  }
}

export function buildEvaluationReport({
  selection = {},
  gitDiffText = '',
  gitFiles = [],
  semDiffText = '',
  semDiffJson = {},
  impactResults = [],
}) {
  const normalized = normalizeSelection(selection)
  const semSummary = summarizeSemDiffPayload(semDiffJson)
  const coverage = compareCoverage(gitFiles, semSummary.changedFiles)

  return {
    selection: normalized,
    payload: {
      gitDiff: {
        bytes: sizeBytes(gitDiffText),
        lines: countLines(gitDiffText),
        estimatedTokens: estimateTokens(gitDiffText),
      },
      semDiff: {
        bytes: sizeBytes(semDiffText),
        lines: countLines(semDiffText),
        estimatedTokens: estimateTokens(semDiffText),
      },
    },
    compression: {
      bytesSaved: sizeBytes(gitDiffText) - sizeBytes(semDiffText),
      tokensSaved: estimateTokens(gitDiffText) - estimateTokens(semDiffText),
      tokenRatio:
        estimateTokens(gitDiffText) === 0
          ? null
          : Number(
              (
                estimateTokens(semDiffText) / estimateTokens(gitDiffText)
              ).toFixed(2),
            ),
    },
    coverage,
    sem: semSummary,
    impacts: impactResults.map((impact) => ({
      ...impact,
      summary: summarizeImpactResult(impact.result),
    })),
  }
}

export function formatCompactChangeList(changes = [], limit = 8) {
  const slice = changes.slice(0, limit)
  if (slice.length === 0) return ['- no changed entities reported']
  const lines = slice.map((change) => {
    return `- ${change.changeType} ${change.entityType} ${change.entityName} — ${change.filePath}`
  })
  if (changes.length > slice.length) {
    lines.push(`- … ${changes.length - slice.length} more entities`)
  }
  return lines
}

export function formatEvaluationReport(report) {
  const lines = []
  lines.push('# sem evaluation')
  lines.push('')
  lines.push(`- selection: ${report.selection.label}`)
  if (report.selection.fileExts.length > 0) {
    lines.push(`- file filters: ${report.selection.fileExts.join(', ')}`)
  }
  lines.push('')
  lines.push('## coverage')
  lines.push(`- git changed files: ${report.coverage.gitFiles.length}`)
  lines.push(
    `- sem files with changed entities: ${report.coverage.semFiles.length}`,
  )
  lines.push(
    `- semantic coverage: ${report.coverage.covered.length}/${report.coverage.gitFiles.length} (${report.coverage.coveragePercent})`,
  )
  if (report.coverage.missing.length > 0) {
    lines.push(
      `- missing from sem coverage: ${report.coverage.missing.join(', ')}`,
    )
  }
  if (report.coverage.extra.length > 0) {
    lines.push(`- extra sem-only files: ${report.coverage.extra.join(', ')}`)
  }
  lines.push('')
  lines.push('## payload size')
  lines.push(
    `- git diff: ${report.payload.gitDiff.lines} lines, ${report.payload.gitDiff.bytes} bytes, ~${report.payload.gitDiff.estimatedTokens} tokens`,
  )
  lines.push(
    `- sem diff json: ${report.payload.semDiff.lines} lines, ${report.payload.semDiff.bytes} bytes, ~${report.payload.semDiff.estimatedTokens} tokens`,
  )
  if (report.compression.tokenRatio !== null) {
    lines.push(`- sem/git token ratio: ${report.compression.tokenRatio}`)
  }
  if (report.compression.tokensSaved > 0) {
    lines.push(
      `- estimated tokens saved vs git diff: ${report.compression.tokensSaved}`,
    )
  } else if (report.compression.tokensSaved < 0) {
    lines.push(
      `- estimated extra tokens vs git diff: ${Math.abs(report.compression.tokensSaved)}`,
    )
  } else {
    lines.push('- estimated token delta vs git diff: 0')
  }
  if (
    report.compression.tokenRatio !== null &&
    report.compression.tokenRatio > 1
  ) {
    lines.push(
      '- note: on this selection, sem JSON is larger than raw git diff. sem is still useful for entity reasoning, impact analysis, and targeted context, but not always for raw token compression.',
    )
  }
  lines.push('')
  lines.push('## semantic summary')
  lines.push(
    `- entities changed: ${report.sem.summary.total} (added ${report.sem.summary.added}, modified ${report.sem.summary.modified}, deleted ${report.sem.summary.deleted})`,
  )
  lines.push(`- files with entity changes: ${report.sem.summary.fileCount}`)
  const entityTypes = Object.entries(report.sem.entityTypeCounts)
  if (entityTypes.length > 0) {
    lines.push(
      `- entity types: ${entityTypes.map(([type, count]) => `${type}=${count}`).join(', ')}`,
    )
  }
  lines.push('')
  lines.push('### top changed entities')
  lines.push(...formatCompactChangeList(report.sem.topChanges, 10))

  if (report.impacts.length > 0) {
    lines.push('')
    lines.push('## impact samples')
    for (const impact of report.impacts) {
      lines.push(
        `- ${impact.entity} (${impact.file}): inferred nested items=${impact.summary.inferredCount}, keys=${impact.summary.keys.join(', ') || 'n/a'}`,
      )
    }
  }

  return lines.join('\n')
}
