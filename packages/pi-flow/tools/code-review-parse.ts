// AIDEV-NOTE: PMR-T8ZG — the code_review tool's seams (PMR-3ZY1): aven
// worktree-note parser, herdr list matchers, exec-injected worktree resolver
// and tuicr opener, ask-answer parsing, tuicr session slug picking, pass/fail
// routing, and the /code-review gate prompt. All exec goes through the
// injected ReviewDeps — tools/code-review.ts owns registration + wiring.

import { resolve } from 'node:path'
import { type PersonalType, personalBranch } from '../worktree/branch.ts'
import type { HerdrWorktree } from '../worktree/herdr.ts'
import { extractResult, parseJson, pickString } from '../worktree/herdr.ts'

// AIDEV-NOTE: PMR-T8ZG — pure seams of the code_review tool (PMR-3ZY1):
// aven worktree-note parser, herdr list matchers, ask-answer parsing, tuicr
// session slug picking, pass/fail routing, and the /code-review gate prompt.
// No direct I/O here — exec goes through the injected ReviewDeps;
// tools/code-review.ts owns registration and production wiring.

export interface WorktreeNote {
  path: string
  branch: string | null
}

/**
 * Parse `aven show <ref> --full` output for note bodies carrying a
 * `worktree: <path>` line (same `note id=...` + `body<<EOF ... EOF` shape
 * parseMetadataBlock trusts). Chat text mentioning "worktree:" is ignored —
 * only heredoc bodies count.
 */
export function parseWorktreeNotes(stdout: string): WorktreeNote[] {
  const re = /^note id=\S+.*$\n^body<<EOF$\n([\s\S]*?)\n^EOF$/gm
  const notes: WorktreeNote[] = []
  let match = re.exec(stdout)
  while (match !== null) {
    const body = match[1] ?? ''
    match = re.exec(stdout)
    // AIDEV-NOTE: PMR-DE2P — accepts the skill's single-line form
    // `worktree: <path> branch: <b>` and the two-line form.
    const pathLine = /^worktree: (\S+)/m.exec(body)
    if (pathLine === null) continue
    const branchLine = /^(?:worktree: \S+ )?branch: (\S+)\s*$/m.exec(body)
    notes.push({
      path: pathLine[1] ?? '',
      branch: branchLine === null ? null : (branchLine[1] ?? null),
    })
  }
  return notes
}

/** Latest (last) worktree note, or null when none. */
export function latestWorktreeNote(stdout: string): WorktreeNote | null {
  const notes = parseWorktreeNotes(stdout)
  if (notes.length === 0) return null
  return notes[notes.length - 1] ?? null
}

/** Exact-branch match against a `herdr worktree list` payload. */
export function matchHerdrWorktree(
  worktrees: HerdrWorktree[],
  branch: string,
): HerdrWorktree | null {
  return worktrees.find((w) => w.isLinked && w.branch === branch) ?? null
}

// AIDEV-NOTE: PMR-3ZY1 — mirrors worktree/branch.ts's PersonalType union;
// keep in sync when branch.ts changes.
const PERSONAL_BRANCH_TYPES: readonly PersonalType[] = [
  'feat',
  'fix',
  'chore',
  'docs',
  'refactor',
]

/** Parse `title="..."` from the aven show --full metadata line. */
export function parseAvenTitle(stdout: string): string | null {
  const match = /^[^\n]*\btitle="([^"]*)"/.exec(stdout)
  const title = match === null ? null : (match[1] ?? null)
  if (title === null || title.trim() === '') return null
  return title
}

/** Expected personal branch for a ticket title: `feat(pi-flow): subject`
 * -> `feat/<slug of subject>` via worktree/branch.ts personalBranch.
 * A recognizable conventional-commit type prefix sets the branch type;
 * anything else falls back to 'feat'. */
