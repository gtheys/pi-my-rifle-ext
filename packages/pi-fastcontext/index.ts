import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8772/v1'
const DEFAULT_MODEL = 'FastContext-1.0-4B-RL-Q4_K_M.gguf'
const MAX_TOOL_CHARS = 5_000
const MAX_READ_LINES = 120
const MAX_GREP_RESULTS = 40
const MAX_GLOB_RESULTS = 80
const MAX_FINAL_CITATIONS = 12

const USER_CONFIG_PATH = path.join(getAgentDir(), 'fastcontext.json')

// AIDEV-NOTE: TypeBox schema is the source of truth for config shape.
// config.schema.json is generated from this at startup if missing/stale.
const FastContextConfigSchema = Type.Object({
  baseUrl: Type.Optional(
    Type.String({
      description: 'OpenAI-compatible base URL for FastContext server',
      default: DEFAULT_BASE_URL,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: 'FastContext model ID',
      default: DEFAULT_MODEL,
    }),
  ),
  maxTurns: Type.Optional(
    Type.Integer({
      description: 'Maximum tool-call turns per search',
      default: 6,
      minimum: 1,
      maximum: 8,
    }),
  ),
  maxTokens: Type.Optional(
    Type.Integer({
      description: 'Max tokens per FastContext model response',
      default: 1400,
      minimum: 128,
      maximum: 4096,
    }),
  ),
})

type FastContextConfigOverrides = Static<typeof FastContextConfigSchema>

type FastContextConfig = Required<FastContextConfigOverrides>

async function readConfigFile(
  file: string,
): Promise<FastContextConfigOverrides> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Value.Check(FastContextConfigSchema, parsed)) {
      return {}
    }
    return parsed
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read FastContext config ${file}: ${msg}`)
  }
}

function intFromEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  if (Number.isFinite(value)) {
    return value
  }
  return undefined
}

async function resolveConfig(
  cwd: string,
  overrides: FastContextConfigOverrides = {},
): Promise<FastContextConfig> {
  const projectConfigPath = path.join(cwd, '.pi', 'fastcontext.json')
  const merged: FastContextConfig = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    maxTurns: 6,
    maxTokens: 1400,
  }

  Object.assign(merged, await readConfigFile(USER_CONFIG_PATH))
  Object.assign(merged, await readConfigFile(projectConfigPath))

  Object.assign(merged, {
    baseUrl: process.env.FASTCONTEXT_BASE_URL || merged.baseUrl,
    model: process.env.FASTCONTEXT_MODEL || merged.model,
    maxTurns: intFromEnv('FASTCONTEXT_MAX_TURNS') ?? merged.maxTurns,
    maxTokens: intFromEnv('FASTCONTEXT_MAX_TOKENS') ?? merged.maxTokens,
  })

  Object.assign(
    merged,
    Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined),
    ),
  )

  merged.maxTurns = Math.max(1, Math.min(8, Math.floor(merged.maxTurns || 6)))
  merged.maxTokens = Math.max(
    128,
    Math.min(4096, Math.floor(merged.maxTokens || 1400)),
  )
  return merged
}

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  'node_modules',
  'build',
  'dist',
  'target',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  '.turbo',
  'DerivedData',
])

const TEXT_EXT_ALLOW = new Set([
  '',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.m',
  '.mm',
  '.metal',
  '.go',
  '.rs',
  '.py',
  '.pyi',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.java',
  '.kt',
  '.swift',
  '.rb',
  '.php',
  '.json',
  '.toml',
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  '.sh',
  '.sql',
  '.css',
  '.scss',
  '.html',
  '.xml',
  '.cmake',
  '.gradle',
])

const fcTools = [
  {
    type: 'function',
    function: {
      name: 'GLOB',
      description:
        "Find repository files by a glob pattern. Pattern must be relative to repo root and must not start with '/'. Examples: '**/*.go', 'internal/**/*.go', '**/*auth*'.",
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'GREP',
      description:
        "Regex search over repository text. path is an optional relative file or directory; never use leading '/'.",
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: {
            type: 'string',
            description:
              'Optional relative directory or file. Empty means repository root.',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'READ',
      description:
        "Read a repository file and return line-numbered contents. path must be relative to repo root and must not start with '/'.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', description: '1-based starting line' },
          limit: { type: 'integer', description: 'maximum lines to return' },
        },
        required: ['path'],
      },
    },
  },
]

const systemPrompt = `You are FastContext, a fast read-only repository exploration subagent.
Your job: locate code relevant to the user's query and return compact file:line evidence.

