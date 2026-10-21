// AIDEV-NOTE: publish half of /spec-publish (PMR-MR36 subtask PMR-2D2X).
// Three pure-ish parts: per-mode root resolution, the worker task text, and
// the launchSubagent wrapper. planPath comes from the caller (readPlanPath in
// index.ts) — publish.ts never queries aven itself. Both notes repos carry
// unrelated dirty state, so the worker must add the plan file ONLY.
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { launchSubagent, watchSubagent } from '@gtheys/pi-interactive-subagents'
import type { WorkMode } from '../work-mode.ts'

export interface PublishRootInput {
  repo: string
  mode: WorkMode
  planPath: string
  // Project git toplevel — only needed for the env-unset fallback.
  toplevel?: string
  env?: NodeJS.ProcessEnv
}

export type PublishRootResult =
  | { kind: 'ok'; root: string; planFile: string; isFallback: boolean }
  | { kind: 'error'; reason: string }

// AIDEV-NOTE: env-unset fallback publishes into the project repo itself —
// the plan file already lives there, so root = toplevel and the plan path is
// used as-is.
export function resolvePublishRoot(input: PublishRootInput): PublishRootResult {
  const env = input.env ?? process.env
  const notesRoot =
    input.mode === 'personal' ? env.PERSONAL_FEATURES : env.LLM_NOTES_ROOT
  if (notesRoot !== undefined && notesRoot !== '') {
    return {
      kind: 'ok',
      root: `${notesRoot.replace(/\/$/, '')}/${input.repo}`,
      planFile: input.planPath,
      isFallback: false,
    }
  }
  if (input.toplevel === undefined || input.toplevel === '') {
    return {
      kind: 'error',
      reason:
        input.mode === 'personal'
          ? 'PERSONAL_FEATURES is not set and no project toplevel available'
          : 'LLM_NOTES_ROOT is not set and no project toplevel available',
    }
  }
  return {
    kind: 'ok',
    root: input.toplevel,
    planFile: input.planPath,
    isFallback: true,
  }
}

export interface PublishWorkerTaskInput {
  ref: string
  repo: string
  root: string
  planFile: string
  isFallback: boolean
}

// AIDEV-NOTE: pure string builder — the task text is the worker's contract.
// Fetch+pull must be ff-only with NO conflict resolution; the retry cap (2)
// bounds a flaky network, not a broken repo state.
export function buildPublishWorkerTask(input: PublishWorkerTaskInput): string {
  const fallbackNote =
    input.isFallback === true
      ? 'This is a project-repo fallback publish (notes root env var was unset).'
      : 'This publishes into a shared notes repo.'
  return [
    `Publish the approved spec plan ${input.ref} to ${input.root}. ${fallbackNote}`,
    "Run these steps IN ORDER from that directory and report each step's outcome:",
    `1. cd ${input.root}`,
    '2. git fetch origin',
    '3. git pull --ff-only — on conflict STOP immediately and report. Never rebase, merge, or force-push.',
    `4. git add ${input.planFile} — add this ONE file only, never stage everything (no -A flag, no "git add .") — the repo has unrelated dirty state you must not touch.`,
    `5. git commit -m "docs(${input.repo}): publish ${input.ref} plan"`,
    '6. git push origin HEAD',
    'Rules: touch NOTHING except that single file. If a step fails, retry at most 2 times, then STOP and report the failure loudly with the exact error output — do not roll anything back, do not clean the repo, do not stash.',
    'Your final message: one line per step (ok/failed + detail), then "PUBLISH OK" if the push succeeded or "PUBLISH FAILED: <reason>" otherwise.',
  ].join('\n')
}

export interface SpawnPublishWorkerInput {
  task: string
  name: string
  cwd: string
  ref: string
  repo: string
  root: string
  planFile: string
}

// AIDEV-NOTE: wraps launchSubagent + watchSubagent. launchSubagent throws
// when mux is unavailable — the caller then notifies the manual fallback.
// Never resolves to a rejection: worker failure is a string result too, so
// the approval is never rolled back either way.
export async function spawnPublishWorker(
  ctx: ExtensionContext,
  input: SpawnPublishWorkerInput,
): Promise<string> {
  let running: Awaited<ReturnType<typeof launchSubagent>>
  try {
    running = await launchSubagent(
      { agent: 'worker', name: input.name, task: input.task, cwd: input.cwd },
      ctx,
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return [
      `/spec-publish: could not spawn publish worker (${msg}).`,
      'Publish manually:',
      `cd ${input.root}`,
      'git fetch origin',
      'git pull --ff-only',
      `git add ${input.planFile}`,
      `git commit -m "docs(${input.repo}): publish ${input.ref} plan"`,
      'git push origin HEAD',
    ].join('\n')
  }
  const result = await watchSubagent(running, new AbortController().signal)
  const base = `/spec-publish worker "${result.name}" exited with code ${result.exitCode}`
  if (result.exitCode === 0 && result.summary !== undefined) {
    return `${base}: ${result.summary}`
  }
  const detail =
    result.errorMessage ?? result.summary ?? 'no worker output captured'
  return `${base}: ${detail}`
}