export function titleBranch(title: string): string {
  let type: PersonalType = 'feat'
  let name = title
  const match = /^([a-z]+)(?:\([^)]*\))?:\s+(.+)$/.exec(title)
  if (
    match !== null &&
    PERSONAL_BRANCH_TYPES.includes((match[1] ?? '') as PersonalType)
  ) {
    type = match[1] as PersonalType
    name = match[2] ?? title
  }
  return personalBranch(name, type)
}

/** Parse the ask_user_question answer text into pass/fail (null = unclear). */
export function parseAskAnswer(answerText: string): 'pass' | 'fail' | null {
  const lowered = answerText.toLowerCase()
  if (lowered.includes('pass')) return 'pass'
  if (lowered.includes('fail')) return 'fail'
  return null
}

/**
 * Latest tuicr session slug from `tuicr review list` output.
 * AIDEV-NOTE: PMR-G68P — tuicr v0.27.0 prints a JSON array of
 * {slug, updated_at, ...} (verified against the installed binary), NOT
 * `session: <slug>` lines — the previous regex never matched real output,
 * so the fail path always fell to the free-text fallback. Array order is
 * not a freshness guarantee, so the slug with the max updated_at wins.
 */
export function pickLatestSessionSlug(listStdout: string): string | null {
  const parsed: unknown = parseJson(listStdout)
  if (!Array.isArray(parsed)) return null
  let bestSlug: string | null = null
  let bestUpdatedAt = ''
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const slug = record.slug
    if (typeof slug !== 'string' || slug === '') continue
    const updatedAt = record.updated_at
    let stamp = ''
    if (typeof updatedAt === 'string') stamp = updatedAt
    if (bestSlug === null || stamp > bestUpdatedAt) {
      bestSlug = slug
      bestUpdatedAt = stamp
    }
  }
  return bestSlug
}

export interface ReviewRouting {
  marker: string
  avenNote: string
  message: string
}

/** Pure pass routing: the marker, the dated aven note, the landing instructions. */
export function routeReviewPass(ref: string, date: string): ReviewRouting {
  return {
    marker: ref,
    avenNote: `human code review passed, ${date}`,
    message:
      `code_review: human PASS recorded for ${ref} (aven note: "${`human code review passed, ${date}`}").\n` +
      `Next: call flow_phase_complete(phase="validate"), then flow_land (route=merge-main), then a LOCAL ff-only merge into main — never a push.`,
  }
}

export interface FailRouting {
  avenNote: string
  message: string
  freeTextFallback: boolean
}

/** Pure fail routing: findings become the aven note, route back to /implement. */
export function routeReviewFail(ref: string, comments: string): FailRouting {
  if (comments.trim().length === 0) {
    return {
      avenNote: '',
      message: `code_review: human FAIL for ${ref}, but the tuicr session has no comments — ask the human to describe the findings (ask_user_question free text), then write them as an aven note on ${ref} and route back to /implement ${ref}.`,
      freeTextFallback: true,
    }
  }
  return {
    avenNote: comments.trim(),
    message: `code_review: human FAIL for ${ref} — findings recorded as an aven note. Route back to /implement ${ref} (retry budget applies). STOP.`,
    freeTextFallback: false,
  }
}

/** The /code-review gate prompt: instructs the agent to call the tool. */
export function buildCodeReviewGatePrompt(ref: string): string {
  return (
    `Run the human code-review gate for ${ref}:\n\n` +
    `1. Call the code_review tool with ref="${ref}". It resolves the ref's worktree, opens tuicr for the human, and asks them pass/fail.\n` +
    `2. On PASS: follow the tool's instructions (flow_phase_complete validate, then flow_land, then push).\n` +
    `3. On FAIL: follow the tool's routing back to /implement ${ref}. Never push without the gate.\n` +
    `If the tool reports the ask extension is unavailable, ask the human yourself via ask_user_question, then re-call code_review with outcome="pass" (or handle the fail as the tool instructs).`
  )
}

