import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { registerCodeReviewTool } from '../tools/code-review.ts'
import {
  buildCodeReviewGatePrompt,
  latestWorktreeNote,
  matchHerdrWorktree,
  openTuicrReview,
  parseAskAnswer,
  parseAvenTitle,
  parseWorktreeNotes,
  pickLatestSessionSlug,
  type ReviewDeps,
  resolveReviewWorktree,
  routeReviewFail,
  routeReviewPass,
  titleBranch,
} from '../tools/code-review-parse.ts'
import type { HerdrWorktree } from '../worktree/herdr.ts'

// --- aven note parser (worktree notes) ---

const NOTE_FIXTURE = `notes for PMR-ABC1

note id=n1 author=pi at=2026-01-01
body<<EOF
worktree: /repo/.worktrees/feat-a
branch: feat/alpha
EOF

note id=n2 author=pi at=2026-01-02
body<<EOF
unrelated chatter mentioning worktree: nowhere
EOF

note id=n3 author=pi at=2026-01-03
body<<EOF
worktree: /repo/.worktrees/feat-b
EOF

note id=n4 author=pi at=2026-01-04
body<<EOF
implement done, on to validate
EOF
`

test('parseWorktreeNotes: only heredoc note bodies count', () => {
  const notes = parseWorktreeNotes(NOTE_FIXTURE)
  assert.deepEqual(notes, [
    { path: '/repo/.worktrees/feat-a', branch: 'feat/alpha' },
    { path: '/repo/.worktrees/feat-b', branch: null },
  ])
})

test('parseWorktreeNotes: empty output yields empty list', () => {
  assert.deepEqual(parseWorktreeNotes('no notes here'), [])
})

test('latestWorktreeNote: takes the LAST matching note', () => {
  assert.deepEqual(latestWorktreeNote(NOTE_FIXTURE), {
    path: '/repo/.worktrees/feat-b',
    branch: null,
  })
})

test('latestWorktreeNote: null when no matching note', () => {
  assert.equal(latestWorktreeNote('nothing'), null)
})

// --- herdr list matching ---

function wt(branch: string, path: string): HerdrWorktree {
  return {
    path,
    branch,
    label: branch,
    workspaceId: 'w1',
    isLinked: true,
  }
}

test('matchHerdrWorktree: exact branch match wins', () => {
  const list = [wt('main', '/repo'), wt('feat/alpha', '/repo/.wt/a')]
  assert.equal(matchHerdrWorktree(list, 'feat/alpha')?.path, '/repo/.wt/a')
})

test('matchHerdrWorktree: no match returns null', () => {
  assert.equal(matchHerdrWorktree([wt('main', '/repo')], 'feat/x'), null)
})

test('parseAvenTitle: reads title from the aven metadata line', () => {
  const stdout =
    'PMR-ABC1 status=todo priority=high labels=active epic=yes title="feat(pi-flow): alpha gate"\nid=ABC1\n'
  assert.equal(parseAvenTitle(stdout), 'feat(pi-flow): alpha gate')
})

test('parseAvenTitle: null when no title or empty title', () => {
  assert.equal(parseAvenTitle('no metadata here'), null)
  assert.equal(parseAvenTitle('PMR-ABC1 status=todo title=""'), null)
})

test('titleBranch: conventional prefix maps to branch type + slug', () => {
  assert.equal(
    titleBranch('feat(pi-flow): human code-review gate'),
    'feat/human-code-review-gate',
  )
  assert.equal(
    titleBranch('fix: off-by-one in parser'),
    'fix/off-by-one-in-parser',
  )
})

test('titleBranch: no recognizable prefix falls back to feat', () => {
  assert.equal(
    titleBranch('Human code review gate'),
    'feat/human-code-review-gate',
  )
})

// --- resolver: sources + verification (stale fallthrough, loud failure) ---

