/**
 * Integration test harness for pi-interactive-subagents — herdr-only
 * (PMR-TABUX). The cmux/tmux/zellij/wezterm backend matrix is gone.
 *
 * Provides utilities to:
 * - Create isolated test environments with test agent definitions
 * - Create herdr background tabs for test sessions
 * - Poll for pane output
 * - Clean up tabs and temp files after tests
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runHerdr } from '../../pi-extension/subagents/herdr.ts'
import {
  herdrPaneAlive,
  herdrTabClose,
  herdrTabCreate,
} from '../../pi-extension/subagents/spawn.ts'
import {
  closeSurface,
  readScreen,
  readScreenAsync,
  sendCommand,
  sendEscape,
  sendLongCommand,
  shellEscape,
} from '../../pi-extension/subagents/surface.ts'

// Re-export surface primitives for tests
export {
  closeSurface,
  readScreen,
  readScreenAsync,
  sendCommand,
  sendEscape,
  sendLongCommand,
  shellEscape,
}

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const TEST_AGENTS_SRC = join(HARNESS_DIR, 'agents')

// ── Configuration ──

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? '120000')

// ── Herdr environment ──

/** Skip guard: tests need to run inside herdr. */
export function isHerdrIntegrationAvailable(): boolean {
  return !!process.env.HERDR_PANE_ID
}

function herdrWorkspaceId(): string {
  return (
    process.env.HERDR_WORKSPACE_ID ??
    process.env.HERDR_PANE_ID?.split(':')[0] ??
    ''
  )
}

interface HerdrPaneInfo {
  pane_id?: string
  focused?: boolean
  workspace_id?: string
}

function herdrPaneList(): HerdrPaneInfo[] {
  const info = execFileSync('herdr', ['pane', 'list'], { encoding: 'utf8' })
  const parsed = JSON.parse(info) as { result?: { panes?: HerdrPaneInfo[] } }
  return parsed.result?.panes ?? []
}

export function herdrFocusedPane(): string | null {
  const workspace = process.env.HERDR_PANE_ID?.split(':')[0]
  const focused = herdrPaneList().find(
    (p) => p.focused && (!workspace || p.workspace_id === workspace),
  )
  return focused?.pane_id ?? null
}

// AIDEV-NOTE: focus is server-global — focus the target's workspace+tab first
// (read from `pane get`), then nudge with directional pane focus if needed.
function herdrFocusSurface(target: string): void {
  try {
    const info = execFileSync('herdr', ['pane', 'get', target], {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(info) as {
      result?: { pane?: { workspace_id?: string; tab_id?: string } }
    }
    const pane = parsed.result?.pane
    if (pane?.workspace_id) {
      execFileSync('herdr', ['workspace', 'focus', pane.workspace_id])
    }
    if (pane?.tab_id) {
      execFileSync('herdr', ['tab', 'focus', pane.tab_id])
    }
  } catch {}
  for (let attempt = 0; attempt < 10; attempt++) {
    if (herdrFocusedPane() === target) return
    const focused = herdrFocusedPane()
    if (!focused) break
    const rects = herdrPaneRects(target)
    const from = rects.get(focused)
    const to = rects.get(target)
    if (!from || !to) {
      // A fresh pane can lag the layout snapshot by a tick — retry.
      if (attempt < 9) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
        continue
      }
      throw new Error(`Cannot locate herdr pane ${target} in layout`)
    }
    const direction = herdrFocusDirection(from, to)
    execFileSync(
      'herdr',
      ['pane', 'focus', '--direction', direction, '--current'],
      { encoding: 'utf8' },
    )
  }
  throw new Error(`Failed to focus herdr pane ${target}`)
}

interface HerdrRect {
  x: number
  y: number
  width: number
  height: number
}

// AIDEV-NOTE: layout must be queried for the TARGET pane's tab
// (`--pane <id>`) — `--current` follows the server's global focus, which
// may be a human's workspace, not the test's.
function herdrPaneRects(target: string): Map<string, HerdrRect> {
  const info = execFileSync('herdr', ['pane', 'layout', '--pane', target], {
    encoding: 'utf8',
  })
  const parsed = JSON.parse(info) as {
    result?: {
      layout?: {
        panes?: Array<{ pane_id?: string; rect?: HerdrRect; focused?: boolean }>
      }
    }
  }
  const rects = new Map<string, HerdrRect>()
  for (const pane of parsed.result?.layout?.panes ?? []) {
    if (pane.pane_id && pane.rect) rects.set(pane.pane_id, pane.rect)
  }
  return rects
}

function herdrFocusDirection(from: HerdrRect, to: HerdrRect): string {
  const fromCenterX = from.x + from.width / 2
  const fromCenterY = from.y + from.height / 2
  const toCenterX = to.x + to.width / 2
  const toCenterY = to.y + to.height / 2
  const dx = toCenterX - fromCenterX
  const dy = toCenterY - fromCenterY
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) return 'right'
    return 'left'
  }
  if (dy >= 0) return 'down'
  return 'up'
}

export function focusSurface(paneId: string): void {
  herdrFocusSurface(paneId)
}

export function getFocusedSurface(): string | null {
  return herdrFocusedPane()
}

export async function waitForFocusedSurface(
  paneId: string,
  timeout: number = PI_TIMEOUT,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (getFocusedSurface() === paneId) return
    await sleep(200)
  }

  throw new Error(
    `Timeout (${timeout}ms) waiting for focused herdr pane ${paneId}; ` +
      `current focus is ${getFocusedSurface() ?? 'unknown'}`,
  )
}

export function isPaneAlive(paneId: string): boolean {
  return herdrPaneAlive(paneId)
}

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string
  /** Herdr panes created during the test (panes closed on cleanup) */
  surfaces: string[]
  /** Herdr tabs created during the test (closed on cleanup) */
  tabs: string[]
  /** Temp files to clean up */
  tempFiles: string[]
}

/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'pi-integ-'))
  const agentsDir = join(dir, '.pi', 'agents')
  mkdirSync(agentsDir, { recursive: true })

  // Copy test agent definitions into the project-local agents dir
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith('.md')) {
        cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file))
      }
    }
  }

  return { dir, surfaces: [], tabs: [], tempFiles: [] }
}

/**
 * Clean up all resources created during the test.
 */
export function cleanupTestEnv(env: TestEnv): void {
  for (const pane of env.surfaces) {
    try {
      closeSurface(pane)
    } catch {}
  }
  // Close any still-existing tabs the test created (asymmetric rollback
  // discipline: only our own tabs).
  for (const tab of env.tabs) {
    try {
      herdrTabClose(tab)
    } catch {}
  }
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file)
    } catch {}
  }
  try {
    rmSync(env.dir, { recursive: true, force: true })
  } catch {}
}

/**
 * Create a background herdr tab; returns its root pane id and registers
 * pane + tab for automatic cleanup.
 */
export function createTrackedSurface(env: TestEnv, name: string): string {
  const tab = herdrTabCreate({
    workspaceId: herdrWorkspaceId(),
    cwd: env.dir,
    label: name,
  })
  env.surfaces.push(tab.paneId)
  env.tabs.push(tab.tabId)
  return tab.paneId
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface)
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the pane's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  paneId: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(paneId, lines)
      if (pattern.test(screen)) return screen
    } catch {}
    await sleep(2000)
  }

  let finalScreen = ''
  try {
    finalScreen = readScreen(paneId, lines)
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  )
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8')
      if (!contentPattern || contentPattern.test(content)) return content
    }
    await sleep(2000)
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ''),
  )
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path)
}

export { runHerdr }
