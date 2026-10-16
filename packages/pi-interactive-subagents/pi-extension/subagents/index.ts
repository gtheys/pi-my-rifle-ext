import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent'
import { keyHint } from '@mariozechner/pi-coding-agent'
import { Box, Text, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui'
import { type Static, Type } from '@sinclair/typebox'
import {
  type ActivityReadResult,
  getSubagentActivityFile,
  readSubagentActivityFile,
  type SubagentActivityState,
} from './activity.ts'
import {
  askIdentityMatches,
  readAskRecord,
  readAskSidecar,
  removeAskRecord,
  removeAskRecordsForSession,
  removeAskSidecar,
  removeReplyRecord,
  writeReplyRecord,
} from './asks.ts'
import {
  type AssignmentRecord,
  type AssignmentStatus,
  assignmentPath,
  listAssignments,
  pidAlive,
  recordAssignmentUsage,
  removeAssignment,
  updateAssignmentStatus,
  writeAssignment,
} from './assignments.ts'
import { loadSubagentsConfig, type SubagentsConfig } from './config.ts'
import {
  ackMatches,
  type ControlAck,
  type ControlRecord,
  readAckSidecar,
  readControlRecord,
  removeAckSidecar,
  removeControlRecord,
  writeControlRecord,
} from './control.ts'
import { hasDelivered, markDelivered } from './delivered.ts'
import { herdrAgentFocus, herdrAgentGet, herdrPreflight } from './herdr.ts'
import {
  coalesceOwnerMessages,
  readOwnerInbox,
  removeOwnerMessage,
} from './inbox.ts'
import { sendPeerMessage } from './peers.ts'
import {
  retireSettledSubagentPayloads,
  shouldArmRetirement,
} from './retirement.ts'
import {
  findLastAssistantMessage,
  getNewEntries,
  seedSubagentSessionFile,
} from './session.ts'
import {
  canFocusAgent,
  type HerdrSpawnedTab,
  herdrAgentStart,
  herdrTabClose,
  herdrTabCreate,
  herdrTabList,
  pickRollbackTabs,
  waitShellReady,
} from './spawn.ts'
import { allocateSpawnIdentity } from './spawnseq.ts'
import {
  advanceStatusState,
  applyPendingAck,
  capStatusLines,
  classifyStatus,
  createStatusState,
  DEFAULT_STATUS_LINE_LIMIT,
  expirePendingRequest,
  forceStatusAfterInterrupt,
  formatElapsedDuration,
  formatStatusAggregate,
  formatTransitionLine,
  INTERRUPT_ACK_TIMEOUT_MS,
  markPendingRequest,
  observeStatus,
  type StatusConfig,
  type StatusSnapshot,
  type SubagentStatusState,
} from './status.ts'
import {
  allocateSemanticRef,
  type ResultRefBinding,
  writeResultRecord,
} from './store.ts'
import {
  closeSurface,
  isMuxAvailable,
  muxSetupHint,
  pollForExit,
  readScreen,
  sendEscape,
  shellEscape,
} from './surface.ts'
import {
  createSessionUsageTracker,
  createUsageSummary,
  formatUsageCompact,
  readSessionParentFile,
  readSessionUsage,
  rollupUsageByOwnership,
  type SessionUsageTracker,
  totalTokens,
  type UsageOwnershipNode,
  type UsageRollup,
  type UsageSummary,
  type UsageTotals,
  updateSessionUsageTracker,
} from './usage.ts'
import {
  createSubagentWorktree,
  deriveWorktreeBranch,
  type WorktreeOption,
} from './worktrees.ts'

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url))

const JIRA_ID_RE = /^[A-Z][A-Z0-9]+-\d+\b/

// AIDEV-NOTE: /plan dispatch — aven-first. Jira-shaped args and free text
// both run the feature-plan-aven skill (the aven planner handles aven refs,
// aven-synced Jira IDs, and local features; the aven workspace is routed by
// cwd). When the repo skills directory is unavailable (standalone npm
// install, file read fails) the handler falls back to the bundled generic
// plan-skill.md.
export function classifyPlanArg(task: string): 'aven' {
  void task
  return 'aven'
}

export function readPlanSkill(
  name: string,
): { path: string; content: string } | null {
  const p = join(
    SUBAGENTS_DIR,
    '../../../../skills/engineering',
    `${name}/SKILL.md`,
  )
  try {
    return { path: p, content: readFileSync(p, 'utf8') }
  } catch {
    return null
  }
}

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for('pi-subagents/widget-interval')
const STATUS_INTERVAL_KEY = Symbol.for('pi-subagents/status-interval')
const POLL_ABORT_KEY = Symbol.for('pi-subagents/poll-abort-controller')
const RUNNING_KEY = Symbol.for('pi-subagents/running')
const RELOAD_SENTINEL = 'pi-subagents/module-reload'

// AIDEV-NOTE: shared via globalThis so an extension /reload (module
// re-import) keeps running entries + panes alive; the new module instance
// re-attaches watchers in subagentsExtension().
const runningSubagents: Map<string, RunningSubagent> = ((globalThis as any)[
  RUNNING_KEY
] ??= new Map<string, RunningSubagent>())

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY]
  if (prevInterval) {
    clearInterval(prevInterval)
    ;(globalThis as any)[WIDGET_INTERVAL_KEY] = null
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY]
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval)
    ;(globalThis as any)[STATUS_INTERVAL_KEY] = null
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as
    | AbortController
    | undefined
  if (prevAbort) {
    prevAbort.abort()
    // Orphan live watchers; subagentsExtension() re-attaches them with the
    // fresh pi/ctx from this module load.
    for (const r of runningSubagents.values()) r.watching = false
  }
  ;(globalThis as any)[POLL_ABORT_KEY] = new AbortController()
}

function getModuleAbortSignal(): AbortSignal {
  // AIDEV-NOTE: session_shutdown aborts the controller but never replaces it,
  // and Bun's module cache means a /reload may not re-run the top-level reset
  // block. Without this guard every watcher spawned after such a shutdown
  // aborts instantly with "Aborted while waiting for subagent to finish".
  let controller = (globalThis as any)[POLL_ABORT_KEY] as
    | AbortController
    | undefined
  if (!controller || controller.signal.aborted) {
    controller = new AbortController()
    ;(globalThis as any)[POLL_ABORT_KEY] = controller
  }
  return controller.signal
}

const SubagentParams = Type.Object({
  name: Type.String({ description: 'Display name for the subagent' }),
  task: Type.String({ description: 'Task/prompt for the sub-agent' }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description: 'Appended to system prompt (role instructions)',
    }),
  ),
  model: Type.Optional(
    Type.String({ description: 'Model override (overrides agent default)' }),
  ),
  skills: Type.Optional(
    Type.String({
      description: 'Comma-separated skills (overrides agent default)',
    }),
  ),
  tools: Type.Optional(
    Type.String({
      description: 'Comma-separated tools (overrides agent default)',
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        'Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.',
    }),
  ),
  worktree: Type.Optional(
    Type.Union(
      [Type.Boolean(), Type.Object({ base: Type.Optional(Type.String()) })],
      {
        description:
          'Create an isolated git worktree and run the sub-agent with cwd set to it (mutually exclusive with cwd). `true` branches from the current HEAD; `{base}` branches from the given ref. A failed `git worktree add` aborts the call — no tab is spawned. The worktree outlives the child; removal is manual (git worktree remove), never automatic.',
      },
    ),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        'Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.',
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        'Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use this to retry cancelled runs or ask follow-up questions.',
    }),
  ),
})

export type SubagentInput = Static<typeof SubagentParams>

type SubagentSessionMode = 'standalone' | 'lineage-only' | 'fork'

// AIDEV-NOTE (PMR-RKH5): `spawning` is an enum, not a plain boolean —
// true | false | 'manager-approval'. Absent = today's default behavior.
type SpawningPolicy = boolean | 'manager-approval'

interface AgentDefaults {
  model?: string
  tools?: string
  skills?: string
  thinking?: string
  denyTools?: string
  spawning?: SpawningPolicy
  autoExit?: boolean
  interactive?: boolean
  systemPromptMode?: 'append' | 'replace'
  sessionMode?: SubagentSessionMode
  cwd?: string
  cli?: string
  body?: string
  disableModelInvocation?: boolean
}

type AgentSource = 'package' | 'global' | 'project'

interface AgentDefinition extends AgentDefaults {
  name: string
  description?: string
  disableModelInvocation: boolean
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  'subagent',
  'subagent_interrupt',
  'subagents_list',
  'subagent_resume',
])

/**
 * Child-side infrastructure tools that can never be excluded — not via
 * `spawning: false`, not via `deny-tools`. Children need them to report
 * completion and to ask their owner questions (PMR-WXG0).
 */
const INFRASTRUCTURE_CHILD_TOOLS = new Set([
  'caller_ping',
  'subagent_done',
  'ask_owner',
  'message_owner',
  'list_peers',
  'message_peer',
])

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>()
  if (!agentDefs) return denied

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t)
  }

  // deny-tools: explicit list (infrastructure child tools are never deniable)
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      if (INFRASTRUCTURE_CHILD_TOOLS.has(t)) continue
      denied.add(t)
    }
  }

  return denied
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, '../../agents')
}

function getFrontmatterValue(
  frontmatter: string,
  key: string,
): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return match ? match[1].trim() : undefined
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === 'true' : undefined
}

// AIDEV-NOTE (PMR-RKH5): invalid `spawning` values reject the whole agent
// definition file with a clear error (fail loud — herdsman allowlist-gating
// discipline), instead of silently falling back to the ungoverned default.
function parseSpawning(
  value: string | undefined,
  agentName: string,
): SpawningPolicy | undefined {
  if (value == null) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'manager-approval') return 'manager-approval'
  throw new Error(
    `Agent "${agentName}": invalid spawning value "${value}" — expected true, false, or "manager-approval". Fix the agent definition file.`,
  )
}

// AIDEV-NOTE (PMR-RKH5): `spawning: manager-approval` — model-invoked
// subagent() calls are denied with instructions; the user running
// `/subagent <agent> <task>` IS the approval (herdsman has no approval
// mode — do not invent mid-tool confirmation).
function managerApprovalDenial(
  agentDefs: AgentDefaults | null,
  agentName: string | undefined,
): string | null {
  if (!agentDefs || agentDefs.spawning !== 'manager-approval') return null
  const name = agentName ?? 'unnamed'
  return (
    `Spawning agent "${name}" requires user approval (spawning: manager-approval). ` +
    `Do not retry this tool call — ask the user to run: /subagent ${name} <task>`
  )
}

function parseSessionMode(
  value: string | undefined,
): SubagentSessionMode | undefined {
  if (value === 'standalone' || value === 'lineage-only' || value === 'fork') {
    return value
  }
  return undefined
}

function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  const frontmatter = match[1]
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim()
  const systemPromptMode = getFrontmatterValue(frontmatter, 'system-prompt')

  return {
    name: getFrontmatterValue(frontmatter, 'name') ?? fallbackName,
    description: getFrontmatterValue(frontmatter, 'description'),
    model: getFrontmatterValue(frontmatter, 'model'),
    tools: getFrontmatterValue(frontmatter, 'tools'),
    systemPromptMode:
      systemPromptMode === 'replace'
        ? 'replace'
        : systemPromptMode === 'append'
          ? 'append'
          : undefined,
    skills:
      getFrontmatterValue(frontmatter, 'skill') ??
      getFrontmatterValue(frontmatter, 'skills'),
    thinking: getFrontmatterValue(frontmatter, 'thinking'),
    denyTools: getFrontmatterValue(frontmatter, 'deny-tools'),
    spawning: parseSpawning(
      getFrontmatterValue(frontmatter, 'spawning'),
      fallbackName,
    ),
    autoExit: parseOptionalBoolean(
      getFrontmatterValue(frontmatter, 'auto-exit'),
    ),
    interactive: parseOptionalBoolean(
      getFrontmatterValue(frontmatter, 'interactive'),
    ),
    sessionMode: parseSessionMode(
      getFrontmatterValue(frontmatter, 'session-mode'),
    ),
    cwd: getFrontmatterValue(frontmatter, 'cwd'),
    cli: getFrontmatterValue(frontmatter, 'cli'),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(
        frontmatter,
        'disable-model-invocation',
      )?.toLowerCase() === 'true',
  }
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>()
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: 'package' },
    { path: join(getAgentConfigDir(), 'agents'), source: 'global' },
    { path: join(process.cwd(), '.pi', 'agents'), source: 'project' },
  ]

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((entry) =>
      entry.endsWith('.md'),
    )) {
      let parsed: AgentDefinition | null = null
      try {
        parsed = parseAgentDefinition(
          readFileSync(join(dir, file), 'utf8'),
          file.replace(/\.md$/, ''),
        )
      } catch (err) {
        // Rejected definition (e.g. invalid `spawning:` enum) — warn and
        // skip the file; one bad agent must not break listing the rest.
        const message = err instanceof Error ? err.message : String(err)
        console.warn(
          `[pi-subagents] rejecting agent definition ${join(dir, file)}: ${message}`,
        )
        continue
      }
      if (!parsed) continue
      agents.set(parsed.name, { ...parsed, source })
    }
  }

  return [...agents.values()]
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  effectiveCwd: string | null
  localAgentDir: string | null
  effectiveAgentDir: string
} {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd()
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith('/')
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null
  const localAgentDir = effectiveCwd ? join(effectiveCwd, '.pi', 'agent') : null
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : getAgentConfigDir()
  return { effectiveCwd, localAgentDir, effectiveAgentDir }
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  const sessionDir = join(agentDir, 'sessions', safePath)
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true })
  }
  return sessionDir
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return 'fork'
  return agentDefs?.sessionMode ?? 'standalone'
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode
  seededSessionMode: 'lineage-only' | 'fork' | null
  inheritsConversationContext: boolean
  taskDelivery: 'direct' | 'artifact'
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs)
  const inheritsConversationContext = sessionMode === 'fork'
  return {
    sessionMode,
    seededSessionMode: sessionMode === 'standalone' ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? 'direct' : 'artifact',
  }
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call,
 * typical for `/iterate` with `fork: true`), `autoExit` is undefined and the
 * subagent is treated as interactive — matching the intent of iterate.
 */
