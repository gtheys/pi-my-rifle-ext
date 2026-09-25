/**
 * FFF (@ff-labs/fff-node) integration — frecency-backed find/grep with SDK
 * fallback. Ported from pi-pretty, trimmed: no cursor pagination, no
 * home/root scan opt-ins (restricted base path just falls back to SDK).
 *
 * ponytail: skipped grep cursor store + isolated-db retry; add when pagination
 * or multi-instance LMDB conflicts actually bite.
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import type { FileFinder, GrepMatch } from '@ff-labs/fff-node'

type FffModule = typeof import('@ff-labs/fff-node')

export class FffService {
  finder: FileFinder | null = null
  partialIndex = false

  get isAvailable(): boolean {
    return this.finder !== null && !this.finder.isDestroyed
  }

  /** Load module + create finder for cwd. Never throws — failure = SDK fallback. */
  async init(cwd: string): Promise<void> {
    let mod: FffModule
    try {
      mod = await import('@ff-labs/fff-node')
    } catch {
      return
    }
    const dbDir = join(getAgentDir(), 'pi-tool-pills', 'fff')
    try {
      mkdirSync(dbDir, { recursive: true })
    } catch {
      // FFF runs without persistent frecency/history if dir creation fails
    }
    const result = mod.FileFinder.create({
      basePath: cwd,
      aiMode: true,
      enableHomeDirScanning: false,
      enableFsRootScanning: false,
      frecencyDbPath: join(dbDir, 'frecency.mdb'),
      historyDbPath: join(dbDir, 'history.mdb'),
    })
    if (!result.ok) return
    try {
      const scan = await result.value.waitForScan(15_000)
      this.partialIndex = scan.ok && !scan.value
      this.finder = result.value
    } catch {
      result.value.destroy()
    }
  }

  destroy(): void {
    if (this.finder && !this.finder.isDestroyed) this.finder.destroy()
    this.finder = null
  }
}

// ---------------------------------------------------------------------------
// find — glob normalization (ported from pi-pretty find-glob.ts)
// ---------------------------------------------------------------------------

/** Bare `*.ts` searches under cwd recursively, matching Pi SDK find semantics. */
export function normalizeFindGlobPattern(pattern: string): string {
  const p = pattern.trim()
  if (!p || p === '**/*') return p
  if (p.includes('/') || p.startsWith('**/')) return p
  if (/[*?[\]]/.test(p)) return `**/${p}`
  return p
}

/** Empty FFF results for glob-ish patterns are suspicious — retry via SDK find. */
export function isLikelyGlobPattern(pattern: string): boolean {
  return /[*?[\]]/.test(pattern.trim())
}

export function buildGlobPattern(
  pattern: string,
  path: string | undefined,
  basePath: string | null,
): string {
  const raw = pattern.startsWith('/') ? pattern.slice(1) : pattern
  const normalized = normalizeFindGlobPattern(raw)
  let cleanPath = path ?? ''
  if (cleanPath && isAbsolute(cleanPath) && basePath) {
    cleanPath = relative(basePath, cleanPath) || ''
  }
  cleanPath = cleanPath.replace(/\/$/, '')
  if (!cleanPath) {
    if (normalized.startsWith('**/') || normalized.includes('/'))
      return normalized
    return `**/${normalized}`
  }
  if (normalized.startsWith('**/')) return `${cleanPath}/${normalized}`
  if (normalized.includes('/')) return `${cleanPath}/${normalized}`
  return `${cleanPath}/**/${normalized}`
}

// ---------------------------------------------------------------------------
// grep — FFF matches → ripgrep-style text (ported from pi-pretty fff-helpers.ts)
// ---------------------------------------------------------------------------

function sanitizeGrepRecordContent(text: string): string {
  let content = text
  if (content.endsWith('\r\n')) content = content.slice(0, -2)
  else if (content.endsWith('\r') || content.endsWith('\n'))
    content = content.slice(0, -1)
  return content
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

function truncateGrepRecordContent(text: string): string {
  const content = sanitizeGrepRecordContent(text)
  if (content.length > 500) return `${content.slice(0, 500)}...`
  return content
}

export function fffFormatGrepText(items: GrepMatch[], limit: number): string {
  const capped = items.slice(0, limit)
  if (!capped.length) return 'No matches found'

  const lines: string[] = []
  let currentFile = ''

  for (const match of capped) {
    if (match.relativePath !== currentFile) {
      if (currentFile) lines.push('')
      currentFile = match.relativePath
    }
    if (match.contextBefore?.length) {
      const startLine = match.lineNumber - match.contextBefore.length
      for (let i = 0; i < match.contextBefore.length; i++) {
        lines.push(
          `${match.relativePath}-${startLine + i}-${truncateGrepRecordContent(match.contextBefore[i] ?? '')}`,
        )
      }
    }
    lines.push(
      `${match.relativePath}:${match.lineNumber}:${truncateGrepRecordContent(match.lineContent)}`,
    )
    if (match.contextAfter?.length) {
      const startLine = match.lineNumber + 1
      for (let i = 0; i < match.contextAfter.length; i++) {
        lines.push(
          `${match.relativePath}-${startLine + i}-${truncateGrepRecordContent(match.contextAfter[i] ?? '')}`,
        )
      }
    }
  }

  return lines.join('\n')
}

export function isHomeOrRoot(cwd: string): boolean {
  return cwd === '/' || cwd === homedir()
}
