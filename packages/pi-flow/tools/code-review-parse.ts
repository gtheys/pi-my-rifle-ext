// AIDEV-NOTE: PMR-T8ZG — the code_review tool's seams (PMR-3ZY1): aven
// worktree-note parser, herdr list matchers, exec-injected worktree resolver
// and tuicr opener, ask-answer parsing, tuicr session slug picking, pass/fail
// routing, and the /code-review gate prompt. All exec goes through the
// injected ReviewDeps — tools/code-review.ts owns registration + wiring.

import type { HerdrWorktree } from '../worktree/herdr.ts'
import { extractResult, pickString } from '../worktree/herdr.ts'

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
    const pathLine = /^worktree: (\S+)$/m.exec(body)
    if (pathLine === null) continue
    const branchLine = /^branch: (\S+)$/m.exec(body)
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

/** Loose fallback: any linked worktree whose branch contains the ref slug
 * (separators — `/`, `-`, `_` — normalized away on both sides). */
export function matchHerdrWorktreeBySlug(
  worktrees: HerdrWorktree[],
  slug: string,
): HerdrWorktree | null {
  const needle = slug.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (needle === '') return null
  return (
    worktrees.find((w) => {
      if (!w.isLinked) return false
      const hay = w.branch.toLowerCase().replace(/[^a-z0-9]/g, '')
      return hay.includes(needle)
    }) ?? null
  )
}

/** Parse the ask_user_question answer text into pass/fail (null = unclear). */
export function parseAskAnswer(answerText: string): 'pass' | 'fail' | null {
  const lowered = answerText.toLowerCase()
  if (lowered.includes('pass')) return 'pass'
  if (lowered.includes('fail')) return 'fail'
  return null
}

/**
 * Latest tuicr session slug from `tuicr review list` output. Last matching
 * line wins (tuicr lists oldest-first).
 */
export function pickLatestSessionSlug(listStdout: string): string | null {
  const re = /^session[:= ]+ ?([A-Za-z0-9._/-]+)/gm
  let slug: string | null = null
  let match = re.exec(listStdout)
  while (match !== null) {
    slug = match[1] ?? null
    match = re.exec(listStdout)
  }
  return slug
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
      `Next: call flow_phase_complete(phase="validate"), then flow_land (route=push-main), then git push.`,
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
  /** Absolute root of the session repo (ctx.cwd) — candidates must belong to it. */
  repoRoot: string
}

/**
 * Verify a candidate: path exists, `git -C <path> rev-parse --show-toplevel`
 * is the session repo, and (when the candidate carries a branch) HEAD
 * matches it. A stale note path fails verification and the resolver falls
 * through to the next source — never open tuicr on the wrong tree.
 */
async function verifyCandidate(
  candidate: { path: string; branch: string | null },
  deps: ReviewDeps,
): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
  if (!deps.exists(candidate.path)) {
    return { ok: false, reason: `path does not exist: ${candidate.path}` }
  }
  let topLevel = ''
  try {
    const result = await deps.exec(
      'git',
      ['-C', candidate.path, 'rev-parse', '--show-toplevel'],
      {},
    )
    topLevel = result.stdout.trim()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `git rev-parse failed: ${msg}` }
  }
  if (topLevel !== deps.repoRoot) {
    return {
      ok: false,
      reason: `${candidate.path} is a worktree of ${topLevel}, not ${deps.repoRoot}`,
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
  const slug = ref.toLowerCase().replace(/[^a-z0-9-]/g, '')
  const hit =
    matchHerdrWorktree(worktrees, ref) ??
    matchHerdrWorktreeBySlug(worktrees, slug)
  if (hit !== null) {
    const verified = await verifyCandidate(hit, deps)
    if (verified.ok) {
      return { path: hit.path, branch: hit.branch, source: 'herdr' }
    }
    failures.push(`herdr: ${verified.reason}`)
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