export interface ResolvedWorktree {
  path: string
  branch: string
  source: 'binding' | 'note' | 'herdr'
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * I/O seams of the code_review tool. Production wiring is in
 * registerCodeReviewTool; tests inject fakes and assert exec sequences.
 */
export interface ReviewDeps {
  getFlowWorktree: () => { ref: string; path: string; branch: string } | null
  avenShowFull: (ref: string) => Promise<string>
  herdrWorktreeList: () => Promise<HerdrWorktree[]>
  exec: (
    cmd: string,
    args: string[],
    opts?: { cwd?: string },
  ) => Promise<ExecResult>
  exists: (path: string) => boolean
  /** Absolute root of the session repo (ctx.cwd) — candidates must share its common git dir. */
  repoRoot: string
}

// AIDEV-NOTE: PMR-9XR0 — linked worktrees have different top-level paths;
// repository identity is the common git dir shared with the session repo.
/**
 * Verify a candidate: path exists, its common git dir matches the session
 * repo, and (when the candidate carries a branch) HEAD matches it. A stale
 * note path fails verification and the resolver falls through to the next
 * source — never open tuicr on the wrong tree.
 */
async function verifyCandidate(
  candidate: { path: string; branch: string | null },
  deps: ReviewDeps,
): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
  if (!deps.exists(candidate.path)) {
    return { ok: false, reason: `path does not exist: ${candidate.path}` }
  }
  let candidateCommonDir = ''
  let repoCommonDir = ''
  try {
    const candidateResult = await deps.exec(
      'git',
      ['-C', candidate.path, 'rev-parse', '--git-common-dir'],
      {},
    )
    const repoResult = await deps.exec(
      'git',
      ['-C', deps.repoRoot, 'rev-parse', '--git-common-dir'],
      {},
    )
    // AIDEV-NOTE: PMR-HXPQ — pi.exec returns non-zero codes without throwing;
    // empty stdout would otherwise resolve to the base path and falsely match.
    for (const [label, result] of [
      ['candidate', candidateResult],
      ['session', repoResult],
    ] as const) {
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim()
        return {
          ok: false,
          reason: `git rev-parse --git-common-dir failed for ${label} (exit ${result.code}): ${detail}`,
        }
      }
    }
    candidateCommonDir = resolve(candidate.path, candidateResult.stdout.trim())
    repoCommonDir = resolve(deps.repoRoot, repoResult.stdout.trim())
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `git rev-parse failed: ${msg}` }
  }
  if (candidateCommonDir !== repoCommonDir) {
    return {
      ok: false,
      reason: `${candidate.path} belongs to a different repository (common git dir ${candidateCommonDir}, expected ${repoCommonDir})`,
    }
  }
  if (candidate.branch === null) {
    return { ok: true, branch: '' }
  }
  const head = await deps.exec(
    'git',
    ['-C', candidate.path, 'rev-parse', '--abbrev-ref', 'HEAD'],
    {},
  )
  const actual = head.stdout.trim()
  if (actual !== candidate.branch) {
    return {
      ok: false,
      reason: `branch mismatch: expected ${candidate.branch}, HEAD is ${actual}`,
    }
  }
  return { ok: true, branch: candidate.branch }
}

/**
 * Resolve the ref's review worktree, source by source, verifying each hit.
 * Throws (loud) when no source yields a verified worktree.
 */
