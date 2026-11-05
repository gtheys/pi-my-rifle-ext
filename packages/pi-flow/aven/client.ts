// AIDEV-NOTE: PMR-T22H — single aven boundary for pi-flow. Every shell-out
// to the aven CLI lives behind this module: the AvenRunner contract (the one
// definition — flow/jira-ref.ts and flow/aven-resolve-exec.ts re-export it),
// the avenExec runner, workspace resolution (per-ref memoized and
// config-override), and the label/note/plan-state/epic helpers. Consumers
// that take an AvenRunner param keep doing so (tests inject fakes); index.ts
// wires avenExec.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig } from '../config.ts'
import { resolveAvenRef } from '../flow/aven-resolve-exec.ts'
import { classifyLabelFailure } from '../flow/ensure-labels.ts'
import { ALL_LABELS } from '../phase-state.ts'
import { approveSpec } from '../spec-review/approve.ts'
import { avenErrorText, parseMetadataBlock } from '../spec-review/aven-spec.ts'

const execFileAsync = promisify(execFile)
const AVEN_TIMEOUT_MS = 5_000

export type AvenRunner = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>

// AIDEV-NOTE: PMR-5900 — aven ref resolution must not depend on implicit
// cwd inference. The first ref-scoped aven call per ref resolves the
// workspace (see flow/aven-resolve-exec.ts) and memoizes it; later calls
// for the same ref reuse it. `avenWorkspace` config overrides everything.
// PMR-28BR — lifetime: the memo lives for the whole process and is never
// invalidated. A ticket moved between workspaces mid-session keeps the stale
// --workspace flag (fail-closed: confusing aven errors, not corruption);
// restart the session after moving a ticket.
const resolvedRefWorkspaces = new Map<string, string | undefined>()
// AIDEV-NOTE: PMR-8JZA — session cwd for every aven call. Set once from
// session_start (ctx.cwd); command handlers and the flow loop all share it,
// so the project-level avenWorkspace resolves from the session cwd even when
// process.cwd() differs (worktree sessions, --cwd launches). Memoized per
// resolved cwd, so two sessions in one process with different cwds each
// load their own project config.
let avenSessionCwd: string | undefined
const avenWorkspaceOverrideByCwd = new Map<string, string | undefined>()
let lastAvenFailure: string | undefined

export function lastAvenResolutionFailure(): string | undefined {
  return lastAvenFailure
}

function recordAvenFailure(error: unknown): void {
  lastAvenFailure = error instanceof Error ? error.message : String(error)
}

// AIDEV-NOTE: cwd resolution: avenSessionCwd (set by session_start) wins;
// process.cwd() is only the fallback for direct library use before any
// session starts. Previously this memoized once on the first caller's cwd
// (ensureLabels at session_start), silently pinning process.cwd() for the
// whole process (PMR-8JZA).
export async function avenOverrideArg(): Promise<string[]> {
  const cwd = avenSessionCwd ?? process.cwd()
  if (!avenWorkspaceOverrideByCwd.has(cwd)) {
    const config = await loadConfig(cwd)
    avenWorkspaceOverrideByCwd.set(cwd, config.avenWorkspace)
  }
  const avenWorkspaceOverride = avenWorkspaceOverrideByCwd.get(cwd)
  if (avenWorkspaceOverride !== undefined) {
    return ['--workspace', avenWorkspaceOverride]
  }
  return []
}

async function avenArgsWithWorkspace(
  args: string[],
  ref: string,
): Promise<string[]> {
  const override = await avenOverrideArg()
  if (override.length > 0) return [...args, ...override]
  if (!resolvedRefWorkspaces.has(ref)) {
    const resolved = await resolveAvenRef(ref, avenExec)
    if (!resolved.ok) throw new Error(resolved.reason)
    resolvedRefWorkspaces.set(ref, resolved.workspace)
  }
  const workspace = resolvedRefWorkspaces.get(ref)
  if (workspace !== undefined) {
    return [...args, '--workspace', workspace]
  }
  return args
}

// AIDEV-NOTE: workspace resolution for the spec commands (/spec-review,
// /spec-publish) and the spec_approve tool (PMR-MR36 fix round). Priority:
// explicit --workspace flag > project-config avenWorkspace override (the
// SAME avenOverrideArg path the flow loop uses — no second config mechanism)
// > per-ref resolution via resolveAvenRef, memoized in
// resolvedRefWorkspaces like avenArgsWithWorkspace. Throws on failed
// per-ref resolution — callers show the reason and stop; never fall back to
// the cwd-inferred workspace silently (that was the original bug).
export async function resolveSpecWorkspace(
  explicit: string | undefined,
  ref: string,
): Promise<string | undefined> {
  if (explicit !== undefined) return explicit
  const override = await avenOverrideArg()
  if (override.length > 0) return override[1]
  if (!resolvedRefWorkspaces.has(ref)) {
    const resolved = await resolveAvenRef(ref, avenExec)
    if (!resolved.ok) throw new Error(resolved.reason)
    resolvedRefWorkspaces.set(ref, resolved.workspace)
  }
  return resolvedRefWorkspaces.get(ref)
}

// AIDEV-NOTE: aven runner for the Jira-ID resolver (flow/jira-ref.ts) and
// the spec modules — execFileAsync throws on spawn failure / non-zero exit;
// aven's own errors (exit 0, text on stdout) are classified inside the
// resolvers.
export const avenExec: AvenRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync('aven', [...args], {
    timeout: AVEN_TIMEOUT_MS,
  })
  return { stdout, stderr }
}