function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive
  if (agentDefs?.interactive != null) return agentDefs.interactive
  return !(agentDefs?.autoExit ?? false)
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir()
  const paths = [
    join(process.cwd(), '.pi', 'agents', `${agentName}.md`),
    join(configDir, 'agents', `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ]

  for (const p of paths) {
    if (!existsSync(p)) continue
    const parsed = parseAgentDefinition(readFileSync(p, 'utf8'), agentName)
    if (parsed) return parsed
  }

  return null
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: 'mux not available' },
  }
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, 'artifacts', sessionId)
}

// AIDEV-NOTE: status config moved to the extension-owned config file
// (<agentDir>/pi-subagents/config.json, project override in CONFIG_DIR_NAME).
// loadStatusConfig in status.ts and config.json.example are superseded.
const STATUS_CONFIG_KEY = Symbol.for('pi-subagents/status-config')
const DEFAULT_STATUS_CONFIG: StatusConfig = {
  enabled: true,
  lineLimit: DEFAULT_STATUS_LINE_LIMIT,
}

function getStatusConfig(): StatusConfig {
  const stored = (globalThis as Record<symbol, unknown>)[STATUS_CONFIG_KEY]
  if (stored !== undefined) return stored as StatusConfig
  return DEFAULT_STATUS_CONFIG
}

// AIDEV-NOTE (PMR-1EC3): context-retirement state lives on globalThis so an
// extension /reload keeps it (new module instance, same session). Armed by
// the first automatic compaction pressure signal; from then on the context
// hook retires settled subagent payloads per provider request.
const RETIREMENT_ENABLED_KEY = Symbol.for('pi-subagents/retirement-enabled')
const RETIREMENT_ARMED_KEY = Symbol.for('pi-subagents/retirement-armed')

function getRetirementEnabled(): boolean {
  return (
    (globalThis as Record<symbol, unknown>)[RETIREMENT_ENABLED_KEY] === true
  )
}

function isRetirementArmed(): boolean {
  return (globalThis as Record<symbol, unknown>)[RETIREMENT_ARMED_KEY] === true
}

function loadAndCacheStatusConfig(cwd: string | undefined): StatusConfig {
  const loaded = loadSubagentsConfig(cwd)
  const config: StatusConfig = {
    enabled: loaded.config.status.enabled,
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
  }
  ;(globalThis as Record<symbol, unknown>)[STATUS_CONFIG_KEY] = config
  ;(globalThis as Record<symbol, unknown>)[RETIREMENT_ENABLED_KEY] =
    loaded.config.contextRetirement?.enabled === true
  return config
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    'exitCode' | 'elapsed' | 'summary' | 'sessionFile' | 'errorMessage'
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : ''

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    )
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`
}

/**
 * Result from running a single subagent.
 */
export interface SubagentResult {
  name: string
  task: string
  summary: string
  sessionFile?: string
  claudeSessionId?: string
  exitCode: number
  elapsed: number
  error?: string
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string
  ping?: { name: string; message: string }
  /** Session-accumulated token/cost totals (PMR-874G); absent when the
   * session's usage was unavailable — never a guessed zero. */
  usage?: UsageTotals
}

/**
 * State for a launched (but not yet completed) subagent.
 */
export interface RunningSubagent {
  id: string
  name: string
  task: string
  agent?: string
  surface: string
  /** Herdr ids for focus verification (PMR-TABUX display metadata). */
  paneId?: string
  tabId?: string
  workspaceId?: string
  /** True between entry registration and a successful `agent start`. */
  starting?: boolean
  startTime: number
  sessionFile: string
  activityFile?: string
  activity?: SubagentActivityState
  activityRead?: {
    ok: boolean
    reason?: 'missing' | 'invalid' | 'wrong-id'
    error?: string
  }
  abortController?: AbortController
  cli?: string
  sentinelFile?: string
  /** askId of the last ask we steered to the parent (dedupe, PMR-WXG0). */
  notifiedAskId?: string
  statusState: SubagentStatusState
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean
  /** True while a watcher from the current module load is polling this entry. */
  watching?: boolean
  /** Resume flow: entry count in sessionFile before resume — new-only summary extraction. */
  resumeEntryCount?: number
  /** Worktree placement (PMR-11TD): absolute worktree path + its branch.
   * Outlives the child; removal is manual (no auto-delete ever). */
  worktree?: string
  branch?: string
  /** Last status persisted to the durable assignment record (PMR-Z5KR) —
   * transition writes happen only on change. */
  assignmentStatus?: AssignmentStatus
  /** Live usage accounting (PMR-874G): the 1s status loop advances the
   * incremental tracker over the child session jsonl; `usage` is the
   * display-ready summary the widget row reads. */
  usage?: UsageSummary
  usageTracker?: SessionUsageTracker
}

/** All currently running subagents, keyed by id — shared via globalThis (see RUNNING_KEY). */

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null
let latestPi: ExtensionAPI | null = null

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null

/** Parent session id — owner-inbox routing key (PMR-QCVA). Set on session_start. */
let ownerSessionId: string | null = null

// ── Status widget (herdsman row pattern, PMR-TABUX) ──
//
// Per-agent row: state marker + label + status + elapsed. A 2s presentation
// tick inside the component calls tui.requestRender() so elapsed time moves
// WITHOUT new activity snapshots. Click-to-open: render() records HitRegions;
// handleMouse() matches left-clicks and re-verifies herdr identity before any
// `agent focus` — a stale click is inert (never focuses the wrong pane).

/** Visible widget rows before the `… N more` overflow line. */
const WIDGET_ROW_CAP = 6

export type WidgetStateKind =
  | 'working'
  | 'blocked'
  | 'starting'
  | 'waiting'
  | 'stalled'
  | 'lost'

/** Herdsman's state markers. */
export function markerFor(kind: WidgetStateKind): string {
  if (kind === 'working') return '●'
  if (kind === 'blocked') return '◐'
  if (kind === 'starting') return '◌'
  if (kind === 'waiting') return '○'
  if (kind === 'lost') return '×'
  return '?'
}

/** Map a running entry (+ its latest status snapshot) to a widget state. Pure. */
export function statusKindOf(
  running: Pick<RunningSubagent, 'starting' | 'statusState'>,
  now: number,
): WidgetStateKind {
  if (running.starting) return 'starting'
  const kind = classifyStatus(running.statusState, now).kind
  if (kind === 'blocked') return 'blocked'
  if (kind === 'stalled') return 'stalled'
  if (kind === 'waiting') return 'waiting'
  if (kind === 'starting') return 'starting'
  return 'working'
}

/**
 * Per-assignment usage suffix for subagents_list (PMR-874G): self totals,
 * `tree:` totals when descendants add more, and an explicit coverage flag
 * when any node in the subtree lacked usage data. Pure — exported for tests.
 */
export function usageSuffixFor(
  node: UsageOwnershipNode,
  rollups: Map<string, UsageRollup>,
): string {
  const rollup = rollups.get(node.childId)
  if (!node.summary || !rollup) return ' · usage unavailable'
  let suffix = ''
  if (node.summary.sawUsage) {
    suffix = ` · ${formatUsageCompact(node.summary.totals)}`
  }
  const descendantsAdd =
    totalTokens(rollup.totals) > totalTokens(node.summary.totals) ||
    rollup.totals.cost > node.summary.totals.cost
  if (descendantsAdd) {
    suffix += ` (tree: ${formatUsageCompact(rollup.totals)})`
  }
  if (rollup.incomplete) {
    suffix += ' (coverage incomplete)'
  }
  return suffix
}

/** A clickable region of a rendered row. `from`/`to` are visible columns. */
export interface HitRegion {
  row: number
  from: number
  to: number
  childId: string
}

/** Match a left-click against the regions recorded by the last render. Pure. */
export function matchHitRegion(
  regions: readonly HitRegion[],
  event: { x: number; y: number; width: number },
  renderWidth: number,
): HitRegion | null {
  if (event.width !== renderWidth) return null
  for (const region of regions) {
    if (
      region.row === event.y &&
      region.from <= event.x &&
      event.x < region.to
    ) {
      return region
    }
  }
  return null
}

/** Compose one row: `● label · status elapsed`. Returns line + label span. Pure. */
function formatAgentRow(
  running: RunningSubagent,
  now: number,
): { line: string; labelFrom: number; labelTo: number } {
  const kind = statusKindOf(running, now)
  const marker = markerFor(kind)
  const label = running.name
  // AIDEV-NOTE: show the live activity detail (`active (bash 12s)`) instead of
  // the bare kind when the child's snapshot carries one — herdsman's rows do
  // the same, and it keeps long-tool-call work visible vs. stall silence.
  let status: string = kind
  if (
    kind === 'working' &&
    running.statusState?.activityLabel &&
    running.statusState.activeSinceMs !== null &&
    running.statusState.activeSinceMs !== undefined
  ) {
    const dur = formatElapsedDuration(now - running.statusState.activeSinceMs)
    status = `active (${running.statusState.activityLabel} ${dur})`
  }
  const elapsed = formatElapsed(Math.floor((now - running.startTime) / 1000))
  const labelFrom = visibleWidth(`${marker} `)
  const labelTo = labelFrom + visibleWidth(label)
  // PMR-874G: one-liner usage suffix, only when real usage blocks were seen
  // (coverage discipline — never an invented zero).
  let usagePart = ''
  if (running.usage?.sawUsage) {
    usagePart = ` · ${formatUsageCompact(running.usage.totals)}`
  }
  const line = truncateToWidth(
    `${marker} ${label} · ${status} ${elapsed}${usagePart}`,
    Number.MAX_SAFE_INTEGER,
  )
  return { line, labelFrom, labelTo }
}

/**
 * Render the supervision widget: header + capped agent rows. Pure — exported
 * for tests. Snapshot failure on any agent ⇒ `stale` in the header, last
 * snapshot still shown.
 */
export function renderSupervisionRows(
  agents: readonly RunningSubagent[],
  now: number,
): { lines: string[]; hits: HitRegion[] } {
  const ordered = [...agents].sort((a, b) => a.startTime - b.startTime)

  const blocked = ordered.filter(
    (a) => statusKindOf(a, now) === 'blocked',
  ).length
  const stalled = ordered.filter(
    (a) =>
      statusKindOf(a, now) === 'stalled' || statusKindOf(a, now) === 'lost',
  ).length
  const stale = ordered.some((a) => a.activityRead && !a.activityRead.ok)

  let header = `Subagents · ${ordered.length} running`
  if (blocked > 0) header += ` · ${blocked} blocked`
  if (stalled > 0) header += ` · ${stalled} attention`
  if (stale) header += ' · stale'
  // PMR-874G: header aggregate of the direct children's live usage (same
  // cached summaries the rows show — no extra file IO in render).
  const aggregate = createUsageSummary()
  for (const agent of ordered) {
    if (!agent.usage?.sawUsage) continue
    aggregate.sawUsage = true
    aggregate.totals.input += agent.usage.totals.input
    aggregate.totals.output += agent.usage.totals.output
    aggregate.totals.cacheRead += agent.usage.totals.cacheRead
    aggregate.totals.cacheWrite += agent.usage.totals.cacheWrite
    aggregate.totals.cost += agent.usage.totals.cost
  }
  if (aggregate.sawUsage) {
    header += ` · ${formatUsageCompact(aggregate.totals)}`
  }

  const lines: string[] = [header]
  const hits: HitRegion[] = []
  const visible = ordered.slice(0, WIDGET_ROW_CAP)
  for (let i = 0; i < visible.length; i++) {
    const row = formatAgentRow(visible[i], now)
    lines.push(row.line)
    hits.push({
      row: i + 1,
      from: row.labelFrom,
      to: row.labelTo,
      childId: visible[i].id,
    })
  }
  if (ordered.length > WIDGET_ROW_CAP) {
    lines.push(`… ${ordered.length - WIDGET_ROW_CAP} more`)
  }
  return { lines, hits }
}

/** Hit regions + width from the most recent widget render (click matching). */
let lastWidgetRender: { width: number; hits: HitRegion[] } = {
  width: 0,
  hits: [],
}

// AIDEV-NOTE: blue box chrome restored (PMR-N65M follow-up) — the pre-port
// widget drew an ACCENT-bordered panel, the herdsman row port dropped it and
// the panel boundary was missed. Purely visual: hit regions shift +1 row
// (top border) / +1 col (left border) in render().
const WIDGET_ACCENT = '\x1b[38;2;77;163;255m'
const WIDGET_RST = '\x1b[0m'

/** Wrap content lines in a bordered box: ╭───╮ │line│ ╰───╯. */
function boxWidgetLines(lines: readonly string[], width: number): string[] {
  if (width <= 2) return [...lines]
  const inner = width - 2
  const boxed: string[] = [
    `${WIDGET_ACCENT}╭${'─'.repeat(inner)}╮${WIDGET_RST}`,
  ]
  for (const line of lines) {
    const trunc = truncateToWidth(line, inner)
    const pad = Math.max(0, inner - visibleWidth(trunc))
    boxed.push(
      `${WIDGET_ACCENT}│${WIDGET_RST}${trunc}${' '.repeat(pad)}${WIDGET_ACCENT}│${WIDGET_RST}`,
    )
  }
  boxed.push(`${WIDGET_ACCENT}╰${'─'.repeat(inner)}╯${WIDGET_RST}`)
  return boxed
}

/** The tui object from the active widget component (for tick re-renders). */
let widgetTui: { requestRender: () => void } | null = null

/** Whether the widget is currently registered with pi's UI. */
let widgetRegistered = false

function focusClickMessage(): string {
  return 'Agent changed; reopen the agent list.'
}

/**
 * Focus a running subagent's tab after full identity re-verification. Both
 * the click path and the /subagents menu go through here. Never sends
 * `agent focus` on any mismatch — stale clicks are inert.
 */
function focusSubagentById(
  childId: string,
): { ok: true } | { ok: false; message: string } {
  const entry = runningSubagents.get(childId)
  if (!entry) return { ok: false, message: focusClickMessage() }
  let agent: Awaited<ReturnType<typeof herdrAgentGet>> = null
  if (entry.paneId) {
    try {
      agent = herdrAgentGet(entry.paneId)
    } catch {
      agent = null
    }
  }
  const verdict = canFocusAgent({ ...entry, childId: entry.id }, agent)
  if (!verdict.ok) return { ok: false, message: focusClickMessage() }
  try {
    herdrAgentFocus(verdict.paneId)
    return { ok: true }
  } catch (err: any) {
    return {
      ok: false,
      message: `Failed to focus subagent "${entry.name}": ${err?.message ?? String(err)}`,
    }
  }
}

function handleWidgetMouse(event: {
  type: string
  button: string
  x: number
  y: number
  width: number
}): { handled: boolean; render: boolean } | undefined {
  if (event.type !== 'click' || event.button !== 'left') return undefined
  const region = matchHitRegion(
    lastWidgetRender.hits,
    event,
    lastWidgetRender.width,
  )
  if (!region) return undefined
  const result = focusSubagentById(region.childId)
  if (!result.ok && latestCtx) {
    try {
      latestCtx.ui.notify(result.message, 'warning')
    } catch {}
  }
  return { handled: true, render: false }
}

function updateWidget() {
  if (!latestCtx?.hasUI) return
  // AIDEV-NOTE: latestCtx goes stale after session replacement/reload — pi
  // throws on stale ctx; a dead widget render must never crash the host.
  try {
    updateWidgetUnsafe()
  } catch {}
}

function updateWidgetUnsafe() {
  const has = runningSubagents.size > 0
  if (has && widgetRegistered) {
    // Cheap path: don't re-register the component (that would reset the 2s
    // tick) — just ask for a redraw with the fresh snapshot data.
    try {
      widgetTui?.requestRender()
    } catch {}
    return
  }
  renderWidget()
}

function renderWidget() {
  if (!latestCtx) return
  if (runningSubagents.size === 0) {
    if (widgetRegistered) {
      latestCtx.ui.setWidget('subagent-status', undefined)
      widgetRegistered = false
      widgetTui = null
    }
    return
  }

  widgetRegistered = true
  latestCtx.ui.setWidget(
    'subagent-status',
    (tui: any, _theme: any) => {
      widgetTui = tui
      // Presentation tick (herdsman pattern): elapsed time moves every 2s
      // without new activity snapshots.
      const tick = setInterval(() => {
        try {
          tui.requestRender()
        } catch {}
      }, 2000)
      return {
        invalidate() {},
        dispose() {
          clearInterval(tick)
          if (widgetTui === tui) {
            widgetTui = null
            widgetRegistered = false
          }
        },
        render(width: number) {
          const rendered = renderSupervisionRows(
            Array.from(runningSubagents.values()),
            Date.now(),
          )
          lastWidgetRender = {
            width,
            hits: rendered.hits.map((hit) => ({
              ...hit,
              row: hit.row + 1,
              from: hit.from + 1,
              to: hit.to + 1,
            })),
          }
          return boxWidgetLines(rendered.lines, width)
        },
        handleMouse: handleWidgetMouse,
      }
    },
    { placement: 'aboveEditor' },
  )
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
// AIDEV-NOTE: child-side infrastructure tools force-added to every pi-backed
// child's --tools allowlist, regardless of the agent def's tools list. Keep
// in sync with INFRASTRUCTURE_CHILD_TOOLS (deny-resolution) — a tool missing
// here silently disappears from children whose def sets `tools:` (found
// 2026-10-15: test-ask child had no ask_owner and used caller_ping instead).
const SUBAGENT_CONTROL_TOOLS = [
  'caller_ping',
  'subagent_done',
  'ask_owner',
  'message_owner',
  'list_peers',
  'message_peer',
] as const

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call subagent_done.
 */
function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? '')
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean)

  if (requested.length === 0) return null

  const allow = new Set(requested)
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool)
  }

  return [...allow].join(',')
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string
  taskDelivery: 'direct' | 'artifact'
  taskArg: string
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`)

  const needsSeparator =
    params.taskDelivery === 'artifact' && skillPrompts.length > 0

  return [...(needsSeparator ? [''] : []), ...skillPrompts, params.taskArg]
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== 'active') return undefined
  if (activity.activeScope === 'tool') return activity.toolName ?? 'tool'
  if (activity.activeScope === 'provider') return 'provider'
  if (activity.activeScope === 'streaming') return 'streaming'
  return activity.activeScope
}

function observeRunningSubagent(
  running: RunningSubagent,
  observedAt = Date.now(),
) {
  if (running.cli === 'claude') return

  const activityFile = running.activityFile
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: 'missing' }

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error }

  if (read.ok) {
    running.activity = read.activity
    running.statusState = observeStatus(
      running.statusState,
      {
        snapshot: 'present',
        updatedAt: read.activity.updatedAt,
        sequence: read.activity.sequence,
        phase: read.activity.phase,
        active: read.activity.phase === 'active',
        activeScope: read.activity.activeScope,
        activeSince: read.activity.activeSince,
        waitingSince: read.activity.waitingSince,
        blockedSince: read.activity.blockedSince,
        latestEvent: read.activity.latestEvent,
        activityLabel: activityLabel(read.activity),
      },
      observedAt,
    )
    return
  }

  running.statusState = observeStatus(
    running.statusState,
    {
      snapshot: read.reason,
      snapshotError: read.error,
    },
    observedAt,
  )
}

function resolveInterruptTarget(params: {
  id?: string
  name?: string
}): { running: RunningSubagent } | { error: string } {
  const requestedId = params.id?.trim()
  if (requestedId) {
    const running = runningSubagents.get(requestedId)
    return running
      ? { running }
      : { error: `No running subagent with id "${requestedId}".` }
  }

  const requestedName = params.name?.trim()
  if (!requestedName) {
    return { error: 'Provide a running subagent id or exact display name.' }
  }

  const matches = Array.from(runningSubagents.values()).filter(
    (running) => running.name === requestedName,
  )
  if (matches.length === 1) return { running: matches[0] }
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` }
  }

  const candidates = matches
    .map((running) => `${running.name} [${running.id}]`)
    .join(', ')
  return {
    error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
  }
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface)
    return { ok: true }
  } catch (error: any) {
    const backend = 'herdr'
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via ${backend}: ` +
        `${error?.message ?? String(error)}`,
    }
  }
}

interface InterruptDetails {
  error?: string
  id?: string
  name?: string
  status?: string
  /** 'pending' while awaiting the child `.ack` sidecar; 'unavailable' when the durable record could not be written. */
  ack?: 'pending' | 'unavailable'
}

// Injectable sidecar IO so unit tests can run the handshake in a temp dir.
export interface InterruptControlIo {
  writeControlRecord: (record: ControlRecord) => void
  readAckSidecar: (sessionFile: string) => ControlAck | null
  readControlRecord: (childId: string) => ControlRecord | null
  cleanupAck: (sessionFile: string, childId: string) => void
}

const defaultInterruptControlIo: InterruptControlIo = {
  writeControlRecord: (record) => writeControlRecord(record),
  readAckSidecar: (sessionFile) => readAckSidecar(sessionFile),
  readControlRecord: (childId) => readControlRecord(childId),
  cleanupAck: (sessionFile, childId) => {
    removeAckSidecar(sessionFile)
    removeControlRecord(childId)
  },
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendEscape,
  controlIo: InterruptControlIo = defaultInterruptControlIo,
): AgentToolResult<InterruptDetails> {
  const resolved = resolveInterruptTarget(params)
  if ('error' in resolved) {
    return {
      content: [{ type: 'text' as const, text: resolved.error }],
      details: { error: resolved.error },
    }
  }

  const running = resolved.running
  if (running.cli === 'claude') {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Turn-only Escape interrupt is currently supported only for Pi-backed subagents. Claude-backed semantics have not been verified yet.',
        },
      ],
      details: {
        error: 'claude interrupt unsupported',
        id: running.id,
        name: running.name,
      },
    }
  }

  const now = Date.now()
  observeRunningSubagent(running, now)

  const interruption = requestSubagentInterrupt(running, sendEscapeKey)
  if ('error' in interruption) {
    return {
      content: [{ type: 'text' as const, text: interruption.error }],
      details: {
        error: interruption.error,
        id: running.id,
        name: running.name,
      },
    }
  }

  // AIDEV-NOTE: request→ack handshake (PMR-DNPZ). The record is durable INTENT
  // (at-least-once window: if the child's ack write is lost we expire and fall
  // back to legacy fire-and-forget — the record alone never re-applies the
  // escape). Record-write failure must not block the interrupt itself.
  const requestId = randomUUID()
  let ackState: 'pending' | 'unavailable' = 'pending'
  try {
    controlIo.writeControlRecord({
      requestId,
      childId: running.id,
      sessionFile: running.sessionFile,
      kind: 'interrupt',
      payload: {},
      sentAt: new Date().toISOString(),
    })
  } catch {
    ackState = 'unavailable'
  }

  running.statusState = markPendingRequest(
    forceStatusAfterInterrupt(running.statusState, now),
    { requestId, kind: 'interrupt', sentAtMs: now },
  )
  updateWidget()

  let resultText = `Interrupt requested for subagent "${running.name}".`
  if (ackState === 'unavailable') {
    resultText += ' Control record unavailable — legacy fire-and-forget.'
  } else {
    resultText += ' Awaiting child acknowledgement.'
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: resultText,
      },
    ],
    details: {
      id: running.id,
      name: running.name,
      status: 'interrupt_requested',
      ack: ackState,
    },
  }
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!getStatusConfig().enabled || statusInterval) return

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval)
        statusInterval = null
        ;(globalThis as any)[STATUS_INTERVAL_KEY] = null
      }
      return
    }

    const transitionLines: string[] = []
    const now = Date.now()
    let shouldRefreshWidget = false

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now)
      const { nextState, snapshot, transition } = advanceStatusState(
        running.statusState,
        now,
      )
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true
      }
      running.statusState = nextState
      // PMR-874G: advance the incremental usage tracker over the child
      // session jsonl (append-only — only new bytes are reparsed per tick).
      if (running.cli !== 'claude' && running.sessionFile) {
        if (!running.usageTracker) {
          running.usageTracker = createSessionUsageTracker()
        }
        updateSessionUsageTracker(running.usageTracker, running.sessionFile)
        running.usage = running.usageTracker.summary
      }
      // PMR-Z5KR: persist coarse status transitions (blocked/interrupted/
      // stalled/working) to the durable assignment record, on change only.
      syncAssignmentStatus(running, statusKindOf(running, now))

      // Request→ack observation (PMR-DNPZ / WXG0 phase 5): poll the child
      // `.ack` sidecar for the pending control request (interrupt or answer).
      // Interrupt acks correlate on requestId + childId + sessionFile via the
      // control record; answer acks correlate on the askId directly (no control
      // record — the sidecar path binds the session identity). Anything else is
      // ignored until the bounded timeout expires the request with an explicit
      // warning. Ack/timeout lines push even for interactive children — they
      // are one-shot outcomes, not a stall cadence.
      const pending = running.statusState.pendingRequest
      if (pending && running.cli !== 'claude') {
        const ack = defaultInterruptControlIo.readAckSidecar(
          running.sessionFile,
        )
        if (ack) {
          let matched = false
          if (pending.kind === 'answer') {
            // AIDEV-NOTE: the child writes this ack only after the answer was
            // ingested via its own session (mailbox pump), keyed on the askId.
            matched = ack.accepted && ack.requestId === pending.requestId
          } else {
            const record = defaultInterruptControlIo.readControlRecord(
              running.id,
            )
            matched = !!(
              record &&
              ackMatches({
                record,
                ack,
                childId: running.id,
                sessionFile: running.sessionFile,
              })
            )
          }
          if (matched) {
            const applied = applyPendingAck(running.statusState, ack.requestId)
            running.statusState = applied.state
            if (applied.outcome === 'acked') {
              defaultInterruptControlIo.cleanupAck(
                running.sessionFile,
                running.id,
              )
              // AIDEV-NOTE (PMR-KY0E): mark the requestId delivered at ack
              // application — any future re-apply/reattach path must consult
              // hasDelivered before re-applying the request.
              markDelivered(`control:${running.id}`, pending.requestId)
              shouldRefreshWidget = true
              if (pending.kind === 'answer') {
                // AIDEV-NOTE: child confirmed ingestion — drop the durable
                // ask/reply records (idempotent: the child's pump deletes them
                // too) and re-arm the ask steer dedupe.
                removeAskRecord(running.id)
                removeReplyRecord(running.id)
                running.notifiedAskId = undefined
                transitionLines.push(
                  `${running.name} answer ingested — it continues its session.`,
                )
              } else {
                transitionLines.push(
                  `${running.name} interrupt acknowledged by child.`,
                )
              }
            }
          }
        }
        // AIDEV-NOTE: a present-but-unmatched ack is ignored (identity
        // revalidation) and left in place; the timeout below cleans up both
        // record and sidecar when the window elapses.
        if (running.statusState.pendingRequest) {
          const expiry = expirePendingRequest(running.statusState, now)
          running.statusState = expiry.state
          if (expiry.outcome === 'timeout') {
            defaultInterruptControlIo.cleanupAck(
              running.sessionFile,
              running.id,
            )
            if (pending.kind === 'answer') {
              // AIDEV-NOTE: on answer timeout the reply record REMAINS — the
              // child may still ingest it late (at-least-once); only the stale
              // ack sidecar is removed.
              transitionLines.push(
                `${running.name} answer ingestion not confirmed within ` +
                  `${Math.round(INTERRUPT_ACK_TIMEOUT_MS / 1000)}s — reply remains queued; the child will pick it up on its next pump tick.`,
              )
            } else {
              transitionLines.push(
                `${running.name} interrupt not acknowledged within ` +
                  `${Math.round(INTERRUPT_ACK_TIMEOUT_MS / 1000)}s — escape was sent; assuming applied (legacy fire-and-forget).`,
              )
            }
          }
        }
      }

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(
          formatTransitionLine(running.name, snapshot, transition),
        )
      }
    }

    if (shouldRefreshWidget) updateWidget()

    // Owner-inbox drain (PMR-QCVA): all records present this tick coalesce
    // into ONE steer, line-capped. Records are deleted only after the steer
    // send succeeds — a failed send leaves them durable for the next tick.
    // AIDEV-NOTE: at-least-once — crash after send but before unlink
    // re-delivers the same messages next tick (duplicate turn, worst case).
    if (ownerSessionId) {
      try {
        const allEntries = readOwnerInbox(ownerSessionId)
        // AIDEV-NOTE (PMR-KY0E): exactly-once guard — records already injected
        // (crash after send, before unlink) are dropped here, not steered
        // again. Coalescing still applies to the FRESH records only, so a
        // mixed tick sends one steer over the new messages. Marker written
        // AFTER the steer send succeeds (see pumpReplies window note).
        // AIDEV-NOTE: const alias — TS narrowing doesn't survive the arrow
        // callback below.
        const ownerId = ownerSessionId
        const entries = allEntries.filter(
          (entry) => !hasDelivered(ownerId, entry.message.messageId),
        )
        if (entries.length > 0) {
          const coalesced = coalesceOwnerMessages(
            entries,
            getStatusConfig().lineLimit,
          )
          const noun = entries.length > 1 ? 'messages' : 'message'
          const content = [
            `Subagent ${noun} (${entries.length}):`,
            ...coalesced.visibleLines.map((line) => `• ${line}`),
          ]
          if (coalesced.overflow > 0) {
            content.push(`• +${coalesced.overflow} more messages.`)
          }
          pi.sendMessage(
            {
              customType: 'subagent_message',
              content: content.join('\n'),
              display: true,
              details: {
                count: entries.length,
                lines: coalesced.visibleLines,
                overflow: coalesced.overflow,
              },
            },
            { triggerTurn: true, deliverAs: 'steer' },
          )
          for (const entry of entries) {
            markDelivered(ownerSessionId, entry.message.messageId)
          }
        }
        for (const entry of allEntries) {
          removeOwnerMessage(entry.path)
        }
      } catch {}
    }

    if (transitionLines.length > 0) {
      const capped = capStatusLines(
        transitionLines,
        getStatusConfig().lineLimit,
      )
      // AIDEV-NOTE: pi can be stale after session replacement — swallow, the
      // new module load recreates this interval with a fresh pi.
      try {
        pi.sendMessage(
          {
            customType: 'subagent_status',
            content: formatStatusAggregate(
              transitionLines,
              getStatusConfig().lineLimit,
            ),
            display: true,
            details: { lines: capped.visibleLines, overflow: capped.overflow },
          },
          { triggerTurn: true, deliverAs: 'steer' },
        )
      } catch {}
    }
  }, 1000)

  ;(globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): {
  autoExit: boolean
  interactive: boolean
} {
  const autoExit = params.autoExit ?? true
  return { autoExit, interactive: !autoExit }
}

/** The record a subagent_resume should reattach to, or null (PMR-N53A). */
export function latestAssignmentForSession(
  records: readonly AssignmentRecord[],
  sessionFile: string,
): AssignmentRecord | null {
  let latest: AssignmentRecord | null = null
  for (const record of records) {
    if (record.sessionFile !== sessionFile) continue
    if (latest === null || record.updatedAt > latest.updatedAt) latest = record
  }
  return latest
}

export type ResumeReattachDecision =
  | { action: 'reattach'; record: AssignmentRecord; why: string }
  | { action: 'spawn'; why: string }

// AIDEV-NOTE (PMR-N53A): reattach decision for subagent_resume. The hazard:
// spawning a new tab on a session whose child pi process is STILL ALIVE (a
// shutdown-spared orphan running in its herdr tab) puts TWO pi processes on
// one session jsonl — interleaved appends corrupt the transcript. The
// record's claim pid belongs to the (possibly dead) PARENT, so it cannot
// prove child liveness; herdr `agent get` on the record's paneId is the
// ground truth for "a child still runs in that tab". agentAlive ⇒ reattach
// (the orphan is adopted); agent gone ⇒ spawn (the old path — safe, its
// sidecar cleanup already runs there). steerCapable=false for claude-kind
// children: they have no inbox pump, a steered message would never arrive.
// Pure — no herdr/process access — so tests cover the matrix directly.
export function decideResumeReattach(input: {
  record: AssignmentRecord | null
  pidAlive: boolean
  agentAlive: boolean
  steerCapable: boolean
}): ResumeReattachDecision {
  if (input.record === null) {
    return { action: 'spawn', why: 'no assignment record for this session' }
  }
  if (!input.record.paneId) {
    return { action: 'spawn', why: 'assignment record has no pane id' }
  }
  if (!input.steerCapable) {
    return {
      action: 'spawn',
      why: 'child kind has no inbox pump (claude) — a steer would never arrive',
    }
  }
  if (input.agentAlive) {
    let ownership = 'orphaned'
    if (input.pidAlive) ownership = 'owned'
    return {
      action: 'reattach',
      record: input.record,
      why: `assignment ${ownership} but herdr reports the agent alive on ${input.record.paneId}`,
    }
  }
  let why =
    'orphaned child is gone (herdr reports no agent on the recorded pane)'
  if (input.pidAlive) {
    why =
      'herdr reports no agent on the recorded pane (owner parent still live)'
  }
  return { action: 'spawn', why }
}

export const __test__ = {
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  observeRunningSubagent,
  resolveDenyTools,
  rolePrefixWithoutAgent,
  managerApprovalDenial,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  deliverAskSteer,
  handleSubagentInterrupt,
  defaultInterruptControlIo,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  runningSubagents,
  formatElapsed,
}

function startWidgetRefresh() {
  // The 2s presentation tick lives inside the widget component; this only
  // (re)registers the widget when the agent set transitions empty <-> non-empty.
  updateWidget()
}

/**
 * Launch a subagent into a NEW background herdr tab. Returns a
 * RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
/**
 * Spawn one agent into a NEW background tab and attach it to the tab's root
 * pane. Throws after rolling the tab back if shell-readiness or `agent
 * start` fails — only tabs this function created are ever closed.
 */
async function spawnAgentInTab(options: {
  workspaceId: string
  cwd: string
  label: string
  env: Record<string, string>
  kind: 'pi' | 'claude'
  argv: readonly string[]
  alias: string
}): Promise<HerdrSpawnedTab> {
  const tab = herdrTabCreate({
    workspaceId: options.workspaceId,
    cwd: options.cwd,
    label: options.label,
    env: options.env,
  })
  try {
    await waitShellReady(tab.paneId)
    // AIDEV-NOTE: `herdr agent start --kind pi|claude` launches the canonical
    // executable itself — the argv must NOT repeat it, or the child runs
    // `pi pi --session ...` (observed live: child never starts its turn).
    try {
      herdrAgentStart({
        alias: options.alias,
        kind: options.kind,
        paneId: tab.paneId,
        argv: options.argv.slice(1),
      })
    } catch (startErr) {
      // AIDEV-NOTE: herdr's readiness detection waits for an IDLE agent, but
      // our children receive their task positionally and go busy immediately
      // — "timed out waiting for agent startup" is a false negative that
      // used to roll back LIVE children (observed 2026-10-15: child killed
      // mid-bash after writing its start marker). Treat it as a soft error:
      // real readiness is the child's session file appearing (file-based,
      // ours). Hard errors (bad args, missing pane) still roll back at once.
      const soft = /timed out waiting for agent startup/i.test(
        String((startErr as Error)?.message ?? startErr),
      )
      if (!soft) throw startErr
      const sessionPath = options.env.PI_SUBAGENT_SESSION
      const deadline = Date.now() + 30_000
      let started = false
      while (Date.now() < deadline) {
        if (
          sessionPath &&
          existsSync(sessionPath) &&
          readFileSync(sessionPath, 'utf8').length > 0
        ) {
          started = true
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!started) throw startErr
    }
  } catch (err) {
    // AIDEV-NOTE: asymmetric rollback (herdsman's createdTab rule) — a failed
    // start tears down ONLY tabs this spawn created, never user tabs.
    // Re-listing the workspace avoids closing a tab someone else already
    // removed; pickRollbackTabs guarantees user tabs are filtered out.
    try {
      for (const tabId of pickRollbackTabs(
        [tab.tabId],
        herdrTabList(tab.workspaceId),
      )) {
        try {
          herdrTabClose(tabId)
        } catch {}
      }
    } catch {}
    throw err
  }
  return tab
}

/** Herdr workspace of THIS pi session; null when not running inside herdr. */
function resolveHerdrWorkspaceId(): string | null {
  const ws = process.env.HERDR_WORKSPACE_ID?.trim()
  if (ws) return ws
  const pane = process.env.HERDR_PANE_ID?.trim()
  if (pane && pane.includes(':')) return pane.split(':')[0]
  return null
}

// ── Durable assignments (PMR-Z5KR) ──

/**
 * Ids of children spared at session_shutdown because a durable assignment
 * record exists — their herdr-owned tab keeps running and a future parent
 * rediscovers the record as an orphan with a resume hint. Consulted by the
 * watcher catch path so the shutdown abort does not close the pane or mark
 * the record lost.
 */
const sparedAssignments = new Set<string>()

// AIDEV-NOTE (PMR-Z5KR): the durable assignment is the authority. Since
// PMR-YKAC the record is written record-FIRST (status 'starting') before
// spawn side effects; this post-spawn write upgrades it to the full
// 'working' picture (paneId/tabId/workspaceId). A write failure must not
// fail the spawn (same at-least-once discipline as the result store): the
// in-memory entry + watcher still deliver the result.
function persistAssignment(
  running: RunningSubagent,
  cwd: string,
  ownerSessionId: string | null,
): void {
  try {
    writeAssignment({
      childId: running.id,
      name: running.name,
      task: running.task,
      agent: running.agent,
      sessionFile: running.sessionFile,
      paneId: running.paneId,
      tabId: running.tabId,
      workspaceId: running.workspaceId,
      activityFile: running.activityFile,
      cwd,
      worktree: running.worktree,
      branch: running.branch,
      status: 'working',
      claim: { pid: process.pid, id: ownerSessionId ?? 'unknown' },
    })
    running.assignmentStatus = 'working'
  } catch {}
}

/** Persist a status transition to the assignment record (on change only). */
function syncAssignmentStatus(
  running: RunningSubagent,
  status: AssignmentStatus,
): void {
  if (running.assignmentStatus === status) return
  running.assignmentStatus = status
  try {
    updateAssignmentStatus(running.id, status)
  } catch {}
}

// AIDEV-NOTE (PMR-Z5KR): removal ONLY on a verified completion signal
// (`.exit`/sentinel observed by pollForExit). Crash-inferred or aborted
// endings mark the record 'lost' and KEEP it — fail closed, no invented
// success, the record remains as evidence for a future parent's scan.
function settleAssignment(childId: string, verified: boolean): void {
  try {
    if (verified) {
      removeAssignment(childId)
    } else {
      updateAssignmentStatus(childId, 'lost')
    }
  } catch {}
}

// AIDEV-NOTE (PMR-J2V5): guardrail against silent agent-definition drift — a
// caller naming its child 'worker: X' (or 'worker — X') but omitting agent:
// gets settings.json defaults in the child, NOT the role's frontmatter
// (model/skills/thinking). Keep this role list in sync with agents/*.md in
// the package root. Pure advisory: we surface the mismatch, never infer.
const KNOWN_ROLE_PREFIXES = [
  'worker',
  'scout',
  'reviewer',
  'planner',
  'visual-tester',
]
const ROLE_NAME_SEPARATORS = [': ', ':', ' — ', ' —', ' - ', ' -']

export function rolePrefixWithoutAgent(
  name: string | undefined,
  agent: string | undefined,
): string | null {
  if (agent != null || name == null) return null
  for (const role of KNOWN_ROLE_PREFIXES) {
    for (const separator of ROLE_NAME_SEPARATORS) {
      if (name.startsWith(`${role}${separator}`)) return role
    }
  }
  return null
}

async function launchSubagent(
  params: SubagentInput,
  ctx: ExtensionContext,
): Promise<RunningSubagent> {
  const startTime = Date.now()

  // Programmatic callers (e.g. pi-test-runner) do not go through the subagent
  // tool, so make sure the UI context and refresh loops are initialized.
  if (!latestCtx) {
    latestCtx = ctx
  }

  const sessionFile = ctx.sessionManager.getSessionFile()
  if (!sessionFile) throw new Error('No session file')
  const sessionId = ctx.sessionManager.getSessionId()

  // AIDEV-NOTE (PMR-YKAC): replay-safe spawn — lookup BEFORE any side
  // effect. A 'starting' assignment record from this parent session with the
  // same name+task is a spawn that crashed after its record write but before
  // tab create: reuse its childId/sessionFile/worktree instead of
  // duplicating. Fresh spawns get a deterministic childId from
  // (parentSessionId, durable spawnSeq) — see spawnseq.ts.
  const spawnIdentity = allocateSpawnIdentity({
    parentSessionId: sessionId ?? null,
    name: params.name,
    task: params.task,
  })
  const id = spawnIdentity.childId
  const replayed = spawnIdentity.replay

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null
  const driftRole = rolePrefixWithoutAgent(params.name, params.agent)
  if (driftRole && latestCtx) {
    try {
      latestCtx.ui.notify(
        `Name suggests role "${driftRole}" but no agent: passed — agent frontmatter (model, skills, thinking) will NOT apply. Pass agent: "${driftRole}" or rename.`,
        'warning',
      )
    } catch {}
  }
  const effectiveModel = params.model ?? agentDefs?.model
  const effectiveTools = params.tools ?? agentDefs?.tools
  const effectiveSkills = params.skills ?? agentDefs?.skills
  const effectiveThinking = agentDefs?.thinking
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs)

  // AIDEV-NOTE: worktree placement (PMR-11TD) — blocking `git worktree add`
  // BEFORE any tab/session setup. A failure here means no tab, no partial
  // state (the worktree itself, if created, is never auto-removed). The
  // worktree path then becomes the child cwd for session dir, agent
  // discovery, and `tab create --cwd`.
  // AIDEV-NOTE (PMR-YKAC): on replay the crashed spawn's branch/path are
  // reused; the `git worktree add` is skipped when the recorded path already
  // exists (no duplicate worktree for the retried spawn).
  let worktree: { path: string; branch: string } | null = null
  if (params.worktree) {
    if (params.cwd) {
      throw new Error(
        'worktree and cwd cannot be combined — the worktree becomes the cwd.',
      )
    }
    let base: string | undefined
    if (typeof params.worktree === 'object') {
      base = params.worktree.base
    }
    const branch = replayed?.branch ?? deriveWorktreeBranch(params.name, id)
    if (replayed?.worktree && existsSync(replayed.worktree)) {
      worktree = { path: replayed.worktree, branch }
    } else {
      worktree = createSubagentWorktree({
        cwd: ctx.cwd,
        branch,
        base,
      })
    }
  }

  const artifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    sessionId,
  )

  const pathParams = worktree ? { ...params, cwd: worktree.path } : params
  const { effectiveCwd, localAgentDir, effectiveAgentDir } =
    resolveSubagentPaths(pathParams, agentDefs)
  const targetCwdForSession = effectiveCwd ?? ctx.cwd
  const sessionDir = getDefaultSessionDirFor(
    targetCwdForSession,
    effectiveAgentDir,
  )

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}Z`
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join('-')
  // Replay: adopt the crashed spawn's session file so resume/attach paths
  // keep pointing at one file.
  const subagentSessionFile =
    replayed?.sessionFile ?? join(sessionDir, `${timestamp}_${uuid}.jsonl`)

  // AIDEV-NOTE (PMR-YKAC): record-first — the durable 'starting' assignment
  // is written BEFORE the remaining spawn side effects (seed, tab create).
  // This inverts the old "failed spawn leaves no record" rule on purpose: a
  // crash now leaves a resumable record that allocateSpawnIdentity replays,
  // and orphan discovery can distinguish it (status 'starting', no paneId).
  // persistAssignment still upgrades the record to 'working' after a
  // successful spawn. Write failure must not fail the spawn (at-least-once
  // discipline, same as persistAssignment below).
  const activityFile = getSubagentActivityFile(artifactDir, id)
  if (!replayed) {
    try {
      writeAssignment({
        childId: id,
        name: params.name,
        task: params.task,
        agent: params.agent,
        sessionFile: subagentSessionFile,
        activityFile,
        cwd: targetCwdForSession,
        worktree: worktree?.path,
        branch: worktree?.branch,
        status: 'starting',
        claim: { pid: process.pid, id: sessionId ?? 'unknown' },
      })
    } catch {}
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs)

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    })
  }

  mkdirSync(dirname(activityFile), { recursive: true })
  const { inheritsConversationContext } = launchBehavior

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs?.autoExit
    ? 'Complete your task autonomously.'
    : 'Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.'
  const summaryInstruction = agentDefs?.autoExit
    ? 'Your FINAL assistant message should summarize what you accomplished.'
    : 'Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.'
  const denySet = resolveDenyTools(agentDefs)
  const identity = agentDefs?.body ?? params.systemPrompt ?? null
  const systemPromptMode = agentDefs?.systemPromptMode
  const identityInSystemPrompt = systemPromptMode && identity
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : ''
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`

  // ── Build child env (rides `tab create --env`) + agent argv ──

  const env: Record<string, string> = {}
  // If the target cwd has its own .pi/agent/, use that as the config root.
  // Otherwise propagate the current/global agent dir.
  if (localAgentDir && existsSync(localAgentDir)) {
    env.PI_CODING_AGENT_DIR = localAgentDir
  } else if (process.env.PI_CODING_AGENT_DIR) {
    env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  }
  if (denySet.size > 0) {
    env.PI_DENY_TOOLS = [...denySet].join(',')
  }
  // AIDEV-NOTE: epimetheus (Hindsight memory) disabled in subagents — its
  // pending-queue markers for ephemeral/crashed subagent sessions orphan and
  // warn on every parent quit ("session file not found"). Subagent work is
  // retained via the parent session's steering summary instead. Remove to
  // re-enable subagent memory (then expect orphan queue dirs; backstop:
  // ~/.local/bin/epimetheus-clean-orphans).
  env.EPIMETHEUS_ENABLED = 'false'
  env.PI_SUBAGENT_NAME = params.name
  if (params.agent) {
    env.PI_SUBAGENT_AGENT = params.agent
  }
  if (agentDefs?.autoExit) {
    env.PI_SUBAGENT_AUTO_EXIT = '1'
  }
  env.PI_SUBAGENT_SESSION = subagentSessionFile
  env.PI_SUBAGENT_ID = id
  env.PI_SUBAGENT_ACTIVITY_FILE = activityFile
  if (worktree) {
    env.PI_SUBAGENT_WORKTREE = worktree.path
  }
  // Owner-inbox routing key for message_owner (PMR-QCVA): the parent's
  // session id names the inbox dir the child writes to.
  env.PI_SUBAGENT_PARENT_SESSION = sessionId

  const subagentDonePath = join(SUBAGENTS_DIR, 'subagent-done.ts')
  let kind: 'pi' | 'claude'
  let argv: string[]

  if (agentDefs?.cli === 'claude') {
    kind = 'claude'
    const sentinelFile = `/tmp/pi-claude-${id}-done`
    env.PI_CLAUDE_SENTINEL = sentinelFile
    const pluginDir = join(SUBAGENTS_DIR, 'plugin')
    argv = ['claude', '--dangerously-skip-permissions']
    if (existsSync(pluginDir)) {
      argv.push('--plugin-dir', pluginDir)
    }
    if (effectiveModel) {
      argv.push('--model', effectiveModel)
    }
    const sp = params.systemPrompt ?? agentDefs.body
    if (sp) {
      argv.push('--append-system-prompt', sp)
    }
    if (params.resumeSessionId) {
      argv.push('--resume', params.resumeSessionId)
    }
    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    argv.push(params.task)
  } else {
    kind = 'pi'
    argv = ['pi', '--session', subagentSessionFile, '-e', subagentDonePath]
    if (effectiveModel) {
      const model = effectiveThinking
        ? `${effectiveModel}:${effectiveThinking}`
        : effectiveModel
      argv.push('--model', model)
    }
    // Pass agent body as system prompt via file to avoid escaping issues.
    // Pi's --append-system-prompt and --system-prompt auto-detect file paths.
    if (identityInSystemPrompt && identity) {
      const flag =
        systemPromptMode === 'replace'
          ? '--system-prompt'
          : '--append-system-prompt'
      const spTimestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19)
      const spSafeName = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
      const syspromptPath = join(
        artifactDir,
        `context/${spSafeName || 'subagent'}-sysprompt-${spTimestamp}.md`,
      )
      mkdirSync(dirname(syspromptPath), { recursive: true })
      writeFileSync(syspromptPath, identity, 'utf8')
      argv.push(flag, syspromptPath)
    }
    const toolAllowlist = buildSubagentToolAllowlist(effectiveTools)
    if (toolAllowlist) {
      argv.push('--tools', toolAllowlist)
    }
    // Pass task and skill prompts to the sub-agent.
    // Only full-context fork mode gets a direct task argument because it already
    // inherits the parent conversation. Blank-session modes use artifact-backed
    // handoff so the wrapper instructions arrive as the initial user message.
    let taskArg: string
    if (launchBehavior.taskDelivery === 'direct') {
      taskArg = fullTask
    } else {
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19)
      const safeName = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
      const artifactName = `context/${safeName || 'subagent'}-${timestamp}.md`
      const artifactPath = join(artifactDir, artifactName)
      mkdirSync(dirname(artifactPath), { recursive: true })
      writeFileSync(artifactPath, fullTask, 'utf8')
      taskArg = `@${artifactPath}`
    }
    argv.push(
      ...buildPiPromptArgs({
        effectiveSkills,
        taskDelivery: launchBehavior.taskDelivery,
        taskArg,
      }),
    )
  }

  // ── Transient "starting" entry — visible in the widget before herdr
  // knows the agent (herdsman's pendingStartEntries pattern). ──
  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface: '',
    startTime,
    sessionFile: subagentSessionFile,
    activityFile,
    ...(agentDefs?.cli === 'claude' ? { cli: 'claude' as const } : {}),
    ...(worktree ? { worktree: worktree.path, branch: worktree.branch } : {}),
    interactive: effectiveInteractive,
    starting: true,
    statusState: createStatusState({
      source: agentDefs?.cli === 'claude' ? 'claude' : 'pi',
      startTimeMs: startTime,
    }),
  }
  runningSubagents.set(id, running)
  startWidgetRefresh()

  // ── Background tab spawn: `tab create --no-focus` (the user's focus never
  // moves) → shell-readiness marker → `agent start --kind <kind>` attaching
  // the agent to the tab's root pane. ──
  const workspaceId = resolveHerdrWorkspaceId()
  if (!workspaceId) {
    runningSubagents.delete(id)
    updateWidget()
    throw new Error(
      'Not running inside herdr (HERDR_WORKSPACE_ID/HERDR_PANE_ID unset). ' +
        'Start pi with `herdr pi` so subagents can spawn background tabs.',
    )
  }

  let tab: HerdrSpawnedTab
  try {
    tab = await spawnAgentInTab({
      workspaceId,
      cwd: targetCwdForSession,
      label: params.name,
      env,
      kind,
      argv,
      alias: `pi-subagent-${id}`,
    })
  } catch (err) {
    runningSubagents.delete(id)
    // AIDEV-NOTE (PMR-YKAC): a CLEAN spawn failure (throw, not crash) retires
    // the 'starting' record as 'lost' so a retry allocates fresh instead of
    // replaying a spawn whose inputs may be broken. A crash (no throw) keeps
    // the record 'starting' — that is the replay path.
    try {
      updateAssignmentStatus(id, 'lost')
    } catch {}
    updateWidget()
    throw err
  }

  running.surface = tab.paneId
  running.paneId = tab.paneId
  running.tabId = tab.tabId
  running.workspaceId = tab.workspaceId
  running.starting = false
  persistAssignment(running, targetCwdForSession, sessionId ?? null)
  updateWidget()
  if (latestPi) startStatusRefresh(latestPi)
  return running
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? '/tmp',
  '.pi',
  'agent',
  'sessions',
  'claude-code',
)

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = `${sentinelFile}.transcript`
    if (!existsSync(transcriptFile)) return null
    const transcriptPath = readFileSync(transcriptFile, 'utf-8').trim()
    if (!transcriptPath || !existsSync(transcriptPath)) return null
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true })
    const filename =
      transcriptPath.split('/').pop() ?? `claude-${Date.now()}.jsonl`
    const dest = join(CLAUDE_SESSIONS_DIR, filename)
    copyFileSync(transcriptPath, dest)
    return filename
  } catch {
    return null
  }
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  onAsk?: () => void,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running

  // AIDEV-NOTE (PMR-Z5KR): flipped by pollForExit when a VERIFIED completion
  // signal (`.exit`/sentinel) is observed — never by crash inference. Gates
  // assignment-record removal in the completion paths below.
  let verifiedExit = false

  try {
    const result = await pollForExit(
      surface,
      AbortSignal.any([signal, getModuleAbortSignal()]),
      {
        interval: 1000,
        sessionFile,
        sentinelFile: running.sentinelFile,
        onTick() {
          observeRunningSubagent(running)
        },
        onAsk,
        onVerifiedExit() {
          verifiedExit = true
        },
      },
    )

    const elapsed = Math.floor((Date.now() - startTime) / 1000)

    if (running.cli === 'claude') {
      // Claude Code result extraction
      let summary = ''

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, 'utf-8').trim()
        } catch {}
      }

      if (!summary) {
        summary = readScreen(surface, 200)
          .replace(/__SUBAGENT_DONE_\d+__/, '')
          .trimEnd()
      }

      if (!summary) {
        summary =
          result.exitCode !== 0
            ? `Claude Code exited with code ${result.exitCode}`
            : 'Claude Code exited without output'
      }

      // Copy Claude session transcript
      let sessionId: string | null = null
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile)
        try {
          unlinkSync(running.sentinelFile)
        } catch {}
        try {
          unlinkSync(`${running.sentinelFile}.transcript`)
        } catch {}
      }

      closeSurface(surface, running.tabId)
      runningSubagents.delete(running.id)
      settleAssignment(running.id, verifiedExit)

      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
      }
    }

    // Pi subagent result extraction
    let summary: string
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0)
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : 'Sub-agent exited without output')
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : 'Sub-agent exited without output'
    }

    // PMR-874G: settle-time accounting — full-file read (the incremental
    // tracker may lag the final writes). Recorded onto the durable
    // assignment record BEFORE settlement (it survives as evidence when the
    // record is kept 'lost') and returned on the result so the result
    // record carries the same totals.
    let settledUsage: UsageTotals | undefined
    const usageSummary = readSessionUsage(sessionFile)
    if (usageSummary?.sawUsage) {
      settledUsage = usageSummary.totals
      try {
        recordAssignmentUsage(running.id, settledUsage)
      } catch {}
    }

    closeSurface(surface, running.tabId)
    runningSubagents.delete(running.id)
    settleAssignment(running.id, verifiedExit)

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(settledUsage ? { usage: settledUsage } : {}),
    }
  } catch (err: any) {
    if (!signal.aborted && getModuleAbortSignal().aborted) {
      // AIDEV-NOTE: extension /reload aborted the poll loop — keep the pane
      // and Map entry alive; the new module re-attaches via runWatcher.
      return {
        name,
        task,
        summary: '',
        sessionFile,
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: RELOAD_SENTINEL,
      }
    }
    const spared = sparedAssignments.has(running.id)
    if (!spared) {
      try {
        closeSurface(surface, running.tabId)
      } catch {}
      settleAssignment(running.id, false)
    }
    runningSubagents.delete(running.id)

    if (signal.aborted) {
      return {
        name,
        task,
        summary: 'Subagent cancelled.',
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: 'cancelled',
        sessionFile,
      }
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    }
  }
}

/**
 * Single fire-and-forget watcher + result delivery path. Used at launch and
 * when re-attaching watchers orphaned by an extension /reload (old module
 * aborted its poll loops but kept entries + panes alive on globalThis).
 */
// AIDEV-NOTE (PMR-WXG0): wake the parent once per askId while the child sits
// blocked-asking. The watcher keeps polling — only the eventual `.exit`
// resolves it. If the steer send fails we clear the dedupe marker so the next
// poll tick retries (at-least-once delivery).
function deliverAskSteer(pi: ExtensionAPI, running: RunningSubagent): void {
  try {
    const record = readAskRecord(running.id)
    if (!record) return
    if (running.notifiedAskId === record.askId) return
    if (
      !askIdentityMatches({
        record,
        childId: running.id,
        sessionFile: running.sessionFile,
      })
    ) {
      return
    }
    running.notifiedAskId = record.askId
    syncAssignmentStatus(running, 'blocked')
    const filesNote =
      record.files && record.files.length > 0
        ? `\n\nFiles: ${record.files.join(', ')}`
        : ''
    pi.sendMessage(
      {
        customType: 'subagent_ask',
        content:
          `Sub-agent "${running.name}" asks (${record.askId}):\n\n` +
          `${record.question}${filesNote}\n\n` +
          `Answer with the answer_subagent tool (id: ${running.id}, askId: ${record.askId}).`,
        display: true,
        details: {
          askId: record.askId,
          childId: running.id,
          name: running.name,
          question: record.question,
          files: record.files,
          sessionFile: record.sessionFile,
        },
      },
      { triggerTurn: true, deliverAs: 'steer' },
    )
  } catch {
    running.notifiedAskId = undefined
  }
}

function runWatcher(pi: ExtensionAPI, running: RunningSubagent): void {
  running.watching = true
  const watcherAbort = new AbortController()
  running.abortController = watcherAbort
  watchSubagent(running, watcherAbort.signal, () =>
    deliverAskSteer(pi, running),
  )
    .then((result) => {
      if (result.error === RELOAD_SENTINEL) return // new module delivers
      // AIDEV-NOTE: pi/latestCtx can be stale after session replacement —
      // delivery must never crash the host.
      try {
        updateWidget() // reflect removal from Map immediately

        if (result.ping) {
          // Subagent is requesting help — steer a ping with session path for resume
          const sessionRef = result.sessionFile
            ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
            : ''
          pi.sendMessage(
            {
              customType: 'subagent_ping',
              content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
              display: true,
              details: {
                name: result.ping.name,
                message: result.ping.message,
                agent: running.agent,
                sessionFile: result.sessionFile,
              },
            },
            { triggerTurn: true, deliverAs: 'steer' },
          )
          return
        }

        // Resume flow: re-extract only entries written after the resume.
        if (
          running.resumeEntryCount != null &&
          result.sessionFile &&
          !result.errorMessage
        ) {
          const newEntries = getNewEntries(
            result.sessionFile,
            running.resumeEntryCount,
          )
          const summary =
            findLastAssistantMessage(newEntries) ??
            (result.exitCode !== 0
              ? `Resumed session exited with code ${result.exitCode}`
              : 'Resumed session exited without new output')
          result = { ...result, summary }
        }

        let presentation = resolveResultPresentation(result, running.name)
        if (running.worktree) {
          // AIDEV-NOTE: durable result references the worktree (PMR-11TD) —
          // the worktree outlives the child; removal is manual, never auto.
          presentation += `\n\nWorktree: ${running.worktree} (branch ${running.branch}) — removal is manual (git worktree remove).`
        }

        // AIDEV-NOTE: persist result + reserve a semantic ref, but delivery
        // never depends on the store — if it fails we fall back to exactly
        // today's inline-only message (at-least-once semantics preserved).
        let resultRef: string | undefined
        let resultPath: string | undefined
        let resultBinding: ResultRefBinding | undefined
        try {
          const written = writeResultRecord({
            childId: running.id,
            name: running.name,
            summary: result.summary,
            sessionFile: result.sessionFile ?? null,
            ...(result.usage ? { usage: result.usage } : {}),
          })
          const ref = allocateSemanticRef(
            running.name,
            undefined,
            written.canonicalId,
          )
          resultRef = ref
          resultPath = written.path
          resultBinding = { ref, canonicalId: written.canonicalId }
        } catch {}

        pi.sendMessage(
          {
            customType: 'subagent_result',
            content: presentation,
            display: true,
            details: {
              name: running.name,
              task: running.task,
              agent: running.agent,
              exitCode: result.exitCode,
              elapsed: result.elapsed,
              sessionFile: result.sessionFile,
              ...(running.worktree
                ? { worktree: running.worktree, branch: running.branch }
                : {}),
              ...(result.errorMessage
                ? { errorMessage: result.errorMessage }
                : {}),
              ...(result.usage ? { usage: result.usage } : {}),
              ...(result.claudeSessionId
                ? { claudeSessionId: result.claudeSessionId }
                : {}),
              ...(resultRef && resultPath && resultBinding
                ? {
                    resultRef,
                    resultPath,
                    resultBinding,
                  }
                : {}),
            },
          },
          { triggerTurn: true, deliverAs: 'steer' },
        )
      } catch {}
    })
    .catch((err) => {
      try {
        updateWidget()
        pi.sendMessage(
          {
            customType: 'subagent_result',
            content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
            display: true,
            details: {
              name: running.name,
              task: running.task,
              error: err?.message,
            },
          },
          { triggerTurn: true, deliverAs: 'steer' },
        )
      } catch {}
    })
}

export default function subagentsExtension(pi: ExtensionAPI) {
  // Capture the UI context for widget updates
  latestPi = pi

  // Re-attach watchers orphaned by an extension /reload. The previous module
  // load aborted its poll loops (POLL_ABORT_KEY reset above) and cleared each
  // entry's watching flag; entries survive via the globalThis Map.
  let reattached = 0
  for (const running of runningSubagents.values()) {
    if (running.watching) continue
    runWatcher(pi, running)
    reattached++
  }
  if (reattached > 0) {
    startWidgetRefresh()
    startStatusRefresh(pi)
  }
  pi.on('session_start', (_event, ctx) => {
    latestCtx = ctx
    // AIDEV-NOTE: parent session id names THIS session's owner inbox —
    // children spawned by us route message_owner records here (PMR-QCVA).
    ownerSessionId = ctx.sessionManager.getSessionId() ?? null
    // AIDEV-NOTE: load per session so a project override written mid-run is
    // honored on the next session. Throws on invalid config — fail fast.
    loadAndCacheStatusConfig(ctx.cwd)
  })

  // AIDEV-NOTE (PMR-1EC3): context retirement. session_before_compact is the
  // pressure signal ONLY — we never cancel or replace pi's compaction, so
  // manual/overflow compaction runs untouched and there is no loop-block.
  // Once armed, the context hook retires settled subagent payloads (large
  // subagent_result/ask/message steers) to durable refs per request; the
  // session file keeps full records, only model-visible context shrinks.
  pi.on('session_before_compact', (event) => {
    if (!shouldArmRetirement(event.reason, getRetirementEnabled())) {
      return undefined
    }
    ;(globalThis as Record<symbol, unknown>)[RETIREMENT_ARMED_KEY] = true
    return undefined
  })

  pi.on('context', (event) => {
    if (!isRetirementArmed()) return undefined
    const outcome = retireSettledSubagentPayloads(event.messages)
    if (outcome.retired === 0) return undefined
    return { messages: outcome.messages }
  })

  // Clean up on session shutdown
  pi.on('session_shutdown', (_event, _ctx) => {
    if (statusInterval) {
      clearInterval(statusInterval)
      statusInterval = null
      ;(globalThis as any)[STATUS_INTERVAL_KEY] = null
    }
    // AIDEV-NOTE (PMR-Z5KR): children with a durable assignment record are
    // SPARED — their herdr-owned tab keeps running and a future parent
    // rediscovers the record as an orphan with a resume hint (work survives
    // orchestrator death). Decide sparing BEFORE aborting any watcher: the
    // watcher catch path consults sparedAssignments to skip its own
    // closeSurface + lost-marking. Children without a record keep the old
    // kill behavior (nobody would ever rediscover them). Interactive agents
    // and blocked-asking children stay spared as before (their records make
    // this a superset of the old rule).
    for (const [id, agent] of runningSubagents) {
      let spared = agent.interactive
      if (!spared) {
        try {
          spared = existsSync(assignmentPath(id))
        } catch {}
      }
      if (!spared && agent.cli !== 'claude' && agent.sessionFile) {
        try {
          spared = existsSync(`${agent.sessionFile}.ask`)
        } catch {}
      }
      if (spared) sparedAssignments.add(id)
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as
      | AbortController
      | undefined
    if (moduleAbort) moduleAbort.abort()
    for (const [id, agent] of runningSubagents) {
      agent.abortController?.abort()
      if (!sparedAssignments.has(id)) {
        try {
          closeSurface(agent.surface, agent.tabId)
        } catch {}
      }
    }
    runningSubagents.clear()
  })

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter).
  // Only honor this in actual subagent sessions (identified by PI_SUBAGENT_ID/SESSION);
  // in the main Pi session PI_DENY_TOOLS should not suppress tools.
  const isSubagentSession =
    !!process.env.PI_SUBAGENT_ID || !!process.env.PI_SUBAGENT_SESSION
  const deniedTools = isSubagentSession
    ? new Set(
        (process.env.PI_DENY_TOOLS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : new Set<string>()

  const shouldRegister = (name: string) => !deniedTools.has(name)

  // ── subagent tool ──
  if (shouldRegister('subagent'))
    pi.registerTool({
      name: 'subagent',
      label: 'Subagent',
      description:
        'Spawn a sub-agent in a dedicated terminal multiplexer pane. ' +
        'This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. ' +
        'When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. ' +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        'DO NOT fabricate, assume, or summarize results after calling this tool. ' +
        'After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready. ' +
        'Set worktree: true to run the sub-agent in a fresh isolated git worktree (its cwd); the worktree outlives the child and is removed manually.',
      promptSnippet:
        'Spawn a sub-agent in a dedicated terminal multiplexer pane. ' +
        'This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. ' +
        'When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. ' +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        'DO NOT fabricate, assume, or summarize results after calling this tool. ' +
        'After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready. ' +
        'Set worktree: true to run the sub-agent in a fresh isolated git worktree (its cwd); the worktree outlives the child and is removed manually.',
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: 'text',
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: 'self-spawn blocked' },
          }
        }

        // PMR-RKH5: manager-approval gate — model-invoked spawns of a gated
        // agent are denied; the user running /subagent IS the approval.
        const spawnGateDefs = params.agent
          ? loadAgentDefaults(params.agent)
          : null
        const spawnDenial = managerApprovalDenial(spawnGateDefs, params.agent)
        if (spawnDenial) {
          return {
            content: [{ type: 'text', text: spawnDenial }],
            details: { error: 'manager-approval required' },
          }
        }

        // Validate prerequisites (herdr version gate, actionable message)
        try {
          herdrPreflight()
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: err?.message ?? String(err) }],
            details: { error: 'herdr preflight failed' },
          }
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: no session file. Start pi with a persistent session to use subagents.',
              },
            ],
            details: { error: 'no session file' },
          }
        }

        // Launch the subagent (creates pane, sends command)
        const running = await launchSubagent(params, ctx)

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh()
        startStatusRefresh(pi)

        // Fire-and-forget: start watching in background
        runWatcher(pi, running)

        // Return immediately
        return {
          content: [
            {
              type: 'text',
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            paneId: running.paneId,
            ...(running.worktree
              ? { worktree: running.worktree, branch: running.branch }
              : {}),
            status: 'started',
          },
        }
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>
        const name =
          typeof partialArgs.name === 'string' && partialArgs.name
            ? partialArgs.name
            : '(unnamed)'
        const task =
          typeof partialArgs.task === 'string' ? partialArgs.task : ''
        const agent =
          typeof partialArgs.agent === 'string' && partialArgs.agent
            ? theme.fg('dim', ` (${partialArgs.agent})`)
            : ''
        const cwdHint =
          typeof partialArgs.cwd === 'string' && partialArgs.cwd
            ? theme.fg('dim', ` in ${partialArgs.cwd}`)
            : ''
        let text = `▸ ${theme.fg('toolTitle', theme.bold(name))}${agent}${cwdHint}`

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split('\n').find((l: string) => l.trim()) ?? ''
          const preview =
            firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine
          if (preview) {
            text += `\n${theme.fg('toolOutput', preview)}`
          }
          const totalLines = task.split('\n').length
          if (totalLines > 1) {
            text += theme.fg('muted', ` (${totalLines} lines)`)
          }
        }

        return new Text(text, 0, 0)
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any
        const name = details?.name ?? '(unnamed)'

        // "Started" result — tool returned immediately
        if (details?.status === 'started') {
          return new Text(
            theme.fg('accent', '▸') +
              ' ' +
              theme.fg('toolTitle', theme.bold(name)) +
              theme.fg('dim', ' — started'),
            0,
            0,
          )
        }

        // Fallback (shouldn't happen)
        const first = result.content[0]
        const text =
          first && first.type === 'text' && typeof first.text === 'string'
            ? first.text
            : ''
        return new Text(theme.fg('dim', text), 0, 0)
      },
    })

  // ── subagent_interrupt tool ──
  if (shouldRegister('subagent_interrupt'))
    pi.registerTool({
      name: 'subagent_interrupt',
      label: 'Interrupt Subagent',
      description:
        'Send Escape to the active turn of a currently running Pi-backed subagent. ' +
        'The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement ' +
        'and does not emit a subagent_result solely because of this request.',
      promptSnippet:
        'Send Escape to the active turn of a currently running Pi-backed subagent. ' +
        'The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement ' +
        'and does not emit a subagent_result solely because of this request.',
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: 'Exact running subagent id' }),
        ),
        name: Type.Optional(
          Type.String({ description: 'Exact running subagent display name' }),
        ),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params)
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : (args.name ?? '(unknown)')
        return new Text(
          theme.fg('accent', '▸') +
            ' ' +
            theme.fg('toolTitle', theme.bold(target)) +
            theme.fg('dim', ' — interrupt turn'),
          0,
          0,
        )
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any
        if (details?.status === 'interrupt_requested') {
          return new Text(
            theme.fg('accent', '▸') +
              ' ' +
              theme.fg(
                'toolTitle',
                theme.bold(details.name ?? details.id ?? 'subagent'),
              ) +
              theme.fg('dim', ' — interrupt requested'),
            0,
            0,
          )
        }

        const first = result.content[0]
        const text =
          first && first.type === 'text' && typeof first.text === 'string'
            ? first.text
            : ''
        return new Text(theme.fg('dim', text), 0, 0)
      },
    })

  // ── subagents_list tool ──
  if (shouldRegister('subagents_list'))
    pi.registerTool({
      name: 'subagents_list',
      label: 'List Subagents',
      description:
        'List all available subagent definitions. ' +
        'Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. ' +
        'Project-local agents override global ones with the same name. ' +
        'Also lists durable subagent assignments (<agentDir>/pi-subagents/assignments/) — ' +
        'running children owned by a live parent and ORPHANED children whose parent ' +
        'process is gone (with a subagent_resume hint), so a restarted parent can ' +
        'rediscover work that survived it.',
      promptSnippet:
        'List all available subagent definitions. ' +
        'Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. ' +
        'Project-local agents override global ones with the same name. ' +
        'Also lists durable subagent assignments (running + orphaned children with resume hints).',
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter(
          (agent) => !agent.disableModelInvocation,
        )
        // PMR-Z5KR: answer "what is running" from FILES ALONE — the scan
        // works for a freshly restarted parent with an empty in-memory map.
        const assignments = listAssignments()

        if (list.length === 0 && assignments.length === 0) {
          return {
            content: [{ type: 'text', text: 'No subagent definitions found.' }],
            details: { agents: [], assignments: [], usageSuffixes: {} },
          }
        }

        const lines = list.map((a) => {
          const badge = a.source === 'project' ? ' (project)' : ''
          const desc = a.description ? ` — ${a.description}` : ''
          const model = a.model ? ` [${a.model}]` : ''
          return `• ${a.name}${badge}${model}${desc}`
        })

        const usageSuffixes: Record<string, string> = {}
        if (assignments.length > 0) {
          lines.push('', 'Assignments (durable — survive parent restart):')
          // PMR-874G: transitive token/cost rollup over the ownership graph
          // (child session `parentSession` headers). Settled usage on the
          // record wins; live sessions are re-read. Coverage gaps are
          // flagged, never filled with invented numbers.
          const usageNodes: UsageOwnershipNode[] = []
          for (const view of assignments) {
            if (view.state === 'unknown') continue
            let summary: UsageSummary | null = null
            if (view.record.usage) {
              summary = { totals: view.record.usage, sawUsage: true }
            } else {
              summary = readSessionUsage(view.record.sessionFile)
            }
            usageNodes.push({
              childId: view.record.childId,
              sessionFile: view.record.sessionFile,
              parentSessionFile: readSessionParentFile(view.record.sessionFile),
              summary,
            })
          }
          const rollups = rollupUsageByOwnership(usageNodes)
          for (const node of usageNodes) {
            usageSuffixes[node.childId] = usageSuffixFor(node, rollups)
          }
          for (const view of assignments) {
            if (view.state === 'unknown') {
              lines.push(
                `• ${view.childId} — unknown (unreadable assignment record; no action taken)`,
              )
            } else if (view.state === 'owned') {
              const usage = usageSuffixes[view.record.childId] ?? ''
              lines.push(
                `• ${view.record.name} [${view.record.childId}] — running (${view.record.status})${usage}`,
              )
            } else {
              const usage = usageSuffixes[view.record.childId] ?? ''
              let line = `• ${view.record.name} [${view.record.childId}] — ORPHANED (parent process gone, child tab may still be running)${usage}`
              if (view.resumeHint) {
                line += ` — resume with ${view.resumeHint}`
              }
              lines.push(line)
            }
          }
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: { agents: list, assignments, usageSuffixes },
        }
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any
        const agents = details?.agents ?? []
        const assignments = details?.assignments ?? []
        const usageSuffixes = details?.usageSuffixes ?? {}
        if (agents.length === 0 && assignments.length === 0) {
          return new Text(
            theme.fg('dim', 'No subagent definitions found.'),
            0,
            0,
          )
        }
        const lines = agents.map((a: any) => {
          const badge =
            a.source === 'project' ? theme.fg('accent', ' (project)') : ''
          const desc = a.description
            ? theme.fg('dim', ` — ${a.description}`)
            : ''
          const model = a.model ? theme.fg('dim', ` [${a.model}]`) : ''
          return `  ${theme.fg('toolTitle', theme.bold(a.name))}${badge}${model}${desc}`
        })
        if (assignments.length > 0) {
          lines.push(
            '',
            `  ${theme.fg('toolTitle', theme.bold('Assignments'))}${theme.fg('dim', ' (durable)')}`,
          )
          for (const view of assignments) {
            if (view.state === 'unknown') {
              lines.push(
                `  ${theme.fg('dim', `${view.childId} — unknown (unreadable record)`)}`,
              )
            } else if (view.state === 'owned') {
              const usage = usageSuffixes[view.childId] ?? ''
              lines.push(
                `  ${theme.fg('toolTitle', theme.bold(view.record.name))}${theme.fg('dim', ` [${view.childId}] — running (${view.record.status})${usage}`)}`,
              )
            } else {
              const usage = usageSuffixes[view.childId] ?? ''
              lines.push(
                `  ${theme.fg('toolTitle', theme.bold(view.record.name))}${theme.fg('warning', ` [${view.childId}] — ORPHANED`)}${theme.fg('dim', `${usage}, resume: subagent_resume`)}`,
              )
            }
          }
        }
        return new Text(lines.join('\n'), 0, 0)
      },
    })

  // ── subagent_resume tool ──
  if (shouldRegister('subagent_resume'))
    pi.registerTool({
      name: 'subagent_resume',
      label: 'Resume Subagent',
      description:
        "Resume a previous sub-agent session in a background herdr tab, REATTACHING to the live tab when the durable assignment record shows the session's agent still running (never two processes on one session file). " +
        'This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. ' +
        'When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. ' +
        'DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. ' +
        'DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. ' +
        'Use when a sub-agent was cancelled or needs follow-up work.',
      promptSnippet:
        "Resume a previous sub-agent session in a background herdr tab, REATTACHING to the live tab when the durable assignment record shows the session's agent still running (never two processes on one session file). " +
        'This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. ' +
        'When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. ' +
        'DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. ' +
        'DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. ' +
        'Use when a sub-agent was cancelled or needs follow-up work.',
      parameters: Type.Object({
        sessionPath: Type.String({
          description: 'Path to the session .jsonl file to resume',
        }),
        name: Type.Optional(
          Type.String({
            description: "Display name for the terminal tab. Default: 'Resume'",
          }),
        ),
        message: Type.Optional(
          Type.String({
            description:
              'Optional message to send after resuming (e.g. follow-up instructions)',
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              'Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.',
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? 'Resume'
        const text =
          '▸ ' +
          theme.fg('toolTitle', theme.bold(name)) +
          theme.fg('dim', ' — resuming session')
        return new Text(text, 0, 0)
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any
        const name = details?.name ?? 'Resume'

        if (details?.status === 'started') {
          return new Text(
            theme.fg('accent', '▸') +
              ' ' +
              theme.fg('toolTitle', theme.bold(name)) +
              theme.fg('dim', ' — resumed'),
            0,
            0,
          )
        }

        if (details?.status === 'reattached') {
          return new Text(
            theme.fg('accent', '⇄') +
              ' ' +
              theme.fg('toolTitle', theme.bold(name)) +
              theme.fg('dim', ' — reattached to running agent'),
            0,
            0,
          )
        }

        // Fallback
        const first = result.content[0]
        const text =
          first && first.type === 'text' && typeof first.text === 'string'
            ? first.text
            : ''
        return new Text(theme.fg('dim', text), 0, 0)
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? 'Resume'
        const { autoExit, interactive } = resolveResumeLaunchBehavior(params)
        const startTime = Date.now()
        const id = Math.random().toString(16).slice(2, 10)

        try {
          herdrPreflight()
        } catch (err: any) {
          return {
            content: [{ type: 'text', text: err?.message ?? String(err) }],
            details: { error: 'herdr preflight failed' },
          }
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: session file not found: ${params.sessionPath}`,
              },
            ],
            details: { error: 'session not found' },
          }
        }

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length

        const subagentDonePath = join(SUBAGENTS_DIR, 'subagent-done.ts')
        const sessionId = ctx.sessionManager.getSessionId()
        const artifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          sessionId,
        )
        const activityFile = getSubagentActivityFile(artifactDir, id)
        mkdirSync(dirname(activityFile), { recursive: true })

        // ── Reattach probe (PMR-N53A) ──
        // AIDEV-NOTE (PMR-N53A): two-process hazard — a plain spawn on a
        // session whose child pi process is STILL ALIVE (a shutdown-spared
        // orphan in its herdr tab) puts TWO pi processes on one session
        // jsonl. When the durable assignment record's pane still hosts a
        // live agent we REATTACH below instead of spawning: same paneId/
        // tabId/sessionFile, the resume message is steered into the live
        // child via its peer inbox (the child's 500ms pump delivers it as a
        // new turn), and the record is re-claimed under THIS parent so
        // subagents_list drops the orphan resume hint. We deliberately do
        // NOT clear the `.ask` sidecar / ask records on this path — the live
        // child may be mid ask/answer protocol and deleting its half would
        // hang it. No focus is stolen (same --no-focus discipline as spawn).
        const reattachCandidates: AssignmentRecord[] = []
        for (const view of listAssignments()) {
          if (view.state === 'unknown') continue
          reattachCandidates.push(view.record)
        }
        const reattachRecord = latestAssignmentForSession(
          reattachCandidates,
          params.sessionPath,
        )
        let reattachClaimAlive = false
        let reattachPaneAlive = false
        let reattachSteerCapable = true
        if (reattachRecord) {
          reattachClaimAlive = pidAlive(reattachRecord.claim.pid)
          if (reattachRecord.paneId) {
            try {
              reattachPaneAlive = herdrAgentGet(reattachRecord.paneId) !== null
            } catch {
              reattachPaneAlive = false
            }
          }
          if (reattachRecord.agent) {
            const reattachDefs = loadAgentDefaults(reattachRecord.agent)
            if (reattachDefs?.cli === 'claude') reattachSteerCapable = false
          }
        }
        const reattachDecision = decideResumeReattach({
          record: reattachRecord,
          pidAlive: reattachClaimAlive,
          agentAlive: reattachPaneAlive,
          steerCapable: reattachSteerCapable,
        })

        if (reattachDecision.action === 'reattach') {
          const record = reattachDecision.record
          const paneId = record.paneId
          if (paneId) {
            // Steer the follow-up into the LIVE child via its durable peer
            // inbox; without a message there is nothing to steer — adopt the
            // entry and watch the child's own lifecycle instead.
            let steered = false
            if (params.message) {
              try {
                sendPeerMessage({
                  toChildId: record.childId,
                  from: {
                    childId: `parent-${sessionId ?? 'unknown'}`,
                    sessionFile: ctx.sessionManager.getSessionFile() ?? '',
                    name: 'owner',
                    cwd: ctx.cwd,
                  },
                  message: params.message,
                })
                steered = true
              } catch {}
            }

            const existing = runningSubagents.get(record.childId)
            if (existing) {
              // Already tracked by THIS parent (e.g. kept alive across an
              // extension /reload) — its watcher is still attached; only
              // refresh the resume baseline for summary extraction.
              existing.resumeEntryCount = entryCountBefore
            } else {
              const running: RunningSubagent = {
                id: record.childId,
                name: record.name,
                task: params.message ?? 'reattached running session',
                agent: record.agent,
                surface: paneId,
                paneId,
                tabId: record.tabId,
                workspaceId: record.workspaceId,
                startTime,
                sessionFile: params.sessionPath,
                activityFile: record.activityFile,
                interactive,
                resumeEntryCount: entryCountBefore,
                statusState: createStatusState({
                  source: 'pi',
                  startTimeMs: startTime,
                }),
              }
              runningSubagents.set(running.id, running)
              // Re-claim under THIS parent: the fresh claim pid makes
              // listAssignments classify the record owned again, so the
              // orphaned marker + resume hint disappear from subagents_list.
              persistAssignment(running, record.cwd, sessionId ?? null)
              startWidgetRefresh()
              startStatusRefresh(pi)
              runWatcher(pi, running)
            }
            let ackText = `Reattached to running session "${record.name}".`
            if (steered) {
              ackText = `Reattached to running session "${record.name}" and steered the follow-up message into it.`
            }
            return {
              content: [{ type: 'text', text: ackText }],
              details: {
                id: record.childId,
                name: record.name,
                sessionPath: params.sessionPath,
                paneId,
                status: 'reattached',
              },
            }
          }
        }

        const argv = [
          'pi',
          '--session',
          params.sessionPath,
          '-e',
          subagentDonePath,
        ]
        if (params.message) {
          const msgTimestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
            .slice(0, 19)
          const resumeMsgFile = join(
            artifactDir,
            'subagent-resume',
            `${
              name
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '') || 'resume'
            }-${msgTimestamp}.md`,
          )
          mkdirSync(dirname(resumeMsgFile), { recursive: true })
          writeFileSync(resumeMsgFile, params.message, 'utf8')
          argv.push(`@${resumeMsgFile}`)
        }

        const env: Record<string, string> = {
          // AIDEV-NOTE: EPIMETHEUS_ENABLED=false on resume too — see spawn-site
          // note above.
          EPIMETHEUS_ENABLED: 'false',
          PI_SUBAGENT_NAME: name,
          PI_SUBAGENT_SESSION: params.sessionPath,
          PI_SUBAGENT_ID: id,
          PI_SUBAGENT_ACTIVITY_FILE: activityFile,
          // Owner-inbox routing key (PMR-QCVA) — see spawn-site note above.
          PI_SUBAGENT_PARENT_SESSION: sessionId,
        }
        if (process.env.PI_CODING_AGENT_DIR) {
          env.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
        }
        if (autoExit) {
          env.PI_SUBAGENT_AUTO_EXIT = '1'
        }

        // Resume reuses the original session file path — clear stale completion
        // markers from the previous run so the watcher doesn't fire instantly.
        // A stale `.ask`/ask record would also reattach as blocked-asking;
        // resume is a fresh start for the ask protocol (PMR-WXG0).
        rmSync(`${params.sessionPath}.exit`, { force: true })
        rmSync(`${params.sessionPath}.ask`, { force: true })
        try {
          removeAskRecordsForSession(params.sessionPath)
        } catch {}

        const workspaceId = resolveHerdrWorkspaceId()
        if (!workspaceId) {
          return muxUnavailableResult()
        }

        let tab: HerdrSpawnedTab
        try {
          tab = await spawnAgentInTab({
            workspaceId,
            cwd: ctx.cwd,
            label: name,
            env,
            kind: 'pi',
            argv,
            alias: `pi-subagent-${id}`,
          })
        } catch (err: any) {
          return {
            content: [
              {
                type: 'text',
                text: `Resume failed: ${err?.message ?? String(err)}`,
              },
            ],
            details: { error: err?.message ?? String(err) },
          }
        }

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? 'resumed session',
          surface: tab.paneId,
          paneId: tab.paneId,
          tabId: tab.tabId,
          workspaceId: tab.workspaceId,
          startTime,
          sessionFile: params.sessionPath,
          activityFile,
          interactive,
          resumeEntryCount: entryCountBefore,
          statusState: createStatusState({
            source: 'pi',
            startTimeMs: startTime,
          }),
        }
        runningSubagents.set(id, running)
        persistAssignment(running, ctx.cwd, sessionId ?? null)
        startWidgetRefresh()
        startStatusRefresh(pi)

        // Fire-and-forget watcher
        runWatcher(pi, running)

        return {
          content: [{ type: 'text', text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            paneId: tab.paneId,
            status: 'started',
          },
        }
      },
    })

  // ── answer_subagent tool (PMR-WXG0) ──
  pi.registerTool({
    name: 'answer_subagent',
    label: 'Answer Subagent',
    description:
      'Reply to a blocked sub-agent that asked you a question via ask_owner. ' +
      'Queues your message for delivery into the sub-agent\u2019s SAME session (it arrives as its next user message); the sub-agent continues afterwards. ' +
      'Use the askId from the subagent_ask message when available. Do not use this for completed sub-agents — use subagent_resume for follow-up work instead.',
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: 'Subagent id (from the subagent_ask message)',
        }),
      ),
      name: Type.Optional(
        Type.String({ description: 'Exact subagent display name' }),
      ),
      askId: Type.Optional(
        Type.String({ description: 'Ask id to answer (correlation check)' }),
      ),
      message: Type.String({ description: 'The answer / reply to deliver' }),
    }),
    renderCall(args, theme) {
      const target = args.name ?? args.id ?? 'subagent'
      const text =
        '▸ ' +
        theme.fg('toolTitle', theme.bold('Answer')) +
        theme.fg('dim', ` — ${target}`)
      return new Text(text, 0, 0)
    },
    renderResult(result, _opts, theme) {
      const details = result.details as any
      if (details?.status === 'queued') {
        return new Text(
          theme.fg('success', '✓') +
            ' ' +
            theme.fg('toolTitle', theme.bold(details.name ?? 'subagent')) +
            theme.fg('dim', ' — answer queued for delivery'),
          0,
          0,
        )
      }
      const first = result.content[0]
      const text =
        first && first.type === 'text' && typeof first.text === 'string'
          ? first.text
          : ''
      return new Text(theme.fg('dim', text), 0, 0)
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        herdrPreflight()
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: err?.message ?? String(err) }],
          details: { error: 'herdr preflight failed' },
        }
      }

      const resolved = resolveInterruptTarget({
        id: params.id,
        name: params.name,
      })
      if ('error' in resolved) {
        return {
          content: [{ type: 'text', text: resolved.error }],
          details: { error: resolved.error },
        }
      }
      const running = resolved.running

      // Identity revalidation (herdsman discipline): the durable ask record
      // must name this childId + sessionFile, and (when given) the askId.
      const record = readAskRecord(running.id)
      if (!record) {
        const error = `Subagent "${running.name}" has no outstanding ask.`
        return {
          content: [{ type: 'text', text: error }],
          details: { error, id: running.id },
        }
      }
      const identityOk = askIdentityMatches({
        record,
        askId: params.askId,
        childId: running.id,
        sessionFile: running.sessionFile,
      })
      if (!identityOk) {
        const error =
          `Ask record mismatch for "${running.name}" (askId ${record.askId}). ` +
          'Refusing to deliver a reply to a superseded ask.'
        return {
          content: [{ type: 'text', text: error }],
          details: { error, id: running.id, askId: record.askId },
        }
      }

      // AIDEV-NOTE: at-least-once reply delivery via the mailbox pump
      // (PMR-WXG0 phase 5, no pane typing). The reply record is durable
      // BEFORE the child's pump can observe it; the `.ask` sidecar (the
      // "still pending" marker) is cleared here so the ask stops re-steering
      // the parent. The child's pump delivers the answer into its own session
      // and acks ingestion; confirmation rides the 1s status loop via a
      // pendingRequest (kind 'answer') correlated on the `.ack` sidecar. If
      // ingestion is not confirmed within the bounded window, the reply record
      // REMAINS — the child (or a resumed session) still picks it up; only the
      // stale `.ack` sidecar is cleaned.
      writeReplyRecord(running.id, {
        askId: record.askId,
        message: params.message,
        repliedAt: new Date().toISOString(),
      })
      removeAskSidecar(running.sessionFile)
      running.statusState = markPendingRequest(running.statusState, {
        requestId: record.askId,
        kind: 'answer',
        sentAtMs: Date.now(),
      })
      updateWidget()

      return {
        content: [
          {
            type: 'text',
            text: `Answer queued for "${running.name}". It will arrive in the same session as its next user message; ingestion is confirmed in the status line.`,
          },
        ],
        details: {
          id: running.id,
          name: running.name,
          askId: record.askId,
          status: 'queued',
        },
      }
    },
  })

  // /iterate command — fork the session into a subagent
  pi.registerCommand('iterate', {
    description:
      'Fork session into a subagent for focused work (bugfixes, iteration)',
    handler: async (args, _ctx) => {
      const task = args.trim() || ''
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`
      pi.sendUserMessage(toolCall)
    },
  })

  // /subagent command — spawn a subagent by name
  pi.registerCommand('subagent', {
    description: 'Spawn a subagent: /subagent <agent> <task>',
    handler: async (args, ctx) => {
      const trimmed = args.trim()
      if (!trimmed) {
        ctx.ui.notify('Usage: /subagent <agent> [task]', 'warning')
        return
      }

      const spaceIdx = trimmed.indexOf(' ')
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
      const task = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

      const defs = loadAgentDefaults(agentName)
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          'error',
        )
        return
      }

      const taskText =
        task || `You are the ${agentName} agent. Wait for instructions.`
      const displayName = agentName[0].toUpperCase() + agentName.slice(1)

      // AIDEV-NOTE (PMR-RKH5): manager-approval agents spawn directly from
      // this command — user initiation IS the approval. The model tool path
      // below (sendUserMessage → subagent tool) would hit the denial gate.
      if (defs.spawning === 'manager-approval') {
        try {
          const running = await launchSubagent(
            { agent: agentName, name: displayName, task: taskText },
            ctx,
          )
          startWidgetRefresh()
          startStatusRefresh(pi)
          runWatcher(pi, running)
          ctx.ui.notify(
            `Subagent "${displayName}" launched (user-approved).`,
            'info',
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.ui.notify(`Failed to spawn ${agentName}: ${message}`, 'error')
        }
        return
      }

      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`
      pi.sendUserMessage(toolCall)
    },
  })

  // /subagents command — keyboard fallback for click-to-open (PMR-TABUX).
  // Mouse-unavailable terminals pick a running agent here; selection goes
  // through the SAME verified focus path as a widget click.
  pi.registerCommand('subagents', {
    description: 'List running subagents and focus the selected one',
    handler: async (_args, ctx) => {
      const entries = [...runningSubagents.values()].filter(
        (entry) => !entry.starting && entry.paneId,
      )
      if (entries.length === 0) {
        ctx.ui.notify('No running subagents.', 'info')
        return
      }
      const labels = entries.map((entry) => `${entry.name} (${entry.id})`)
      const picked = await ctx.ui.select('Running subagents', labels)
      if (picked === undefined) return
      const idx = labels.indexOf(picked)
      if (idx === -1) return
      const result = focusSubagentById(entries[idx].id)
      if (!result.ok) {
        ctx.ui.notify(result.message, 'warning')
      }
    },
  })

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer('subagent_result', (message, options, theme) => {
    const details = message.details as any
    if (!details) return undefined

    return {
      render(width: number): string[] {
        const name = details.name ?? 'subagent'
        const exitCode = details.exitCode ?? 0
        const errorMessage =
          typeof details.errorMessage === 'string' ? details.errorMessage : ''
        const failed = exitCode !== 0 || !!errorMessage
        const elapsed =
          details.elapsed != null ? formatElapsed(details.elapsed) : '?'
        const bgFn = failed
          ? (text: string) => theme.bg('toolErrorBg', text)
          : (text: string) => theme.bg('toolSuccessBg', text)
        const icon = failed ? theme.fg('error', '✗') : theme.fg('success', '✓')
        const status = errorMessage
          ? 'failed (provider/agent error)'
          : failed
            ? `failed (exit ${exitCode})`
            : 'completed'
        const agentTag = details.agent
          ? theme.fg('dim', ` (${details.agent})`)
          : ''

        const header = `${icon} ${theme.fg('toolTitle', theme.bold(name))}${agentTag} ${theme.fg('dim', '—')} ${status} ${theme.fg('dim', `(${elapsed})`)}`
        const rawContent =
          typeof message.content === 'string' ? message.content : ''

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, '')
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, '')
          .replace(
            `Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`,
            '',
          )
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            '',
          )

        // Build content for the box
        const contentLines = [header]

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split('\n')) {
              contentLines.push(line.slice(0, width - 6))
            }
          }
          if (details.sessionFile) {
            contentLines.push('')
            contentLines.push(
              theme.fg('dim', `Session: ${details.sessionFile}`),
            )
            contentLines.push(
              theme.fg('dim', `Resume:  pi --session ${details.sessionFile}`),
            )
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split('\n').slice(0, 5)
            for (const line of previewLines) {
              contentLines.push(theme.fg('dim', line.slice(0, width - 6)))
            }
            const totalLines = summary.split('\n').length
            if (totalLines > 5) {
              contentLines.push(
                theme.fg('muted', `… ${totalLines - 5} more lines`),
              )
            }
          }
          contentLines.push(
            theme.fg('muted', keyHint('app.tools.expand', 'to expand')),
          )
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn)
        box.addChild(new Text(contentLines.join('\n'), 0, 0))
        return ['', ...box.render(width)]
      },
    } as any
  })

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer('subagent_status', (message, options, theme) => {
    const details = message.details as any
    const lines = Array.isArray(details?.lines) ? details.lines : []
    const overflow =
      typeof details?.overflow === 'number' ? details.overflow : 0
    if (lines.length === 0 && overflow === 0) return undefined

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6)
        const contentLines = [
          `${theme.fg('accent', '•')} ${theme.fg('toolTitle', theme.bold('Subagent status'))}`,
          ...lines.map((line: string) =>
            theme.fg('dim', truncateToWidth(line, lineWidth)),
          ),
        ]

        if (overflow > 0) {
          contentLines.push(theme.fg('muted', `+${overflow} more running.`))
        }
        if (!options.expanded) {
          contentLines.push(
            theme.fg('muted', keyHint('app.tools.expand', 'to expand')),
          )
        }

        const box = new Box(1, 1, (text: string) =>
          theme.bg('customMessageBg', text),
        )
        box.addChild(new Text(contentLines.join('\n'), 0, 0))
        return ['', ...box.render(width)]
      },
    } as any
  })

  // ── subagent_message message renderer (PMR-QCVA) ──
  pi.registerMessageRenderer('subagent_message', (message, options, theme) => {
    const details = message.details as any
    const lines = Array.isArray(details?.lines) ? details.lines : []
    const overflow =
      typeof details?.overflow === 'number' ? details.overflow : 0
    if (lines.length === 0 && overflow === 0) return undefined

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6)
        const contentLines = [
          `${theme.fg('accent', '✉')} ${theme.fg('toolTitle', theme.bold('Subagent messages'))}`,
          ...lines.map((line: string) =>
            theme.fg('dim', truncateToWidth(line, lineWidth)),
          ),
        ]

        if (overflow > 0) {
          contentLines.push(theme.fg('muted', `+${overflow} more messages.`))
        }
        if (!options.expanded) {
          contentLines.push(
            theme.fg('muted', keyHint('app.tools.expand', 'to expand')),
          )
        }

        const box = new Box(1, 1, (text: string) =>
          theme.bg('customMessageBg', text),
        )
        box.addChild(new Text(contentLines.join('\n'), 0, 0))
        return ['', ...box.render(width)]
      },
    } as any
  })

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer('subagent_ping', (message, options, theme) => {
    const details = message.details as any
    if (!details) return undefined

    return {
      render(width: number): string[] {
        const name = details.name ?? 'subagent'
        const agentTag = details.agent
          ? theme.fg('dim', ` (${details.agent})`)
          : ''
        const bgFn = (text: string) => theme.bg('toolSuccessBg', text)

        const icon = theme.fg('accent', '?')
        const header = `${icon} ${theme.fg('toolTitle', theme.bold(name))}${agentTag} ${theme.fg('dim', '— needs help')}`

        const contentLines = [header]

        if (options.expanded) {
          contentLines.push('')
          contentLines.push(details.message ?? '')
          if (details.sessionFile) {
            contentLines.push('')
            contentLines.push(
              theme.fg('dim', `Session: ${details.sessionFile}`),
            )
          }
        } else {
          const preview = (details.message ?? '')
            .split('\n')[0]
            .slice(0, width - 10)
          contentLines.push(theme.fg('dim', preview))
          contentLines.push(
            theme.fg('muted', keyHint('app.tools.expand', 'to expand')),
          )
        }

        const box = new Box(1, 1, bgFn)
        box.addChild(new Text(contentLines.join('\n'), 0, 0))
        return ['', ...box.render(width)]
      },
    } as any
  })

  // ── subagent_ask message renderer (PMR-WXG0) ──
  pi.registerMessageRenderer('subagent_ask', (message, options, theme) => {
    const details = message.details as any
    if (!details) return undefined

    return {
      render(width: number): string[] {
        const name = details.name ?? 'subagent'
        const header = `${theme.fg('accent', '?')} ${theme.fg('toolTitle', theme.bold(name))}${theme.fg('dim', ' — asks owner (blocked)')}`

        const contentLines = [header]

        if (options.expanded) {
          contentLines.push('')
          contentLines.push(details.question ?? '')
          if (Array.isArray(details.files) && details.files.length > 0) {
            contentLines.push('')
            contentLines.push(
              theme.fg('dim', `Files: ${details.files.join(', ')}`),
            )
          }
          if (details.askId) {
            contentLines.push('')
            contentLines.push(
              theme.fg(
                'dim',
                `Answer: answer_subagent (id: ${details.childId}, askId: ${details.askId})`,
              ),
            )
          }
        } else {
          const preview = (details.question ?? '')
            .split('\n')[0]
            .slice(0, width - 10)
          contentLines.push(theme.fg('dim', preview))
          contentLines.push(
            theme.fg('muted', keyHint('app.tools.expand', 'to expand')),
          )
        }

        const box = new Box(1, 1, (text: string) =>
          theme.bg('customMessageBg', text),
        )
        box.addChild(new Text(contentLines.join('\n'), 0, 0))
        return ['', ...box.render(width)]
      },
    } as any
  })

  // /plan command — start the full planning workflow
  pi.registerCommand('plan', {
    description:
      'Start a planning session: /plan <JIRA-ID or feature description>',
    handler: async (args, ctx) => {
      const task = args.trim()
      if (!task) {
        ctx.ui.notify(
          'Usage: /plan <JIRA-ID or feature description>',
          'warning',
        )
        return
      }

      // AIDEV-NOTE: aven-first dispatch — everything routes to
      // feature-plan-aven; it handles aven refs, aven-synced Jira IDs, and
      // local features, in the aven workspace routed by cwd. Falls back to
      // the bundled plan-skill.md when the repo skill files cannot be read
      // (standalone npm install).
      const skillName = 'feature-plan-aven'
      const skill = readPlanSkill(skillName)
      if (skill) {
        const skillContent = skill.content.replace(/^---\n[\s\S]*?\n---\n*/, '')
        pi.sendUserMessage(
          `<skill name="${skillName}" location="${skill.path}">\n${skillContent.trim()}\n</skill>\n\n${task}`,
        )
        return
      }

      // Fallback: bundled generic plan skill
      const planSkillPath = join(SUBAGENTS_DIR, 'plan-skill.md')
      let content = readFileSync(planSkillPath, 'utf8')
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, '')
      pi.sendUserMessage(
        `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
      )
    },
  })
}

// AIDEV-NOTE: Public programmatic API for other extensions that want to spawn
// subagents directly. Consumers import launchSubagent/watchSubagent instead of
// sending a user message to the `subagent` tool.
export { isMuxAvailable, launchSubagent, muxSetupHint, watchSubagent }

// test