export async function resolveReviewWorktree(
  ref: string,
  deps: ReviewDeps,
): Promise<ResolvedWorktree> {
  const failures: string[] = []

  const binding = deps.getFlowWorktree()
  if (binding !== null && binding.ref === ref) {
    const verified = await verifyCandidate(binding, deps)
    if (verified.ok) {
      return { path: binding.path, branch: verified.branch, source: 'binding' }
    }
    failures.push(`binding: ${verified.reason}`)
  }

  let noteStdout = ''
  try {
    noteStdout = await deps.avenShowFull(ref)
  } catch (error) {
    failures.push(
      `note: aven show failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const note = latestWorktreeNote(noteStdout)
  if (note !== null) {
    const verified = await verifyCandidate(note, deps)
    if (verified.ok) {
      return {
        path: note.path,
        branch: verified.branch || note.branch || '',
        source: 'note',
      }
    }
    failures.push(`note: ${verified.reason}`)
  }

  let worktrees: HerdrWorktree[] = []
  try {
    worktrees = await deps.herdrWorktreeList()
  } catch (error) {
    failures.push(
      `herdr list failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const title = parseAvenTitle(noteStdout)
  let expected: string | null = null
  if (title === null) {
    failures.push('herdr: no title parsed from aven show output')
  } else {
    expected = titleBranch(title)
  }
  let hit: HerdrWorktree | null = matchHerdrWorktree(worktrees, ref)
  if (hit === null && expected !== null) {
    hit = matchHerdrWorktree(worktrees, expected)
  }
  if (hit !== null) {
    const verified = await verifyCandidate(hit, deps)
    if (verified.ok) {
      return { path: hit.path, branch: hit.branch, source: 'herdr' }
    }
    failures.push(`herdr: ${verified.reason}`)
  } else if (expected !== null) {
    failures.push(
      `herdr: no linked worktree matched ${ref} or expected branch ${expected}`,
    )
  }

  throw new Error(
    `code_review: no worktree found for ${ref} (checked flow binding, aven note, herdr worktree list)` +
      (failures.length > 0 ? `\n${failures.join('\n')}` : ''),
  )
}

export type OpenTuicrResult =
  | { ok: true; paneId: string; command: string }
  | { ok: false; reason: string; command: string }

/**
 * Open tuicr for the human: merge-base for the branch scope, a focused
 * herdr tab at the worktree (parse result.root_pane.pane_id), then
 * `herdr pane run <pane> tuicr tui -r <base>..HEAD` (text + Enter in one
 * call — plain send-text does NOT submit). Fail-closed: any failure returns
 * the manual command so the human can open it and the agent re-calls.
 */
export async function openTuicrReview(
  ref: string,
  worktreePath: string,
  deps: Pick<ReviewDeps, 'exec'>,
): Promise<OpenTuicrResult> {
  const baseResult = await deps.exec(
    'git',
    ['-C', worktreePath, 'merge-base', 'main', 'HEAD'],
    {},
  )
  if (baseResult.code !== 0) {
    const detail = baseResult.stderr || baseResult.stdout
    return {
      ok: false,
      reason: `git merge-base main HEAD failed in ${worktreePath}: ${detail}`,
      command: `cd ${worktreePath} && tuicr tui`,
    }
  }
  const base = baseResult.stdout.trim()
  const range = `${base}..HEAD`
  const manual = `cd ${worktreePath} && tuicr tui -r ${range}`

  const tabResult = await deps.exec(
    'herdr',
    [
      'tab',
      'create',
      '--cwd',
      worktreePath,
      '--label',
      `review ${ref}`,
      '--focus',
    ],
    {},
  )
  if (tabResult.code !== 0) {
    return {
      ok: false,
      reason: `herdr tab create failed: ${tabResult.stderr || tabResult.stdout}`,
      command: manual,
    }
  }
  const root: unknown = extractResult(JSON.parse(tabResult.stdout) as unknown)
  const paneId = pickString(root, ['root_pane.pane_id', 'pane_id'])
  if (paneId === '') {
    return {
      ok: false,
      reason: `herdr tab create returned no root_pane.pane_id: ${tabResult.stdout.slice(0, 200)}`,
      command: manual,
    }
  }

  const runResult = await deps.exec(
    'herdr',
    ['pane', 'run', paneId, 'tuicr', 'tui', '-r', range],
    {},
  )
  if (runResult.code !== 0) {
    return {
      ok: false,
      reason: `herdr pane run tuicr failed: ${runResult.stderr || runResult.stdout}`,
      command: manual,
    }
  }
  return { ok: true, paneId, command: manual }
}
