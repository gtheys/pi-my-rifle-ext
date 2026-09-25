/**
 * Tool Pills + Diff Renderer — combined extension.
 *
 * • ls, read, find, grep, bash → colored pill labels + collapsed output
 * • write, edit → Shiki-powered syntax-highlighted diffs (from pi-diff)
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  Theme,
} from '@earendil-works/pi-coding-agent'
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  highlightCode,
  keyHint,
} from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { registerDiffTools } from './diff-renderer.ts'
import {
  buildGlobPattern,
  FffService,
  fffFormatGrepText,
  isLikelyGlobPattern,
} from './fff.ts'
import { iconizePaths, renderTree } from './icons.ts'
import { pill } from './pill.ts'

/** Max lines shown in collapsed (non-expanded) result view */
const COLLAPSED_MAX_LINES = 15

/** Superset of param fields read across the basic tools (ls/read/find/grep/bash). */
type BasicToolArgs = {
  path?: string
  pattern?: string
  glob?: string
  offset?: number
  limit?: number
  command?: string
}

/** Extract the first text content from a tool result */
function getText(result: AgentToolResult<unknown>): string | undefined {
  const c = result.content.find((c) => c.type === 'text')
  if (c?.type === 'text') {
    return c.text
  }
  return undefined
}

/**
 * Render tool output text with collapsed truncation + expand hint.
 */
function renderTextResult(
  text: string | undefined,
  expanded: boolean,
  theme: Theme,
  mode: 'head' | 'tail' = 'head',
  transform?: (text: string, theme: Theme) => string,
): Text {
  if (!text?.trim()) return new Text('', 0, 0)

  const lines = text.split('\n')
  // AIDEV-NOTE: transformed lines carry their own colors (icons/tree) with
  // 39m/22m resets so pi's Box background survives — don't re-wrap them.
  const decorate = (ls: string[]) => {
    if (transform) return transform(ls.join('\n'), theme)
    return ls.map((l) => theme.fg('toolOutput', l)).join('\n')
  }

  if (expanded || lines.length <= COLLAPSED_MAX_LINES) {
    return new Text(`\n${decorate(lines)}`, 0, 0)
  }

  const hidden = lines.length - COLLAPSED_MAX_LINES
  const hint = theme.fg(
    'dim',
    `… ${hidden} more lines (${keyHint('app.tools.expand', 'to expand')})`,
  )

  if (mode === 'tail') {
    const visible = lines.slice(-COLLAPSED_MAX_LINES)
    return new Text(`\n${hint}\n${decorate(visible)}`, 0, 0)
  }

  const visible = lines.slice(0, COLLAPSED_MAX_LINES)
  return new Text(`\n${decorate(visible)}\n${hint}`, 0, 0)
}