Available tools: GLOB, GREP, READ. Use multiple tool calls in parallel when useful.
Rules:
- All paths/patterns are relative to the repository root; never start paths with '/'.
- If the repo name appears in an absolute-looking path, strip it and use the path relative to repo root.
- Prefer GREP/GLOB first, READ only likely files/ranges.
- Prefer production/source code citations. Cite tests, YAML fixtures, or examples only when the user asks for them or no source-code evidence exists.
- Do not invent files or line numbers.
- Do not cite wildcard/glob paths like cache-*.yaml; every citation must be a concrete existing file.
- Finish as soon as you have enough evidence, ideally within 3 tool turns.
- Final response must contain at most ${MAX_FINAL_CITATIONS} citations; one line per citation; reason <= 8 words.
- Always close the XML tag. Final response must be exactly:
<final_answer>
relative/path:START-END — short reason
relative/path:START-END — short reason
</final_answer>`

type Message = Record<string, any>
type ToolCall = { id: string; name: string; arguments: Record<string, any> }
type Citation = {
  path: string
  start: number
  end: number
  line: string
  exists: boolean
  inBounds: boolean
}

type RunOptions = {
  query: string
  cwd: string
  baseUrl: string
  model: string
  maxTurns: number
  maxTokens: number
  forceFinal: boolean
  includeTranscript: boolean
  signal?: AbortSignal
  // AIDEV-NOTE: widened so the tool's AgentToolUpdateCallback can be passed through unchanged
  onUpdate?: (update: any) => void
}

function stripAt(s: string): string {
  if (s.startsWith('@')) {
    return s.slice(1)
  }
  return s
}

function normalizeRel(raw: string, root: string): string {
  let rel = stripAt(String(raw || ''))
    .trim()
    .replaceAll('\\', '/')
  rel = rel.replace(/^\/+/, '')
  rel = rel.replace(/^\.\//, '')
  const base = path.basename(root)
  // FastContext often emits /repo-name/path after SWE-bench-style Docker mounts.
  if (rel === base) rel = ''
  if (rel.startsWith(base + '/')) rel = rel.slice(base.length + 1)
  return rel
}

function relCandidates(raw: string, root: string): string[] {
  const original = stripAt(String(raw || ''))
    .trim()
    .replaceAll('\\', '/')
  const stripped = original.replace(/^\/+/, '').replace(/^\.\//, '')
  const base = path.basename(root)
  const candidates = [normalizeRel(raw, root)]

  // Match sdougbrown/fastcontext-harness resolve_path() behavior:
  // 1. /cmd/main.go -> {root}/cmd/main.go (handled by normalizeRel)
  // 2. /repo-name/cmd/main.go or /wrong-prefix/cmd/main.go -> {root}/cmd/main.go
  const parts = stripped.split('/')
  if (parts.length > 1) {
    candidates.push(parts.slice(1).join('/'))
  }
  if (parts[0] === base && parts.length > 1) {
    candidates.push(parts.slice(1).join('/'))
  }

  return [
    ...new Set(
      candidates.map((c) => c.replace(/^\/+/, '').replace(/^\.\//, '')),
    ),
  ]
}

function resolveSafe(
  root: string,
  raw: string,
  relOverride?: string,
): { abs: string; rel: string; error?: string } {
  const rel = relOverride ?? normalizeRel(raw, root)
  if (rel.includes('\0')) return { abs: root, rel, error: 'NUL byte in path' }
  if (rel.split('/').includes('..'))
    return { abs: root, rel, error: "path must not contain '..'" }
  const abs = path.resolve(root, rel || '.')
  const relative = path.relative(root, abs)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { abs, rel, error: `path escapes repository: ${raw}` }
  }
  return { abs, rel }
}

async function resolveExistingSafe(
  root: string,
  raw: string,
): Promise<{
  abs: string
  rel: string
  error?: string
  corrected?: boolean
  tried: string[]
}> {
  const tried: string[] = []
  let first: { abs: string; rel: string; error?: string } | undefined
  for (const rel of relCandidates(raw, root)) {
    const resolved = resolveSafe(root, raw, rel)
    if (!first) first = resolved
    if (resolved.error) continue
    tried.push(resolved.rel || '.')
    if (await exists(resolved.abs)) {
      return {
        ...resolved,
        corrected: resolved.rel !== normalizeRel(raw, root),
        tried,
      }
    }
  }
  const fallback = first ?? resolveSafe(root, raw)
  return { ...fallback, tried }
}

function truncate(s: string, max = MAX_TOOL_CHARS): string {
  if (s.length <= max) {
    return s
  }
  return `${s.slice(0, max)}\n... [truncated to ${max} chars]`
}

function skipRel(rel: string): boolean {
  return rel.split('/').some((part) => SKIP_DIRS.has(part))
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isFile()
  } catch {
    return false
  }
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await fs.stat(abs)).isDirectory()
  } catch {
    return false
  }
}

async function looksText(abs: string): Promise<boolean> {
  const ext = path.extname(abs).toLowerCase()
  if (!TEXT_EXT_ALLOW.has(ext)) return false
  try {
    const st = await fs.stat(abs)
    return st.size <= 2_000_000
  } catch {
    return false
  }
}

function globToRegExp(pattern: string): RegExp {
  let p = pattern.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!p) p = '**/*'
  let out = '^'
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    const n = p[i + 1]
    if (c === '*' && n === '*') {
      const after = p[i + 2]
      if (after === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  out += '$'
  return new RegExp(out)
}

async function listFiles(root: string, start = root): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string) {
    let entries: Array<import('node:fs').Dirent>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).replaceAll(path.sep, '/')
      if (entry.isDirectory()) {
        if (!skipRel(rel)) await walk(abs)
      } else if (entry.isFile()) {
        if (!skipRel(rel)) out.push(rel)
      }
    }
  }
  await walk(start)
  return out
}

async function readTool(
  root: string,
  args: Record<string, any>,
): Promise<string> {
  const rawPath = String(args.path || '')
  const { abs, rel, error, corrected, tried } = await resolveExistingSafe(
    root,
    rawPath,
  )
  if (error) return `ERR: ${error}`
  if (!(await exists(abs)))
    return `ERR: file not found: ${rawPath}. Tried: ${tried.join(', ') || '(none)'}. Use GLOB/GREP to discover valid relative paths.`
  if (!(await isFile(abs))) {
    if (await isDir(abs)) {
      const entries = (await fs.readdir(abs)).slice(0, 80).join('\n')
      return `ERR: ${rel || '.'} is a directory. Entries:\n${entries}`
    }
    return `ERR: not a regular file: ${rel}`
  }
  if (skipRel(rel) || !(await looksText(abs)))
    return `ERR: refused non-text/skipped file: ${rel}`
  const text = await fs.readFile(abs, 'utf8').catch((e) => String(e))
  const lines = text.split(/\r?\n/)
  const offset = Math.max(1, Number(args.offset || 1))
  const limit = Math.max(1, Math.min(Number(args.limit || 80), MAX_READ_LINES))
  const end = Math.min(lines.length, offset + limit - 1)
  const body = lines
    .slice(offset - 1, end)
    .map((line, idx) => `${offset + idx}:${line}`)
    .join('\n')
  let correction: string
  if (corrected) {
    correction = `\n[Path corrected from ${rawPath} to ${rel}]`
  } else {
    correction = ''
  }
  return truncate(
    `FILE ${rel} lines ${offset}-${end}/${lines.length}${correction}\n${body}`,
  )
}

async function globTool(
  root: string,
  args: Record<string, any>,
): Promise<string> {
  const raw = String(args.pattern || '')
  const patterns = relCandidates(raw, root).filter(Boolean)
  if (patterns.length === 0) return 'ERR: empty glob pattern'
  if (patterns.some((pattern) => pattern.split('/').includes('..')))
    return "ERR: glob pattern must not contain '..'"
  const allFiles = await listFiles(root)
  let matches: string[] = []
  let usedPattern = patterns[0]
  for (const pattern of patterns) {
    const rx = globToRegExp(pattern)
    matches = allFiles.filter((rel) => rx.test(rel)).sort()
    usedPattern = pattern
    if (matches.length > 0) break
  }
  if (matches.length === 0) {
    return `No files matched ${raw}. Tried: ${patterns.join(', ')}. Try broader patterns like '**/*.go', '**/*.ts', '**/*.h', or a keyword GREP.`
  }
  const shown = matches.slice(0, MAX_GLOB_RESULTS)
  let more: string
  if (matches.length > shown.length) {
    more = `\n... [${matches.length - shown.length} more]`
  } else {
    more = ''
  }
  let correction: string
  if (usedPattern !== patterns[0]) {
    correction = `[Pattern corrected from ${raw} to ${usedPattern}]\n`
  } else {
    correction = ''
  }
  return truncate(correction + shown.join('\n') + more)
}

async function grepTool(
  root: string,
  args: Record<string, any>,
): Promise<string> {
  const pattern = String(args.pattern || '')
  if (!pattern) return 'ERR: empty grep pattern'
  let rx: RegExp
  try {
    rx = new RegExp(pattern, 'i')
  } catch (e: any) {
    return `ERR: invalid regex ${pattern}: ${e.message}`
  }
  const { abs, rel, error, tried } = await resolveExistingSafe(
    root,
    String(args.path || ''),
  )
  if (error) return `ERR: ${error}`
  if (!(await exists(abs)))
    return `ERR: path not found: ${args.path || ''}. Tried: ${tried.join(', ') || '(none)'}. Use a relative repo path or omit path.`
  let files: string[] = []
  if (await isFile(abs))
    files = [path.relative(root, abs).replaceAll(path.sep, '/')]
  else files = await listFiles(root, abs)
  const results: string[] = []
  let scanned = 0
  for (const fileRel of files) {
    if (results.length >= MAX_GREP_RESULTS) break
    if (skipRel(fileRel)) continue
    const fileAbs = path.join(root, fileRel)
    if (!(await looksText(fileAbs))) continue
    scanned++
    let lines: string[]
    try {
      lines = (await fs.readFile(fileAbs, 'utf8')).split(/\r?\n/)
    } catch {
      continue
    }
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) {
        results.push(`${fileRel}:${i + 1}:${lines[i].trim().slice(0, 220)}`)
        if (results.length >= MAX_GREP_RESULTS) break
      }
    }
  }
  if (results.length === 0)
    return `No matches for ${pattern} in ${rel || 'repo root'} after scanning ${scanned} text files.`
  let more: string
  if (results.length >= MAX_GREP_RESULTS) {
    more = `\n... [stopped after ${MAX_GREP_RESULTS} matches]`
  } else {
    more = ''
  }
  return truncate(results.join('\n') + more)
}

async function execFcTool(root: string, call: ToolCall): Promise<string> {
  const name = call.name.toUpperCase()
  if (name === 'READ') return readTool(root, call.arguments)
  if (name === 'GLOB') return globTool(root, call.arguments)
  if (name === 'GREP') return grepTool(root, call.arguments)
  return `ERR: unknown tool ${call.name}; use READ, GLOB, or GREP`
}

function normalizeToolCalls(msg: any): ToolCall[] {
  const calls = msg?.tool_calls || []
  return calls.map((tc: any, idx: number) => {
    const fn = tc.function || {}
    let parsed: Record<string, any> = {}
    if (typeof fn.arguments === 'string') {
      try {
        if (fn.arguments.trim()) {
          parsed = JSON.parse(fn.arguments)
        } else {
          parsed = {}
        }
      } catch {
        parsed = { _parse_error: fn.arguments }
      }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      parsed = fn.arguments
    }
    return {
      id: tc.id || `call_${idx}`,
      name: String(fn.name || ''),
      arguments: parsed,
    }
  })
}

function extractFinal(content: string): { final: string; partial: boolean } {
  const m = content.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/i)
  if (m) return { final: m[1].trim(), partial: false }
  const open = content.match(/<final_answer>\s*([\s\S]*)/i)
  if (open) return { final: open[1].trim(), partial: true }
  return { final: '', partial: false }
}

const CITATION_RX =
  /(\/?(?:[A-Za-z0-9_.+@ -]+\/)*[A-Za-z0-9_.+@ -]+):(\d+)(?:-(\d+))?/g

async function normalizeFinalCitations(
  root: string,
  final: string,
): Promise<string> {
  const lines: string[] = []
  for (const line of final.split(/\r?\n/)) {
    const matches = [...line.matchAll(CITATION_RX)]
    let normalized = line
    for (const m of matches.reverse()) {
      const resolved = await resolveExistingSafe(root, m[1])
      if (resolved.error || !(await isFile(resolved.abs))) continue
      let lineSuffix: string
      if (m[3] !== undefined) {
        lineSuffix = `-${m[3]}`
      } else {
        lineSuffix = ''
      }
      const replacement = `${resolved.rel}:${m[2]}${lineSuffix}`
      const idx = m.index ?? 0
      normalized =
        normalized.slice(0, idx) +
        replacement +
        normalized.slice(idx + m[0].length)
    }
    lines.push(normalized)
  }
  return lines.join('\n')
}

async function filterInvalidCitationLines(
  root: string,
  final: string,
): Promise<{ final: string; dropped: number }> {
  const kept: string[] = []
  let dropped = 0
  for (const line of final
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    const citations = await validateCitations(root, line)
    if (
      citations.length === 0 ||
      citations.some((citation) => !citation.exists || !citation.inBounds)
    ) {
      dropped++
      continue
    }
    kept.push(line)
  }
  return { final: kept.join('\n'), dropped }
}

async function validateCitations(
  root: string,
  final: string,
): Promise<Citation[]> {
  const citations: Citation[] = []
  const rx = CITATION_RX
  for (const line of final.split(/\r?\n/)) {
    for (const m of line.matchAll(rx)) {
      const resolved = await resolveExistingSafe(root, m[1])
      const rel = resolved.rel
      const start = Number(m[2])
      const end = Number(m[3] || m[2])
      let fileExists = false
      let inBounds = false
      if (!resolved.error && (await isFile(resolved.abs))) {
        fileExists = true
        const n = (await fs.readFile(resolved.abs, 'utf8')).split(
          /\r?\n/,
        ).length
        inBounds = start >= 1 && end >= start && end <= n
      }
      citations.push({
        path: rel,
        start,
        end,
        line: line.trim(),
        exists: fileExists,
        inBounds,
      })
    }
  }
  const seen = new Set<string>()
  return citations.filter((c) => {
    const key = `${c.path}:${c.start}-${c.end}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function chat(
  baseUrl: string,
  model: string,
  messages: Message[],
  tools: any[] | undefined,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<any> {
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions'
  const body: Record<string, any> = {
    model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
  }
  if (tools) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer llama.cpp',
    },
    body: JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  if (!res.ok)
    throw new Error(`FastContext HTTP ${res.status}: ${text.slice(0, 1000)}`)
  return JSON.parse(text)
}

