/**
 * Aven CLI client — exec wrapper + parsers for mutating commands.
 *
 * AIDEV-NOTE: aven-tools/* (subtask 1.2+) and the show --full parser build
 * on avenExec below. Follows the herdr.ts never-throw-on-parse style: exec
 * failures still throw here (mutating commands must surface errors to the
 * caller), but string extraction (parseCreatedRef) degrades to '' rather
 * than throwing on unexpected output.
 */

import { execFile } from 'node:child_process'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export interface AvenTicket {
  ref: string
  title: string
  status: string
  isEpic: boolean
  labels: string[]
  metadata: Record<string, string>
  notes: string[]
  description: string
}

export interface AvenExec {
  code: number
  stdout: string
  stderr: string
}

/** Run `aven <args>` in cwd. Never throws — callers decide on `code`. */
export async function avenExec(
  pi: ExtensionAPI,
  args: string[],
  cwd: string,
): Promise<AvenExec> {
  const result = await pi.exec('aven', args, { cwd })
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Read a `<label><<EOF` heredoc body starting at `lines[start]` (the first
 * body line). Returns the joined body and the index of the line after the
 * closing `EOF`. If no `EOF` line is found, reads to end of input rather
 * than throwing.
 */
function readHeredoc(
  lines: string[],
  start: number,
): { body: string; next: number } {
  const bodyLines: string[] = []
  let i = start
  while (i < lines.length) {
    if (lines[i] === 'EOF') {
      return { body: bodyLines.join('\n'), next: i + 1 }
    }
    bodyLines.push(lines[i])
    i += 1
  }
  return { body: bodyLines.join('\n'), next: i }
}

/** Parse `key="quoted value"` or `key=bareValue` tokens from a header line. */
function parseHeaderFields(rest: string): Map<string, string> {
  const fields = new Map<string, string>()
  const tokenPattern = /(\w+)=("([^"]*)"|(\S*))/g
  for (const match of rest.matchAll(tokenPattern)) {
    const key = match[1]
    const value = match[3] !== undefined ? match[3] : match[4]
    fields.set(key, value)
  }
  return fields
}

/**
 * Parse `aven show --full` output into an AvenTicket.
 *
 * AIDEV-NOTE: aven 0.1.39's `--json` mode omits metadata entirely, so this
 * text parser is the only source of metadata (and notes/description) until
 * upstream adds JSON support for them. Line-based state machine, never
 * throws — malformed or truncated input degrades to empty fields instead.
 */
export function parseShowFull(text: string): AvenTicket {
  const lines = text.split('\n')
  const ticket: AvenTicket = {
    ref: '',
    title: '',
    status: '',
    isEpic: false,
    labels: [],
    metadata: {},
    notes: [],
    description: '',
  }
  if (lines.length === 0 || lines[0].trim() === '') {
    return ticket
  }

  const headerLine = lines[0]
  const headerMatch = headerLine.match(/^(\S+)\s*(.*)$/)
  if (headerMatch === null) {
    return ticket
  }
  ticket.ref = headerMatch[1]
  const fields = parseHeaderFields(headerMatch[2])
  const status = fields.get('status')
  if (status !== undefined) {
    ticket.status = status
  }
  const title = fields.get('title')
  if (title !== undefined) {
    ticket.title = title
  }
  const labels = fields.get('labels')
  if (labels !== undefined && labels !== '') {
    ticket.labels = labels.split(' ')
  }
  ticket.isEpic = fields.get('epic') === 'yes'

  let i = 1
  let pendingMetadataKey: string | null = null
  while (i < lines.length) {
    const line = lines[i]
    const metadataMatch = line.match(/^metadata\s+field_id=\S+\s+key=(.+)$/)
    const noteMatch = line.match(/^note\s+id=\S+/)
    if (metadataMatch !== null) {
      pendingMetadataKey = metadataMatch[1]
      i += 1
      continue
    }
    if (pendingMetadataKey !== null && line === 'value<<EOF') {
      const { body, next } = readHeredoc(lines, i + 1)
      ticket.metadata[pendingMetadataKey] = body
      pendingMetadataKey = null
      i = next
      continue
    }
    if (noteMatch !== null) {
      i += 1
      if (i < lines.length && lines[i] === 'body<<EOF') {
        const { body, next } = readHeredoc(lines, i + 1)
        ticket.notes.push(body)
        i = next
        continue
      }
      continue
    }
    if (line === 'description<<EOF') {
      const { body, next } = readHeredoc(lines, i + 1)
      ticket.description = body
      i = next
      continue
    }
    i += 1
  }

  return ticket
}

/** Extract the ref from `aven add` stdout, e.g. "created PMR-AB12" → "PMR-AB12". */
export function parseCreatedRef(stdout: string): string {
  const match = stdout.match(/created\s+(\S+)/)
  if (match === null) {
    return ''
  }
  return match[1]
}

export interface AvenAddOptions {
  title: string
  epic?: boolean
  status?: string
  labels?: string[]
  description?: string
  metadata?: Record<string, string>
}

function metadataArgs(metadata: Record<string, string> | undefined): string[] {
  if (metadata === undefined) {
    return []
  }
  const args: string[] = []
  for (const [key, value] of Object.entries(metadata)) {
    args.push('--metadata', `${key}=${value}`)
  }
  return args
}