/** Helper to register a basic tool (ls, read, find, grep) with pill + collapsed output. */
function wrapBasicTool(
  pi: ExtensionAPI,
  // biome-ignore lint/suspicious/noExplicitAny: Pi's ToolDefinition<TParams,...> is invariant in TParams, so no single non-`any` type accepts all of ls/read/find/grep/bash defs.
  orig: any,
  name: string,
  mkCallText: (args: BasicToolArgs, theme: Theme) => string,
  mode: 'head' | 'tail' = 'head',
  transform?: (text: string, theme: Theme) => string,
) {
  pi.registerTool({
    ...orig,
    parameters: { ...orig.parameters },
    renderCall(args: unknown, theme: Theme, _ctx: unknown) {
      const a = args as BasicToolArgs
      return new Text(`${pill(name, theme)} ${mkCallText(a, theme)}`, 0, 0)
    },
    renderResult(
      result: AgentToolResult<unknown>,
      { expanded }: { expanded: boolean },
      theme: Theme,
      _ctx: unknown,
    ) {
      return renderTextResult(getText(result), expanded, theme, mode, transform)
    },
  })
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd()

  // AIDEV-NOTE: FFF accelerates find/grep; on any failure tools fall back to SDK execute.
  const fff = new FffService()
  pi.on('session_start', async (_event, ctx) => {
    await fff.init(ctx.cwd)
    if (fff.partialIndex) {
      ctx.ui?.notify?.('FFF: scan timed out — using partial index', 'warning')
    }
  })
  pi.on('session_shutdown', async () => {
    fff.destroy()
  })

  // ls — icons + tree rendering
  wrapBasicTool(
    pi,
    createLsToolDefinition(cwd),
    'ls',
    (args, theme) => theme.fg('accent', args.path || '.'),
    'head',
    (text, theme) => renderTree(text, (s) => theme.fg('toolOutput', s)),
  )

  // read
  wrapBasicTool(pi, createReadToolDefinition(cwd), 'read', (args, theme) => {
    let t = theme.fg('accent', args.path ?? '')
    if (args.offset || args.limit) {
      const parts: string[] = []
      if (args.offset) parts.push(`L${args.offset}`)
      if (args.limit) parts.push(`${args.limit}L`)
      t += theme.fg('dim', ` ${parts.join(', ')}`)
    }
    return t
  })

  // find — FFF glob with SDK fallback, icons on paths
  const origFind = createFindToolDefinition(cwd)
  wrapBasicTool(
    pi,
    {
      ...origFind,
      async execute(
        tid: string,
        params: BasicToolArgs & { limit?: number },
        sig: AbortSignal | undefined,
        _upd: unknown,
        ctx: unknown,
      ) {
        const pattern = String(params.pattern ?? '')
        if (fff.isAvailable && fff.finder) {
          try {
            const limit = Math.max(
              1,
              typeof params.limit === 'number' ? params.limit : 100,
            )
            const basePathResult = fff.finder.getBasePath()
            const basePath = basePathResult.ok ? basePathResult.value : null
            const search = fff.finder.glob(
              buildGlobPattern(pattern, params.path, basePath),
              { pageSize: limit },
            )
            if (search.ok) {
              const items = search.value.items.slice(0, limit)
              // Glob-ish pattern with empty FFF result: suspicious, retry via SDK (fd)
              if (items.length > 0 || !isLikelyGlobPattern(pattern)) {
                const paths = items.map((i) => i.relativePath).join('\n')
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: paths || 'No files found matching pattern',
                    },
                  ],
                }
              }
            }
          } catch {
            // fall through to SDK
          }
        }
        return origFind.execute(
          tid,
          params as never,
          sig,
          undefined,
          ctx as never,
        )
      },
    },
    'find',
    (args, theme) => {
      let t = theme.fg('accent', `"${args.pattern}"`)
      if (args.path) t += theme.fg('dim', ` in ${args.path}`)
      return t
    },
    'head',
    (text, theme) => iconizePaths(text, (s) => theme.fg('toolOutput', s)),
  )

  // grep — FFF grep with SDK fallback (FFF has smart-case only, no path/glob scoping)
  const origGrep = createGrepToolDefinition(cwd)
  wrapBasicTool(
    pi,
    {
      ...origGrep,
      async execute(
        tid: string,
        params: BasicToolArgs & {
          context?: number
          limit?: number
          literal?: boolean
          ignoreCase?: boolean
        },
        sig: AbortSignal | undefined,
        _upd: unknown,
        ctx: unknown,
      ) {
        const pattern = String(params.pattern ?? '')
        if (
          fff.isAvailable &&
          fff.finder &&
          !params.path &&
          !params.glob &&
          params.ignoreCase !== true
        ) {
          try {
            const limit = Math.max(
              1,
              typeof params.limit === 'number' ? params.limit : 200,
            )
            const context =
              typeof params.context === 'number' ? params.context : 0
            const grepResult = fff.finder.grep(pattern, {
              pageSize: limit,
              mode: params.literal === true ? 'plain' : 'regex',
              smartCase: false,
              beforeContext: context,
              afterContext: context,
            })
            if (grepResult.ok) {
              const items = grepResult.value.items.slice(0, limit)
              let text = fffFormatGrepText(items, limit)
              if (grepResult.value.regexFallbackError) {
                text += `\n\n[Regex failed: ${grepResult.value.regexFallbackError}, used literal match]`
              }
              return { content: [{ type: 'text' as const, text }] }
            }
          } catch {
            // fall through to SDK
          }
        }
        return origGrep.execute(
          tid,
          params as never,
          sig,
          undefined,
          ctx as never,
        )
      },
    },
    'grep',
    (args, theme) => {
      let t = theme.fg('accent', `"${args.pattern}"`)
      if (args.path) t += theme.fg('dim', ` in ${args.path}`)
      if (args.glob) t += theme.fg('dim', ` ${args.glob}`)
      return t
    },
  )

  // bash — special: syntax-highlighted command, tail mode
  const origBash = createBashToolDefinition(cwd)
  pi.registerTool({
    ...origBash,
    parameters: { ...origBash.parameters },
    renderCall(args: unknown, theme: Theme, _ctx: unknown) {
      const cmd = (args as BasicToolArgs).command ?? ''
      const highlighted = highlightCode(cmd, 'bash').join('\n')
      const isMultiLine = cmd.includes('\n') || cmd.length > 80
      if (isMultiLine) {
        return new Text(`${pill('bash', theme)}\n${highlighted}`, 0, 0)
      }
      return new Text(`${pill('bash', theme)} ${highlighted}`, 0, 0)
    },
    renderResult(
      result: AgentToolResult<unknown>,
      { expanded }: { expanded: boolean },
      theme: Theme,
      _ctx: unknown,
    ) {
      return renderTextResult(getText(result), expanded, theme, 'tail')
    },
  })

  // write + edit — diff renderer with pills, expand/collapse, fallbacks
  registerDiffTools(pi)
}