async function runFastContext(
  options: RunOptions,
): Promise<{ text: string; details: any }> {
  const root = path.resolve(options.cwd)
  if (!(await isDir(root)))
    throw new Error(`Repository path not found or not a directory: ${root}`)

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Repository root basename: ${path.basename(root)}\nQuery: ${options.query}`,
    },
  ]
  const transcript: any[] = []
  const errors: string[] = []
  const outputWarnings: string[] = []
  let toolCalls = 0
  let failedTools = 0
  let promptTokens = 0
  let completionTokens = 0
  let final = ''
  let partialFinal = false
  const start = Date.now()

  for (let turn = 1; turn <= options.maxTurns; turn++) {
    options.onUpdate?.({
      content: [
        {
          type: 'text',
          text: `FastContext turn ${turn}/${options.maxTurns}...`,
        },
      ],
    })
    const response = await chat(
      options.baseUrl,
      options.model,
      messages,
      fcTools,
      options.maxTokens,
      options.signal,
    )
    let transcriptEntry: typeof response | undefined
    if (options.includeTranscript) {
      transcriptEntry = response
    }
    transcript.push({
      turn,
      response: transcriptEntry,
    })
    const usage = response.usage || {}
    promptTokens += Number(usage.prompt_tokens || 0)
    completionTokens += Number(usage.completion_tokens || 0)
    const choice = response.choices?.[0] || {}
    const msg = choice.message || {}
    messages.push(msg)
    const extracted = extractFinal(String(msg.content || ''))
    if (extracted.final) {
      final = extracted.final
      partialFinal = extracted.partial
      break
    }
    const calls = normalizeToolCalls(msg)
    if (calls.length === 0) {
      errors.push(`turn ${turn}: no final_answer and no tool calls`)
      break
    }
    for (const call of calls) {
      toolCalls++
      let result: string
      if (call.arguments._parse_error) {
        failedTools++
        result = `ERR: invalid JSON tool arguments: ${String(call.arguments._parse_error).slice(0, 500)}`
      } else {
        result = await execFcTool(root, call)
        if (result.startsWith('ERR:')) failedTools++
      }
      let toolResultEntry: string
      if (options.includeTranscript) {
        toolResultEntry = result
      } else {
        toolResultEntry = result.slice(0, 500)
      }
      transcript.push({
        turn,
        tool: call,
        result: toolResultEntry,
      })
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }

  if (!final && options.forceFinal) {
    options.onUpdate?.({
      content: [{ type: 'text', text: 'FastContext forcing final answer...' }],
    })
    messages.push({
      role: 'user',
      content: `Tool budget exhausted. Do not call any more tools. Based only on the tool results above, produce the required <final_answer> now: at most ${MAX_FINAL_CITATIONS} lines, one relative file:START-END citation per line, reason <= 8 words, and always close </final_answer>.`,
    })
    const response = await chat(
      options.baseUrl,
      options.model,
      messages,
      undefined,
      options.maxTokens,
      options.signal,
    )
    let forceFinalEntry: typeof response | undefined
    if (options.includeTranscript) {
      forceFinalEntry = response
    }
    transcript.push({
      turn: 'force_final',
      response: forceFinalEntry,
    })
    const usage = response.usage || {}
    promptTokens += Number(usage.prompt_tokens || 0)
    completionTokens += Number(usage.completion_tokens || 0)
    const msg = response.choices?.[0]?.message || {}
    const extracted = extractFinal(String(msg.content || ''))
    final = extracted.final
    partialFinal = extracted.partial
    if (!final)
      errors.push(
        `force_final: no <final_answer>; content=${String(msg.content || '').slice(0, 300)}`,
      )
  }

  if (final) {
    final = await normalizeFinalCitations(root, final)
    const lines = final
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length > MAX_FINAL_CITATIONS) {
      final = lines.slice(0, MAX_FINAL_CITATIONS).join('\n')
      outputWarnings.push(
        `FastContext returned ${lines.length} final lines; truncated to first ${MAX_FINAL_CITATIONS} citations`,
      )
    }
    const filtered = await filterInvalidCitationLines(root, final)
    final = filtered.final
    if (filtered.dropped > 0) {
      outputWarnings.push(
        `Dropped ${filtered.dropped} invalid citation line(s)`,
      )
    }
  }

  const citations = await validateCitations(root, final)
  const valid = citations.filter((c) => c.exists && c.inBounds)
  const elapsedMs = Date.now() - start
  const warnings: string[] = [...outputWarnings]
  if (partialFinal)
    warnings.push(
      'final_answer tag was not closed; parsed partial final answer',
    )
  if (citations.length && valid.length !== citations.length)
    warnings.push(
      `${citations.length - valid.length}/${citations.length} citations failed validation`,
    )
  if (!final) warnings.push('no final answer produced')

  let finalBlock: string
  if (final) {
    finalBlock = `<final_answer>\n${final}\n</final_answer>`
  } else {
    finalBlock = `(no final answer)`
  }
  let text = [
    `# FastContext Result`,
    ``,
    finalBlock,
    ``,
    `## Validation`,
    `- Valid citations: ${valid.length}/${citations.length}`,
    `- Tool calls: ${toolCalls} (${failedTools} failed)`,
    `- Time: ${(elapsedMs / 1000).toFixed(1)}s`,
    `- Tokens: prompt ${promptTokens}, completion ${completionTokens}`,
  ]
    .filter(Boolean)
    .join('\n')

  if (warnings.length) {
    text += `\n## Warnings\n${warnings.map((w) => `- ${w}`).join('\n')}`
  }

  let transcriptOut: typeof transcript | undefined
  if (options.includeTranscript) {
    transcriptOut = transcript
  }

  return {
    text,
    details: {
      root,
      baseUrl: options.baseUrl,
      model: options.model,
      final,
      citations,
      validCitations: valid.length,
      toolCalls,
      failedTools,
      elapsedMs,
      promptTokens,
      completionTokens,
      warnings,
      transcript: transcriptOut,
    },
  }
}