function baseDeps(): ReviewDeps {
  return {
    getFlowWorktree: () => null,
    avenShowFull: async () => '',
    herdrWorktreeList: async () => [],
    exec: async (_cmd, args) => {
      if (args.includes('--show-toplevel')) {
        return { code: 0, stdout: '/repo\n', stderr: '' }
      }
      if (args.includes('--abbrev-ref')) {
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    exists: () => true,
    repoRoot: '/repo',
  }
}

test('resolveReviewWorktree: in-session binding wins', async () => {
  const deps = baseDeps()
  deps.getFlowWorktree = () => ({
    ref: 'PMR-ABC1',
    path: '/repo/.wt/bound',
    branch: 'feat/bound',
  })
  deps.exec = async (_cmd, args) => {
    if (args.includes('--abbrev-ref')) {
      return { code: 0, stdout: 'feat/bound\n', stderr: '' }
    }
    return { code: 0, stdout: '/repo\n', stderr: '' }
  }
  const result = await resolveReviewWorktree('PMR-ABC1', deps)
  assert.deepEqual(result, {
    path: '/repo/.wt/bound',
    branch: 'feat/bound',
    source: 'binding',
  })
})

test('resolveReviewWorktree: binding for another ref is ignored', async () => {
  const deps = baseDeps()
  deps.getFlowWorktree = () => ({
    ref: 'PMR-OTHER',
    path: '/repo/.wt/bound',
    branch: 'feat/bound',
  })
  await assert.rejects(
    () => resolveReviewWorktree('PMR-ABC1', deps),
    /PMR-ABC1/,
  )
})

const TITLE_LINE =
  'PMR-ABC1 status=todo priority=high labels=active epic=yes title="feat(pi-flow): alpha gate"\n'

test('resolveReviewWorktree: title-derived exact branch match resolves', async () => {
  const deps = baseDeps()
  deps.avenShowFull = async () =>
    TITLE_LINE + NOTE_FIXTURE.replace('/repo/.worktrees/feat-b', '/gone/stale')
  deps.exists = (p: string) => p !== '/gone/stale'
  deps.herdrWorktreeList = async () => [
    wt('main', '/repo'),
    wt('feat/alpha-gate', '/repo/.wt/a'),
  ]
  deps.exec = async (_cmd, args) => {
    if (args.includes('--abbrev-ref')) {
      return { code: 0, stdout: 'feat/alpha-gate\n', stderr: '' }
    }
    return { code: 0, stdout: '/repo\n', stderr: '' }
  }
  const result = await resolveReviewWorktree('PMR-ABC1', deps)
  // AIDEV-NOTE: the stale notes fail verification, so the herdr source
  // (exact match on the title-derived branch) provides the verified worktree.
  assert.deepEqual(result, {
    path: '/repo/.wt/a',
    branch: 'feat/alpha-gate',
    source: 'herdr',
  })
})

test('resolveReviewWorktree: unparseable title skips herdr title match', async () => {
  const deps = baseDeps()
  deps.avenShowFull = async () =>
    NOTE_FIXTURE.replace('/repo/.worktrees/feat-b', '/gone/stale')
  deps.exists = (p: string) => p !== '/gone/stale'
  deps.herdrWorktreeList = async () => [wt('feat/alpha', '/repo/.wt/a')]
  await assert.rejects(
    () => resolveReviewWorktree('PMR-ABC1', deps),
    /no title parsed/,
  )
})

test('resolveReviewWorktree: note hit with branch mismatch falls through', async () => {
  const deps = baseDeps()
  deps.avenShowFull = async () => NOTE_FIXTURE
  deps.exec = async (_cmd, args) => {
    if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
      return { code: 0, stdout: 'feat/other\n', stderr: '' }
    }
    return { code: 0, stdout: '/repo\n', stderr: '' }
  }
  deps.herdrWorktreeList = async () => [wt('feat/alpha', '/repo/.wt/a')]
  // AIDEV-NOTE: note b (no branch line) verifies fine, so the resolver
  // legitimately settles there instead of falling through to herdr.
  const result = await resolveReviewWorktree('feat-alpha', deps)
  assert.deepEqual(result, {
    path: '/repo/.worktrees/feat-b',
    branch: '',
    source: 'note',
  })
})

test('resolveReviewWorktree: nothing found fails loud naming the ref', async () => {
  await assert.rejects(
    () => resolveReviewWorktree('PMR-ABC1', baseDeps()),
    /no worktree found for PMR-ABC1/,
  )
})

test('resolveReviewWorktree: worktree of another repo is rejected', async () => {
  const deps = baseDeps()
  deps.getFlowWorktree = () => ({
    ref: 'PMR-ABC1',
    path: '/elsewhere/wt',
    branch: 'feat/x',
  })
  deps.exec = async () => ({ code: 0, stdout: '/other-repo\n', stderr: '' })
  await assert.rejects(() => resolveReviewWorktree('PMR-ABC1', deps))
})

// --- openTuicrReview: exec-injected open sequence ---

test('openTuicrReview: tab create + pane run asserted verbatim', async () => {
  const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = []
  const deps = {
    exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      calls.push({ cmd, args, opts })
      if (args[2] === 'merge-base') {
        return { code: 0, stdout: 'abc123\n', stderr: '' }
      }
      if (args[0] === 'tab') {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: { root_pane: { pane_id: 'w1:p9' } },
          }),
          stderr: '',
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const result = await openTuicrReview('PMR-ABC1', '/repo/.wt/a', deps)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.paneId, 'w1:p9')
    assert.equal(result.command, 'cd /repo/.wt/a && tuicr tui -r abc123..HEAD')
  }
  assert.deepEqual(calls[0], {
    cmd: 'git',
    args: ['-C', '/repo/.wt/a', 'merge-base', 'main', 'HEAD'],
    opts: {},
  })
  assert.deepEqual(calls[1], {
    cmd: 'herdr',
    args: [
      'tab',
      'create',
      '--cwd',
      '/repo/.wt/a',
      '--label',
      'review PMR-ABC1',
      '--focus',
    ],
    opts: {},
  })
  assert.deepEqual(calls[2], {
    cmd: 'herdr',
    args: ['pane', 'run', 'w1:p9', 'tuicr', 'tui', '-r', 'abc123..HEAD'],
    opts: {},
  })
})