// AIDEV-NOTE: spec_approve tool body (PMR-MR36 fix round). approveSpec was
// dead code and the injected review prompt made the model run a raw
// `aven edit` — no loud failure, no workspace pin. The spec_approve tool in
// tools/spec-approve.ts is a thin wrapper mapping this result to tool output.
export async function specApprove(params: {
  ref: string
  workspace?: string
}): Promise<{ ok: boolean; text: string }> {
  let workspace: string | undefined
  try {
    workspace = await resolveSpecWorkspace(params.workspace, params.ref)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, text: `spec_approve: ${msg}` }
  }
  const result = await approveSpec(avenExec, params.ref, { workspace })
  if (result.kind === 'error') {
    return { ok: false, text: `spec_approve: ${result.reason}` }
  }
  return {
    ok: true,
    text: `spec_approve: ${params.ref} approved (plan-state=approved, label=plan, status=todo) — now call the spec_publish tool for ${params.ref}`,
  }
}

// AIDEV-NOTE: Shared aven helpers (labels are the run state, notes are the
// halt record). Used by the /implement and /flow command handlers and by the
// flow loop deps — one parsing path, fail-closed (null/[] on any failure).
export async function readAvenLabels(ref: string): Promise<string[] | null> {
  try {
    const args = await avenArgsWithWorkspace(['show', ref, '--json'], ref)
    const { stdout } = await execFileAsync('aven', args, {
      timeout: AVEN_TIMEOUT_MS,
    })
    const parsedTicket: unknown = JSON.parse(stdout)
    if (
      typeof parsedTicket === 'object' &&
      parsedTicket !== null &&
      Array.isArray((parsedTicket as { labels?: unknown }).labels)
    ) {
      return (parsedTicket as { labels: unknown[] }).labels.filter(
        (l): l is string => typeof l === 'string',
      )
    }
    return null
  } catch (error: unknown) {
    recordAvenFailure(error)
    return null
  }
}

export async function writeAvenNote(
  ref: string,
  text: string,
): Promise<boolean> {
  try {
    const args = await avenArgsWithWorkspace(['note', ref, text], ref)
    await execFileAsync('aven', args, {
      timeout: AVEN_TIMEOUT_MS,
    })
    return true
  } catch (error: unknown) {
    recordAvenFailure(error)
    return false
  }
}

// AIDEV-NOTE: Structural input for the implement routing guard — an open
// epic tree is plan-route work regardless of type labels. Fail-open on aven
// errors (label-based routing stays the primary contract).
export async function epicHasOpenChildren(ref: string): Promise<boolean> {
  try {
    const args = await avenArgsWithWorkspace(
      ['epic', 'list', ref, '--json'],
      ref,
    )
    const { stdout } = await execFileAsync('aven', args, {
      timeout: AVEN_TIMEOUT_MS,
    })
    const parsed: unknown = JSON.parse(stdout)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { children?: unknown }).children)
    )
      return (parsed as { children: { open?: unknown }[] }).children.some(
        (c) => c.open === true,
      )
    return false
  } catch (error: unknown) {
    recordAvenFailure(error)
    return false
  }
}

// AIDEV-NOTE: PMR-W60H — plan-state reader for the flow loop's
// awaiting-approval gate. Reads the same `aven show <ref> --full` metadata
// blocks /spec-review uses, with the same workspace threading as
// readAvenLabels. null = aven failed OR the field is absent — the loop
// treats both as "no gate" (the failure-halt path is unchanged); only an
// explicit plan-state=review triggers the graceful pause.
export async function readPlanState(ref: string): Promise<string | null> {
  try {
    const args = await avenArgsWithWorkspace(['show', ref, '--full'], ref)
    const { stdout, stderr } = await execFileAsync('aven', args, {
      timeout: AVEN_TIMEOUT_MS,
    })
    if (avenErrorText(stdout, stderr) !== null) return null
    return parseMetadataBlock(stdout, 'plan-state')
  } catch {
    return null
  }
}

export async function writeAvenLabel(
  ref: string,
  label: string,
): Promise<boolean> {
  try {
    const args = await avenArgsWithWorkspace(
      ['edit', ref, '--label', label],
      ref,
    )
    await execFileAsync('aven', args, {
      timeout: AVEN_TIMEOUT_MS,
    })
    return true
  } catch (error: unknown) {
    recordAvenFailure(error)
    return false
  }
}

export function setAvenSessionCwd(cwd: string | undefined): void {
  avenSessionCwd = cwd
}

// AIDEV-NOTE: Best-effort label bootstrap — label creation must never break
// startup (PMR-SE93). Failures are classified (flow/ensure-labels.ts):
// aven-missing → one visible warning; already-exists → silent; anything else
// → surfaced warning with stderr. The override targets the same workspace the
// ref-resolution path uses when `avenWorkspace` is configured; without it,
// cwd inference is the only option here (no ref is known at session_start).
export async function ensureLabels(
  notify?: (message: string, level: 'info' | 'warning' | 'error') => void,
): Promise<void> {
  let override: string[]
  try {
    override = await avenOverrideArg()
  } catch {
    override = []
  }
  let avenMissing = false
  const otherFailures: string[] = []
  for (const label of ALL_LABELS) {
    try {
      await execFileAsync('aven', ['label', 'create', label, ...override], {
        timeout: AVEN_TIMEOUT_MS,
      })
    } catch (error: unknown) {
      const failure = classifyLabelFailure(error)
      if (failure.kind === 'aven-missing') {
        avenMissing = true
      } else if (failure.detail !== undefined) {
        otherFailures.push(`aven label create ${label}: ${failure.detail}`)
      }
    }
  }
  if (avenMissing) {
    notify?.(
      'phase labels unavailable; gates will fail-closed until aven is on PATH',
      'warning',
    )
  }
  for (const failure of otherFailures) {
    notify?.(failure, 'warning')
  }
}
