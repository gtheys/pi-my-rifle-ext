/**
 * Lockfile-based dependency bootstrap + missing-only `.env*` copy.
 */

import { copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export interface BootstrapStep {
  label: string
  command: string
  shell: boolean
}

export interface BootstrapPlan {
  steps: BootstrapStep[]
  note?: string
}

const GO_NOTE = 'go: global module cache, nothing to install'
const NONE_NOTE = 'no recognized lockfile — nothing to bootstrap'

// AIDEV-NOTE: all JS installs run as a single bash -c string so GH_TOKEN
// is expanded inside the shell and never appears in process argv (ISC-5).
// gh-auth fallback (plain command) happens in runStep.
const GH_PREFIX = 'GH_TOKEN="$(gh auth token)" '

const JS_LOCKFILES = [
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
] as const

/**
 * Pick the bootstrap plan from basenames found at the worktree root.
 * First matching JS lockfile wins; ambiguity is noted, not an error.
 */
export function detectBootstrapPlan(filesPresent: string[]): BootstrapPlan {
  const present = new Set(filesPresent)
  const notes: string[] = []

  const matched = JS_LOCKFILES.filter((name) => present.has(name))
  const steps: BootstrapStep[] = []
  if (matched.length > 1) {
    notes.push(
      `multiple JS lockfiles found (${matched.join(', ')}); using ${matched[0]}`,
    )
  }

  if (present.has('bun.lock') || present.has('bun.lockb')) {
    steps.push({
      label: 'bun install',
      command: `${GH_PREFIX}bun install`,
      shell: true,
    })
  } else if (present.has('yarn.lock')) {
    steps.push({
      label: 'yarn install',
      command: `${GH_PREFIX}yarn install`,
      shell: true,
    })
  } else if (present.has('package-lock.json')) {
    steps.push({
      label: 'npm ci',
      command: `${GH_PREFIX}npm ci`,
      shell: true,
    })
  } else if (present.has('pnpm-lock.yaml')) {
    steps.push({
      label: 'pnpm install',
      command: `${GH_PREFIX}pnpm install --frozen-lockfile`,
      shell: true,
    })
  }

  if (present.has('Cargo.toml')) {
    steps.push({ label: 'cargo fetch', command: 'cargo fetch', shell: false })
  }
  if (present.has('go.mod')) {
    notes.push(GO_NOTE)
  }
  if (steps.length === 0 && notes.length === 0) {
    notes.push(NONE_NOTE)
  }

  const plan: BootstrapPlan = { steps }
  if (notes.length > 0) {
    plan.note = notes.join('; ')
  }
  return plan
}

/**
 * AIDEV-NOTE: missing-only contract — a `.env*` file already present in
 * the worktree is NEVER copied over (ISC-6; snapshots by design).
 * `.env` prefix match is exact: startsWith('.env'), so `.environment`
 * is ignored.
 */
export function selectEnvFiles(
  sourceDirListing: string[],
  targetDirListing: string[],
): string[] {
  const target = new Set(targetDirListing)
  const isEnvFile = (name: string): boolean =>
    name === '.env' || name.startsWith('.env.')
  return sourceDirListing.filter((name) => isEnvFile(name) && !target.has(name))
}

function tail(text: string): string {
  return text.slice(-300)
}

export interface BootstrapStepResult {
  label: string
  ok: boolean
  output: string
}

async function runStep(
  pi: ExtensionAPI,
  step: BootstrapStep,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<BootstrapStepResult> {
  let command = step.command
  let args: string[]
  if (step.shell) {
    // Verify gh auth first; fall back to plain command if gh missing.
    const gh = await pi.exec('gh', ['auth', 'token'], { cwd })
    if (gh.code !== 0) {
      command = command.replace(GH_PREFIX, '')
      const result = await pi.exec('bash', ['-c', command], {
        cwd,
        signal,
        timeout: 10 * 60 * 1000,
      })
      return {
        label: step.label,
        ok: result.code === 0,
        output: `warning: gh auth token failed, running plain ${command}\n${tail(result.stdout + result.stderr)}`,
      }
    }
    args = ['-c', command]
  } else {
    const parts = command.split(' ')
    args = parts.slice(1)
    command = parts[0]
  }
  const result = await pi.exec(command, args, {
    cwd,
    signal,
    timeout: 10 * 60 * 1000,
  })
  return {
    label: step.label,
    ok: result.code === 0,
    output: tail(result.stdout + result.stderr),
  }
}

/**
 * Never throws (ISC-11): failures are recorded per-step; the worktree
 * stays usable. Remaining steps are marked skipped once aborted.
 */
export async function runBootstrap(
  pi: ExtensionAPI,
  worktreePath: string,
  signal: AbortSignal | undefined,
  onUpdate?: (text: string) => void,
): Promise<BootstrapStepResult[]> {
  try {
    const files = await readdir(worktreePath)
    const plan = detectBootstrapPlan(files)
    const results: BootstrapStepResult[] = []
    for (const step of plan.steps) {
      if (signal?.aborted) {
        results.push({
          label: step.label,
          ok: false,
          output: 'skipped: aborted',
        })
        continue
      }
      if (onUpdate) {
        onUpdate(`bootstrap: ${step.label}`)
      }
      try {
        results.push(await runStep(pi, step, worktreePath, signal))
      } catch (error) {
        results.push({
          label: step.label,
          ok: false,
          output: tail(String(error)),
        })
      }
    }
    return results
  } catch (error) {
    return [
      {
        label: 'bootstrap',
        ok: false,
        output: tail(String(error)),
      },
    ]
  }
}

/** Copy missing-only `.env*` from the main checkout; never throws. */
export async function copyEnvFiles(
  pi: ExtensionAPI,
  mainCheckout: string,
  worktreePath: string,
): Promise<string[]> {
  // AIDEV-NOTE: pi unused here but kept for signature symmetry with
  // runBootstrap (future per-file exec hooks); fs/promises suffices.
  void pi
  try {
    const [sourceEntries, targetEntries] = await Promise.all([
      readdir(mainCheckout),
      readdir(worktreePath),
    ])
    const toCopy = selectEnvFiles(sourceEntries, targetEntries)
    const copied: string[] = []
    for (const name of toCopy) {
      try {
        await copyFile(join(mainCheckout, name), join(worktreePath, name))
        copied.push(name)
      } catch {
        // per-file skip — never abort the whole copy
      }
    }
    return copied
  } catch {
    return []
  }
}