test('openTuicrReview: tab create failure is fail-closed with manual command', async () => {
  const deps = {
    exec: async (_cmd: string, args: string[]) => {
      if (args[2] === 'merge-base') {
        return { code: 0, stdout: 'abc123\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'herdr: no socket' }
    },
  }
  const result = await openTuicrReview('PMR-ABC1', '/repo/.wt/a', deps)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.reason, /herdr: no socket/)
    assert.equal(result.command, 'cd /repo/.wt/a && tuicr tui -r abc123..HEAD')
  }
})

test('openTuicrReview: missing merge-base fails closed', async () => {
  const deps = {
    exec: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a repo' }),
  }
  const result = await openTuicrReview('PMR-ABC1', '/repo/.wt/a', deps)
  assert.equal(result.ok, false)
})

// --- ask routing ---

test('routeReviewPass: marker + dated note + landing instructions', () => {
  const routing = routeReviewPass('PMR-ABC1', '2026-11-05')
  assert.equal(routing.avenNote, 'human code review passed, 2026-11-05')
  assert.equal(routing.marker, 'PMR-ABC1')
  assert.match(routing.message, /flow_phase_complete/)
  assert.match(routing.message, /flow_land/)
})

test('routeReviewFail: comments become the findings note, routes to /implement', () => {
  const routing = routeReviewFail('PMR-ABC1', 'blocker: null deref in auth.ts')
  assert.equal(routing.avenNote, 'blocker: null deref in auth.ts')
  assert.match(routing.message, /\/implement PMR-ABC1/)
})