export async function avenAdd(
  pi: ExtensionAPI,
  options: AvenAddOptions,
  cwd: string,
): Promise<string> {
  const args = ['add', options.title]
  if (options.epic === true) {
    args.push('--epic')
  }
  if (options.status !== undefined) {
    args.push('--status', options.status)
  }
  if (options.labels !== undefined) {
    for (const label of options.labels) {
      args.push('--label', label)
    }
  }
  if (options.description !== undefined) {
    args.push('--description', options.description)
  }
  args.push(...metadataArgs(options.metadata))
  const result = await avenExec(pi, args, cwd)
  if (result.code !== 0) {
    throw new Error(`aven add failed: ${result.stderr || result.stdout}`)
  }
  return parseCreatedRef(result.stdout)
}

export interface AvenEditOptions {
  status?: string
  metadata?: Record<string, string>
  epic?: boolean
}

export async function avenEdit(
  pi: ExtensionAPI,
  ref: string,
  options: AvenEditOptions,
  cwd: string,
): Promise<void> {
  const args = ['edit', ref]
  if (options.status !== undefined) {
    args.push('--status', options.status)
  }
  args.push(...metadataArgs(options.metadata))
  if (options.epic !== undefined) {
    if (options.epic) {
      args.push('--epic', 'on')
    } else {
      args.push('--epic', 'off')
    }
  }
  const result = await avenExec(pi, args, cwd)
  if (result.code !== 0) {
    throw new Error(`aven edit failed: ${result.stderr || result.stdout}`)
  }
}

/**
 * AIDEV-NOTE: pi.exec (ExecOptions) has no stdin option, so `note --stdin`
 * is shelled out directly via node:child_process execFile (same choice as
 * pi-aven-context/index.ts), writing the body to the child's stdin instead
 * of relying on pi's exec wrapper.
 */
export async function avenNote(
  pi: ExtensionAPI,
  ref: string,
  body: string,
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'aven',
      ['note', ref, '--stdin'],
      { cwd },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`aven note failed: ${stderr || error.message}`))
          return
        }
        resolve()
      },
    )
    child.stdin?.end(body)
  })
  // pi is accepted for signature symmetry with the other command wrappers
  // (registration-free plain-function style), even though it is unused here.
  void pi
}

export async function avenEpicList(
  pi: ExtensionAPI,
  ref: string,
  cwd: string,
): Promise<unknown[]> {
  const result = await avenExec(pi, ['epic', 'list', ref, '--json'], cwd)
  if (result.code !== 0) {
    throw new Error(`aven epic list failed: ${result.stderr || result.stdout}`)
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    if (Array.isArray(parsed)) {
      return parsed
    }
    // AIDEV-NOTE: real `aven epic list --json` wraps children in an object
    // ({children: [...], epic: {...}}); the bare-array branch covers older
    // fixtures/tests. Children omit is_epic — classifiers must not rely on it.
    if (typeof parsed === 'object' && parsed !== null) {
      const children = (parsed as Record<string, unknown>).children
      if (Array.isArray(children)) {
        return children
      }
    }
    return []
  } catch {
    return []
  }
}

/**
 * `aven show <ref> --json` — existence + basic title check. AIDEV-NOTE:
 * unlike parseShowFull, this JSON mode omits metadata/notes (aven 0.1.39),
 * so it is only used for existence checks and title lookups, never for
 * metadata reads.
 */
export async function avenShowJson(
  pi: ExtensionAPI,
  ref: string,
  cwd: string,
): Promise<unknown | null> {
  const result = await avenExec(pi, ['show', ref, '--json'], cwd)
  if (result.code !== 0) {
    return null
  }
  try {
    return JSON.parse(result.stdout) as unknown
  } catch {
    return null
  }
}

/** `aven list --metadata <key>=<value> --json` — returns [] on failure or unparsable output. */
export async function avenListByMetadata(
  pi: ExtensionAPI,
  key: string,
  value: string,
  cwd: string,
): Promise<unknown[]> {
  const result = await avenExec(
    pi,
    ['list', '--metadata', `${key}=${value}`, '--json'],
    cwd,
  )
  if (result.code !== 0) {
    return []
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    if (Array.isArray(parsed)) {
      return parsed
    }
    return []
  } catch {
    return []
  }
}

/** `aven show <ref> --full` — parsed via parseShowFull (metadata/notes/description). */
export async function avenShowFull(
  pi: ExtensionAPI,
  ref: string,
  cwd: string,
): Promise<AvenTicket> {
  const result = await avenExec(pi, ['show', ref, '--full'], cwd)
  return parseShowFull(result.stdout)
}

/** `aven epic add <child> <parent>` — attach child ticket under parent epic. */
export async function avenEpicAdd(
  pi: ExtensionAPI,
  child: string,
  parent: string,
  cwd: string,
): Promise<void> {
  const result = await avenExec(pi, ['epic', 'add', child, parent], cwd)
  if (result.code !== 0) {
    throw new Error(`aven epic add failed: ${result.stderr || result.stdout}`)
  }
}

export async function avenDepAdd(
  pi: ExtensionAPI,
  blocked: string,
  blocker: string,
  cwd: string,
): Promise<void> {
  const result = await avenExec(pi, ['dep', 'add', blocked, blocker], cwd)
  if (result.code !== 0) {
    throw new Error(`aven dep add failed: ${result.stderr || result.stdout}`)
  }
}

/** Create a label; "already exists" on stderr is not an error (idempotent). */
export async function avenLabelCreate(
  pi: ExtensionAPI,
  name: string,
  cwd: string,
): Promise<void> {
  const result = await avenExec(pi, ['label', 'create', name], cwd)
  if (result.code !== 0 && !result.stderr.includes('already exists')) {
    throw new Error(
      `aven label create failed: ${result.stderr || result.stdout}`,
    )
  }
}
