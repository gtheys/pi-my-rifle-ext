/**
 * SonarQube Analysis Extension
 *
 * Provides a `/sonarqube` command that fetches SonarCloud coverage gaps and
 * quality issues for a PR, then generates an actionable report.
 *
 * Rewrite of salaryhero/opencode/bin/sonar-* scripts as a pi extension.
 * Analysis-only — no code changes.
 *
 * Usage:
 *   /sonarqube          — auto-detect PR from current branch + config from sonar-project.properties
 *   /sonarqube 283      — explicit PR number
 *   /sonarqube 283 --severity=BLOCKER,CRITICAL
 *   /sonarqube 283 --types=BUG,VULNERABILITY
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  analyzeCoverage,
  analyzeIssues,
  type CoverageAnalysis,
  type CoverageMeasure,
  type CoverageResponse,
  detectPrNumber,
  detectSonarConfig,
  type FilterOptions,
  fetchAllIssues,
  type IssuesAnalysis,
  type SonarConfig,
  type SonarIssue,
  sonarFetch,
  TYPE_SYMBOLS,
} from '../shared/sonarqube-utils.ts'

// ── Duplication types ────────────────────────────────────────────────────────

interface DuplicationBlock {
  from: number
  size: number
  _ref: string
}

interface DuplicationEntry {
  blocks: DuplicationBlock[]
}

interface DuplicationFile {
  key: string
  name: string
  projectName?: string
}

interface DuplicationsShowResponse {
  duplications: DuplicationEntry[]
  files: Record<string, DuplicationFile>
}

interface ComponentMeasure {
  key: string
  name: string
  qualifier: string
  measures: Array<{ metric: string; value?: string }>
}

interface ComponentTreeResponse {
  components: ComponentMeasure[]
  paging: { pageIndex: number; pageSize: number; total: number }
}

interface DuplicatedFileDetail {
  file: string
  key: string
  density: number
  blocks: number
  duplicatedLines: number
  duplicationGroups?: Array<{
    blocks: Array<{ from: number; size: number; file: string }>
  }>
}

interface DuplicationAnalysis {
  density: number
  duplicatedLines: number
  duplicatedBlocks: number
  duplicatedFiles: number
  status: string
  icon: string
  topFiles: DuplicatedFileDetail[]
}

// ── Duplication fetching & analysis ─────────────────────────────────────────

// AIDEV-NOTE: component_tree supports the `pullRequest` param so we scope results
// to the PR diff. Falls back gracefully if the API returns no duplication data.
async function fetchDuplicatedFiles(
  baseUrl: string,
  token: string,
  projectKey: string,
  prNumber: string,
  signal?: AbortSignal,
): Promise<DuplicatedFileDetail[]> {
  const data = (await sonarFetch(
    baseUrl,
    token,
    'measures/component_tree',
    {
      component: projectKey,
      pullRequest: prNumber,
      metricKeys: 'duplicated_lines_density,duplicated_blocks,duplicated_lines',
      qualifiers: 'FIL',
      s: 'metric',
      metricSort: 'duplicated_lines_density',
      asc: 'false',
      ps: '20',
    },
    signal,
  )) as ComponentTreeResponse

  return (data.components ?? [])
    .map((c) => {
      const getMeasure = (metric: string) =>
        parseFloat(c.measures.find((m) => m.metric === metric)?.value ?? '0') ||
        0
      return {
        file: c.key.split(':')[1] || c.key,
        key: c.key,
        density: getMeasure('duplicated_lines_density'),
        blocks: getMeasure('duplicated_blocks'),
        duplicatedLines: getMeasure('duplicated_lines'),
      }
    })
    .filter((f) => f.density > 0)
}

async function fetchDuplicationDetails(
  baseUrl: string,
  token: string,
  fileKey: string,
  prNumber: string,
  signal?: AbortSignal,
): Promise<DuplicationsShowResponse | null> {
  try {
    return (await sonarFetch(
      baseUrl,
      token,
      'duplications/show',
      { key: fileKey, pullRequest: prNumber },
      signal,
    )) as DuplicationsShowResponse
  } catch {
    // Per-file detail is best-effort — don't fail the whole report
    return null
  }
}

function analyzeDuplications(
  coverageMeasures: CoverageMeasure[],
  topFiles: DuplicatedFileDetail[],
): DuplicationAnalysis {
  const getMetric = (metric: string): number => {
    const m = coverageMeasures.find((m) => m.metric === metric)
    if (!m) return 0
    if (m.periods && m.periods.length > 0)
      return parseFloat(m.periods[0].value) || 0
    return parseFloat(m.value ?? '0') || 0
  }

  const density = getMetric('duplicated_lines_density')
  const duplicatedLines = Math.round(getMetric('duplicated_lines'))
  const duplicatedBlocks = Math.round(getMetric('duplicated_blocks'))
  const duplicatedFiles = Math.round(getMetric('duplicated_files'))

  let status: 'PASS' | 'WARN' | 'FAIL'
  let icon: string
  if (density <= 3) {
    status = 'PASS'
    icon = '✅'
  } else if (density <= 10) {
    status = 'WARN'
    icon = '⚠️'
  } else {
    status = 'FAIL'
    icon = '❌'
  }

  return {
    density,
    duplicatedLines,
    duplicatedBlocks,
    duplicatedFiles,
    status,
    icon,
    topFiles,
  }
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(args: string): {
  prNumber?: string
  filter?: FilterOptions
} {
  if (!args.trim()) return {}

  const parts = args.trim().split(/\s+/)
  let prNumber: string | undefined
  const filter: FilterOptions = {}

  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      prNumber = part
    } else if (part.startsWith('--severity=')) {
      filter.severity = part.split('=')[1].split(',')
    } else if (part.startsWith('--types=')) {
      filter.types = part.split('=')[1].split(',')
    } else if (part.startsWith('--files=')) {
      filter.files = part.split('=')[1]
    }
  }

  let filterArg: typeof filter | undefined
  if (Object.keys(filter).length > 0) {
    filterArg = filter
  } else {
    filterArg = undefined
  }
  return {
    prNumber,
    filter: filterArg,
  }
}

// ── Report generation ─────────────────────────────────────────────────────────

function generateDuplicationSection(dup: DuplicationAnalysis): string[] {
  const lines: string[] = []
  const sep = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

  lines.push(sep)
  lines.push('🔁 CODE DUPLICATION REPORT')
  lines.push(sep)
  lines.push('')
  lines.push(`Duplication Density: ${dup.density.toFixed(1)}% ${dup.icon}`)
  lines.push(`Duplicated Lines:  ${dup.duplicatedLines}`)
  lines.push(`Duplicated Blocks: ${dup.duplicatedBlocks}`)
  lines.push(`Duplicated Files:  ${dup.duplicatedFiles}`)
  lines.push('')
  lines.push('Threshold: ≤3% PASS | ≤10% WARN | >10% FAIL')
  lines.push('')

  if (dup.topFiles.length > 0) {
    lines.push('📂 Most Duplicated Files:')
    lines.push('')
    dup.topFiles.slice(0, 10).forEach((f, i) => {
      lines.push(`${i + 1}. ${f.file}`)
      lines.push(
        `   Density: ${f.density.toFixed(1)}%  Blocks: ${f.blocks}  Lines: ${f.duplicatedLines}`,
      )
      if (f.duplicationGroups && f.duplicationGroups.length > 0) {
        f.duplicationGroups.slice(0, 3).forEach((g, gi) => {
          lines.push(`   Group ${gi + 1}:`)
          g.blocks.forEach((b) => {
            let location: string
            if (b.file !== f.file) {
              location = ` (in ${b.file})`
            } else {
              location = ''
            }
            lines.push(
              `     • Lines ${b.from}–${b.from + b.size - 1} [${b.size} lines]${location}`,
            )
          })
        })
      }
      lines.push('')
    })
  } else {
    lines.push('No duplicated files detected in this PR. ✅')
    lines.push('')
  }

  return lines
}

function generateReport(
  prNumber: string,
  config: SonarConfig,
  coverage: CoverageAnalysis,
  issues: IssuesAnalysis,
  duplication?: DuplicationAnalysis,
): string {
  const lines: string[] = []
  const sep = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'

  // Header
  lines.push(`📊 SonarCloud Analysis — PR #${prNumber}`)
  lines.push('')
  lines.push(sep)
  lines.push('📈 COVERAGE REPORT')
  lines.push(sep)
  lines.push('')

  // Coverage metrics
  lines.push(
    `Overall Line Coverage: ${coverage.overallCoverage}% ${coverage.icons.overall}`,
  )
  lines.push(
    `New Code Coverage: ${coverage.newCoverage}% ${coverage.icons.newCode}`,
  )
  lines.push(
    `Branch Coverage: ${coverage.branchCoverage}% ${coverage.icons.branch}`,
  )
  lines.push(
    `New Branch Coverage: ${coverage.newBranchCoverage}% ${coverage.icons.newBranch}`,
  )
  lines.push('')
  lines.push(
    `Uncovered Lines: ${coverage.uncoveredLines} / ${coverage.linesToCover}`,
  )
  lines.push('')
  lines.push('Coverage Thresholds (80% minimum):')
  const fmtGap = (gap: number): string => {
    if (gap > 0) {
      return `${gap}% to target`
    }
    return 'meets threshold'
  }
  lines.push(
    `${coverage.icons.overall} Overall: ${fmtGap(coverage.gaps.overall)}`,
  )
  lines.push(
    `${coverage.icons.newCode} New Code: ${fmtGap(coverage.gaps.newCode)}`,
  )
  lines.push(`${coverage.icons.branch} Branch: ${fmtGap(coverage.gaps.branch)}`)
  lines.push(
    `${coverage.icons.newBranch} New Branch: ${fmtGap(coverage.gaps.newBranch)}`,
  )
  lines.push('')

  // Duplication section (after coverage metrics)
  if (duplication) {
    lines.push(...generateDuplicationSection(duplication))
  }

  // Low-coverage files from issues
  const lowCoverageFiles = issues.byFile.slice(0, 5)
  if (lowCoverageFiles.length > 0) {
    lines.push(sep)
    lines.push('🔴 FILES NEEDING ATTENTION')
    lines.push(sep)
    lines.push('')
    lowCoverageFiles.forEach((f, i) => {
      lines.push(`${i + 1}. ${f.file} — ${f.count} issues`)
    })
    lines.push('')
  }

  // Quality issues summary
  lines.push(sep)
  lines.push('⚠️ QUALITY ISSUES SUMMARY')
  lines.push(sep)
  lines.push('')

  lines.push(`Total Issues: ${issues.total}`)
  lines.push('')

  // By severity
  lines.push('By Severity:')
  const blockCrit =
    (issues.bySeverity.BLOCKER || 0) + (issues.bySeverity.CRITICAL || 0)
  const major = issues.bySeverity.MAJOR || 0
  const minorInfo =
    (issues.bySeverity.MINOR || 0) + (issues.bySeverity.INFO || 0)
  lines.push(`🔴 Blocker/Critical: ${blockCrit}`)
  lines.push(`🟡 Major: ${major}`)
  lines.push(`🔵 Minor/Info: ${minorInfo}`)
  lines.push('')

  // By type
  lines.push('By Type:')
  for (const [type, count] of Object.entries(issues.byType)) {
    lines.push(`${TYPE_SYMBOLS[type] || '❓'} ${type}: ${count}`)
  }
  lines.push('')

  // Top files
  if (issues.byFile.length > 0) {
    lines.push(sep)
    lines.push('📂 TOP FILES WITH ISSUES')
    lines.push(sep)
    lines.push('')
    issues.byFile.slice(0, 10).forEach((f, i) => {
      lines.push(`${i + 1}. ${f.file} — ${f.count} issues`)
    })
    lines.push('')
  }

  // Top rules
  if (issues.byRule.length > 0) {
    lines.push(sep)
    lines.push('⚠️ TOP VIOLATED RULES')
    lines.push(sep)
    lines.push('')
    issues.byRule.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.rule} (${r.severity}) — ${r.count} occurrences`)
      lines.push(`   "${r.message}"`)
      lines.push('')
    })
  }

  // Action plan
  lines.push(sep)
  lines.push('✅ ACTION PLAN')
  lines.push(sep)
  lines.push('')

  if (coverage.gaps.overall > 0 || coverage.gaps.newCode > 0) {
    const lowCovFiles = issues.byFile
      .slice(0, 5)
      .map((f) => f.file)
      .join(', ')
    lines.push('Priority 0 — COVERAGE GAPS:')
    if (lowCovFiles)
      lines.push(`  • Add tests for low-coverage files: ${lowCovFiles}`)
    lines.push('  • Minimum 80% coverage required before merge')
    lines.push('')
  }

  if (blockCrit > 0) {
    const topFiles = issues.byFile
      .slice(0, 3)
      .map((f) => f.file)
      .join(', ')
    lines.push(`Priority 1 — CRITICAL/BLOCKER (${blockCrit} issues):`)
    lines.push('  • Fix immediately before merge')
    if (topFiles) lines.push(`  • Focus on: ${topFiles}`)
    lines.push('')
  }

  if (major > 0) {
    lines.push(`Priority 2 — MAJOR (${major} issues):`)
    lines.push('  • Address in this PR if possible')
    lines.push('  • Consider tech debt ticket if extensive')
    lines.push('')
  }

  if (minorInfo > 0) {
    lines.push(`Priority 3 — MINOR/INFO (${minorInfo} issues):`)
    lines.push('  • Can be addressed in follow-up PR')
    lines.push('  • Add to backlog for refactoring sprint')
    lines.push('')
  }

  // Links
  lines.push(sep)
  lines.push('🔗 LINKS')
  lines.push(sep)
  lines.push('')
  lines.push('View in SonarCloud:')
  lines.push(
    `https://sonarcloud.io/project/pull_requests_list?id=${config.projectKey}&pullRequest=${prNumber}`,
  )

  return lines.join('\n')
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function sonarqube(pi: ExtensionAPI) {
  pi.registerCommand('sonarqube', {
    description: 'Analyze SonarCloud coverage gaps and quality issues for a PR',
    handler: async (args, ctx) => {
      // 1. Verify token
      const token = process.env.SONARQUBE_TOKEN
      if (!token) {
        ctx.ui.notify(
          'SONARQUBE_TOKEN not set. Run: export SONARQUBE_TOKEN=your_token',
          'error',
        )
        return
      }

      // 2. Parse arguments
      const parsed = parseArgs(args)
      const filter = parsed.filter

      // 3. Detect config
      let config: SonarConfig
      try {
        config = await detectSonarConfig(ctx.cwd)
      } catch (err) {
        ctx.ui.notify(String((err as Error).message), 'error')
        return
      }

      // 4. Detect PR number
      const prNumber = parsed.prNumber || (await detectPrNumber('/sonarqube'))
      ctx.ui.notify(`Analyzing PR #${prNumber}...`, 'info')

      // 5. Fetch coverage
      let coverageData: CoverageResponse
      try {
        coverageData = (await sonarFetch(
          config.baseUrl,
          token,
          'measures/component',
          {
            component: config.projectKey,
            pullRequest: prNumber,
            metricKeys:
              'coverage,new_coverage,new_line_coverage,uncovered_lines,lines_to_cover,branch_coverage,new_branch_coverage,new_lines_to_cover',
          },
          ctx.signal,
        )) as CoverageResponse
      } catch (err) {
        ctx.ui.notify(
          `Coverage fetch failed: ${(err as Error).message}`,
          'error',
        )
        return
      }

      // 6. Fetch issues (handle pagination)
      let allIssues: SonarIssue[]
      let total: number
      try {
        ;({ issues: allIssues, total } = await fetchAllIssues(
          config.baseUrl,
          token,
          config.projectKey,
          prNumber,
          ctx.signal,
        ))
      } catch (err) {
        ctx.ui.notify(`Issues fetch failed: ${(err as Error).message}`, 'error')
        return
      }

      // 7. Analyze
      const coverage = analyzeCoverage(coverageData)
      const issues = analyzeIssues({ total, issues: allIssues }, filter)

      // 8. Fetch duplication data
      let duplication: DuplicationAnalysis | undefined
      try {
        ctx.ui.notify('Fetching duplication data...', 'info')

        // Project-level duplication metrics (added to existing coverage fetch params)
        const dupMeasuresData = (await sonarFetch(
          config.baseUrl,
          token,
          'measures/component',
          {
            component: config.projectKey,
            pullRequest: prNumber,
            metricKeys:
              'duplicated_lines_density,duplicated_lines,duplicated_blocks,duplicated_files',
          },
          ctx.signal,
        )) as CoverageResponse

        // Per-file breakdown (top duplicated files)
        const topFiles = await fetchDuplicatedFiles(
          config.baseUrl,
          token,
          config.projectKey,
          prNumber,
          ctx.signal,
        )

        // Detailed block info for top 5 most-duplicated files
        const TOP_N = 5
        for (const fileDetail of topFiles.slice(0, TOP_N)) {
          const details = await fetchDuplicationDetails(
            config.baseUrl,
            token,
            fileDetail.key,
            prNumber,
            ctx.signal,
          )
          if (details) {
            fileDetail.duplicationGroups = details.duplications.map((d) => ({
              blocks: d.blocks.map((b) => ({
                from: b.from,
                size: b.size,
                file:
                  details.files[b._ref]?.key.split(':')[1] ||
                  details.files[b._ref]?.key ||
                  fileDetail.file,
              })),
            }))
          }
        }

        duplication = analyzeDuplications(
          dupMeasuresData.component?.measures ?? [],
          topFiles,
        )
      } catch (err) {
        // AIDEV-NOTE: Duplication fetch is non-fatal — report still generated without it.
        ctx.ui.notify(
          `Duplication fetch skipped: ${(err as Error).message}`,
          'info',
        )
      }

      // 9. Generate report
      const report = generateReport(
        prNumber,
        config,
        coverage,
        issues,
        duplication,
      )

      // 10. Write report to repo root
      const reportPath = path.join(ctx.cwd, 'sonarqube-report.md')
      await fs.writeFile(reportPath, report, 'utf8')

      ctx.ui.notify(
        `Analysis complete: ${issues.total} issues, coverage ${coverage.overallCoverage}%. Report: ${reportPath}`,
        'info',
      )

      // 11. Send report as user message so the agent can act on it
      pi.sendUserMessage(report)
    },
  })
}