test('routeReviewFail: empty comments fall back to free-text ask', () => {
  const routing = routeReviewFail('PMR-ABC1', '   ')
  assert.equal(routing.freeTextFallback, true)
  assert.match(routing.message, /describe the findings/)
})

// --- ask answer parsing ---

test('parseAskAnswer: selected labels map to pass/fail', () => {
  assert.equal(parseAskAnswer('User selected: pass (Recommended)'), 'pass')
  assert.equal(parseAskAnswer('User selected: fail'), 'fail')
  assert.equal(parseAskAnswer('User selected: Other'), null)
})

// --- tuicr session slug ---

test('pickLatestSessionSlug: last session line wins', () => {
  const out = [
    'session: rev-2026-11-04-a  target: main..HEAD',
    'session: rev-2026-11-05-b  target: main..HEAD',
    '',
  ].join('\n')
  assert.equal(pickLatestSessionSlug(out), 'rev-2026-11-05-b')
})

test('pickLatestSessionSlug: null when no sessions', () => {
  assert.equal(pickLatestSessionSlug('no sessions'), null)
})

// --- gate prompt ---

test('buildCodeReviewGatePrompt: instructs the code_review tool call', () => {
  const prompt = buildCodeReviewGatePrompt('PMR-ABC1')
  assert.match(prompt, /code_review/)
  assert.match(prompt, /PMR-ABC1/)
})

// --- registered execute: agent-attested pass gate (PMR-3ZY1 P1) ---

const AVEN_FAKE_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-cr-bin-'))
writeFileSync(path.join(AVEN_FAKE_DIR, 'aven'), '#!/bin/sh\nexit 0\n')
chmodSync(path.join(AVEN_FAKE_DIR, 'aven'), 0o755)

type CodeReviewExecute = (
  toolCallId: string,
  params: { ref: string; outcome?: 'pass' },
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: {
    cwd: string
    tools: Array<{ name: string }>
    ui: { notify: (m: string, l: string) => void }
  },
) => Promise<{
  isError?: boolean
  content: Array<{ type: string; text: string }>
}>

function codeReviewExecute(): CodeReviewExecute {
  let execute: CodeReviewExecute | undefined
  const mockPi = {
    registerTool: (options: { execute: CodeReviewExecute }) => {
      execute = options.execute
    },
  }
  registerCodeReviewTool(
    mockPi as unknown as Parameters<typeof registerCodeReviewTool>[0],
    { authorized: null, humanReviewPassed: null },
  )
  if (!execute) throw new Error('code_review tool not registered')
  return execute
}

function ctxWith(
  tools: Array<{ name: string }>,
): Parameters<CodeReviewExecute>[4] {
  return {
    cwd: '/repo',
    tools,
    ui: { notify: () => {} },
  }
}

async function withFakeAvenPath(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${AVEN_FAKE_DIR}:${previousPath}`
  try {
    await fn()
  } finally {
    process.env.PATH = previousPath
  }
}

test('execute: outcome="pass" refused when ask_user_question is available', async () => {
  const execute = codeReviewExecute()
  const result = await execute(
    't1',
    { ref: 'PMR-ABC1', outcome: 'pass' },
    new AbortController().signal,
    undefined,
    ctxWith([{ name: 'ask_user_question' }]),
  )
  assert.equal(result.isError, true)
  assert.match(result.content.map((c) => c.text).join('\n'), /refused/)
})

test('execute: outcome="pass" records marker when ask_user_question is absent', async () => {
  await withFakeAvenPath(async () => {
    const execute = codeReviewExecute()
    const result = await execute(
      't2',
      { ref: 'PMR-ABC1', outcome: 'pass' },
      new AbortController().signal,
      undefined,
      ctxWith([]),
    )
    assert.notEqual(result.isError, true)
    assert.match(result.content.map((c) => c.text).join('\n'), /flow_land/)
  })
})