export default function (pi: ExtensionAPI) {
  // Scaffold config.schema.json next to this file when missing.
  pi.on('session_start', async (event) => {
    if (event.reason !== 'startup') return
    const schemaPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'config.schema.json',
    )
    try {
      await fs.access(schemaPath)
    } catch {
      await fs.writeFile(
        schemaPath,
        JSON.stringify(FastContextConfigSchema, null, 2),
        'utf-8',
      )
    }
  })
  pi.registerTool({
    name: 'fast_context_search',
    label: 'FastContext Search',
    description:
      'Use local Microsoft FastContext via llama.cpp to do fast read-only codebase search. Returns compact file:line citations.',
    promptSnippet:
      'Fast read-only codebase search using local FastContext; returns file:line citations.',
    promptGuidelines: [
      'Use fast_context_search when you need quick repository context or file:line evidence before planning or editing.',
      'Do not use fast_context_search for implementation; it is read-only context retrieval.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'Natural-language code search/context query.',
      }),
      cwd: Type.Optional(
        Type.String({
          description: 'Repository root. Defaults to current Pi cwd.',
        }),
      ),
      baseUrl: Type.Optional(
        Type.String({
          description:
            'OpenAI-compatible FastContext base URL. Defaults to config/env or http://127.0.0.1:8772/v1.',
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            'FastContext model id. Defaults to config/env or FastContext-1.0-4B-RL-Q4_K_M.gguf.',
        }),
      ),
      maxTurns: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 8,
          description:
            'FastContext tool turns before forced finalization. Default 6.',
        }),
      ),
      maxTokens: Type.Optional(
        Type.Integer({
          minimum: 128,
          maximum: 4096,
          description:
            'Max tokens per FastContext model response. Default 1400.',
        }),
      ),
      includeTranscript: Type.Optional(
        Type.Boolean({
          description:
            'Include raw FastContext transcript in tool details. Default false.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = params.cwd || ctx.cwd
      const config = await resolveConfig(cwd, {
        baseUrl: params.baseUrl,
        model: params.model,
        maxTurns: params.maxTurns,
        maxTokens: params.maxTokens,
      })
      const result = await runFastContext({
        query: params.query,
        cwd,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTurns: config.maxTurns,
        maxTokens: config.maxTokens,
        forceFinal: true,
        includeTranscript: params.includeTranscript ?? false,
        signal,
        onUpdate,
      })
      return {
        content: [{ type: 'text', text: result.text }],
        details: result.details,
      }
    },
  })

  pi.registerCommand('fastcontext', {
    description: 'Run local FastContext search in the current repository',
    handler: async (args, ctx) => {
      const query = args.trim()
      if (!query) {
        ctx.ui.notify('Usage: /fastcontext <code search query>', 'warning')
        return
      }
      const config = await resolveConfig(ctx.cwd)
      const result = await runFastContext({
        query,
        cwd: ctx.cwd,
        baseUrl: config.baseUrl,
        model: config.model,
        maxTurns: config.maxTurns,
        maxTokens: config.maxTokens,
        forceFinal: true,
        includeTranscript: false,
        signal: ctx.signal,
      })
      ctx.ui.notify(result.text, 'info')
    },
  })
}
