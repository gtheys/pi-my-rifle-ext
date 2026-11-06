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

test('parseWorktreeNotes: single-line note the skill writes', () => {
  const out = `PMR-R4AP status=active title="x"

note id=n9 author=pi at=2026-01-05
body<<EOF
worktree: /home/u/wt/fix-a branch: fix/a-b
EOF
`
  assert.deepEqual(parseWorktreeNotes(out), [
    { path: '/home/u/wt/fix-a', branch: 'fix/a-b' },
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
      if (args.includes('--git-common-dir')) {
        return { code: 0, stdout: '/repo/.git\n', stderr: '' }
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

test('resolveReviewWorktree: no herdr match names the expected branch', async () => {
  const deps = baseDeps()
  deps.avenShowFull = async () => TITLE_LINE
  deps.herdrWorktreeList = async () => [wt('feat/other', '/repo/.wt/o')]
  await assert.rejects(
    () => resolveReviewWorktree('PMR-ABC1', deps),
    /expected branch feat\/alpha-gate/,
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
  deps.exec = async (_cmd, args) => {
    if (args.includes('--abbrev-ref')) {
      return { code: 0, stdout: 'feat/x\n', stderr: '' }
    }
    if (args.includes('/elsewhere/wt')) {
      return { code: 0, stdout: '/other-repo/.git\n', stderr: '' }
    }
    return { code: 0, stdout: '/repo/.git\n', stderr: '' }
  }
  await assert.rejects(
    () => resolveReviewWorktree('PMR-ABC1', deps),
    /different repository/,
  )
})

// failing = which side's rev-parse exits non-zero; candidate path is /repo
// (identical to repoRoot) so a missed exit check would falsely verify.
for (const failing of ['/repo', '/session']) {
  test(`resolveReviewWorktree: non-zero rev-parse on ${failing} fails closed`, async () => {
    const deps = baseDeps()
    deps.repoRoot = '/session'
    deps.getFlowWorktree = () => ({
      ref: 'PMR-ABC1',
      path: '/repo',
      branch: 'feat/x',
    })
    deps.exec = async (_cmd, args) => {
      if (args.includes('--abbrev-ref')) {
        return { code: 0, stdout: 'feat/x\n', stderr: '' }
      }
      if (args[1] === failing) {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    await assert.rejects(
      () => resolveReviewWorktree('PMR-ABC1', deps),
      /git-common-dir failed.*exit 128/,
    )
  })
}

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
// AIDEV-NOTE: PMR-G68P — real tuicr v0.27.0 `review list` output is a JSON
// array; freshness is decided by updated_at, not array order.

test('pickLatestSessionSlug: max updated_at wins regardless of array order', () => {
  const out = JSON.stringify([
    { slug: 'rev-newer', updated_at: '2026-11-05T10:00:00+00:00' },
    { slug: 'rev-older', updated_at: '2026-11-04T09:00:00+00:00' },
  ])
  assert.equal(pickLatestSessionSlug(out), 'rev-newer')
})

test('pickLatestSessionSlug: null on non-JSON or session-less output', () => {
  assert.equal(pickLatestSessionSlug('no sessions'), null)
  assert.equal(pickLatestSessionSlug('[]'), null)
  assert.equal(pickLatestSessionSlug(JSON.stringify([{ slug: '' }])), null)
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

type ToolCtx = {
  cwd: string
  tools: Array<{ name: string }>
  ui: { notify: (m: string, l: string) => void }
  executeTool: (
    name: string,
    args: unknown,
  ) => Promise<{ result: { content: Array<{ type: string; text: string }> } }>
}

type CodeReviewExecute = (
  toolCallId: string,
  params: { ref: string; outcome?: 'pass' },
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: ToolCtx,
) => Promise<{
  isError?: boolean
  content: Array<{ type: string; text: string }>
}>

type MockExec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>

function codeReviewExecute(exec?: MockExec): {
  execute: CodeReviewExecute
  landingState: { authorized: string | null; humanReviewPassed: string | null }
} {
  let execute: CodeReviewExecute | undefined
  const mockPi = {
    registerTool: (options: { execute: CodeReviewExecute }) => {
      execute = options.execute
    },
    exec: exec ?? (async () => ({ code: 0, stdout: '', stderr: '' })),
  }
  const landingState = { authorized: null, humanReviewPassed: null }
  registerCodeReviewTool(
    mockPi as unknown as Parameters<typeof registerCodeReviewTool>[0],
    landingState,
  )
  if (!execute) throw new Error('code_review tool not registered')
  return { execute, landingState }
}

function ctxWith(
  tools: Array<{ name: string }>,
  executeTool?: ToolCtx['executeTool'],
): ToolCtx {
  return {
    cwd: '/repo',
    tools,
    ui: { notify: () => {} },
    executeTool:
      executeTool ??
      (async () => ({ result: { content: [{ type: 'text', text: '' }] } })),
  }
}

function askAnswer(text: string): {
  result: { content: Array<{ type: string; text: string }> }
} {
  return { result: { content: [{ type: 'text', text }] } }
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
  const { execute } = codeReviewExecute()
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
    const { execute, landingState } = codeReviewExecute()
    const result = await execute(
      't2',
      { ref: 'PMR-ABC1', outcome: 'pass' },
      new AbortController().signal,
      undefined,
      ctxWith([]),
    )
    assert.notEqual(result.isError, true)
    assert.equal(landingState.humanReviewPassed, 'PMR-ABC1')
    assert.match(result.content.map((c) => c.text).join('\n'), /flow_land/)
  })
})

// --- registered execute: full gate paths (PMR-G68P) ---
// AIDEV-NOTE: the worktree path must exist on disk (productionDeps.exists
// is existsSync), so the herdr fake points at a real temp dir. Resolution
// settles on the herdr source: aven show returns a title but no notes.

const CR_WT_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-cr-wt-'))

function gateExec(tuicr: { listStdout: string; commentsStdout: string }): {
  exec: MockExec
  calls: Array<{ cmd: string; args: string[] }>
} {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const exec: MockExec = async (cmd, args) => {
    calls.push({ cmd, args })
    if (cmd === 'aven') {
      return {
        code: 0,
        stdout: 'PMR-ABC1 status=todo title="feat(pi-flow): alpha gate"\n',
        stderr: '',
      }
    }
    if (cmd === 'herdr' && args[0] === 'worktree') {
      return {
        code: 0,
        stdout: JSON.stringify({
          result: {
            worktrees: [
              {
                branch: 'feat/alpha-gate',
                path: CR_WT_DIR,
                label: 'alpha',
                open_workspace_id: 'w1',
                is_linked_worktree: true,
              },
            ],
          },
        }),
        stderr: '',
      }
    }
    if (cmd === 'git' && args.includes('--git-common-dir')) {
      return { code: 0, stdout: '/repo/.git\n', stderr: '' }
    }
    if (cmd === 'git' && args.includes('--abbrev-ref')) {
      return { code: 0, stdout: 'feat/alpha-gate\n', stderr: '' }
    }
    if (cmd === 'git' && args.includes('merge-base')) {
      return { code: 0, stdout: 'abc123\n', stderr: '' }
    }
    if (cmd === 'herdr' && args[0] === 'tab') {
      return {
        code: 0,
        stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w1:p9' } } }),
        stderr: '',
      }
    }
    if (cmd === 'tuicr' && args[1] === 'list') {
      return { code: 0, stdout: tuicr.listStdout, stderr: '' }
    }
    if (cmd === 'tuicr' && args[1] === 'comments') {
      return { code: 0, stdout: tuicr.commentsStdout, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

test('execute: pass via blocking ask records marker and note', async () => {
  await withFakeAvenPath(async () => {
    const { exec } = gateExec({ listStdout: '[]', commentsStdout: '' })
    const { execute, landingState } = codeReviewExecute(exec)
    const result = await execute(
      't3',
      { ref: 'PMR-ABC1' },
      new AbortController().signal,
      undefined,
      ctxWith([{ name: 'ask_user_question' }], async () =>
        askAnswer('User selected: pass (Recommended)'),
      ),
    )
    assert.notEqual(result.isError, true)
    assert.equal(landingState.humanReviewPassed, 'PMR-ABC1')
    assert.match(result.content.map((c) => c.text).join('\n'), /human PASS/)
  })
})

test('execute: fail with tuicr comments routes back to /implement', async () => {
  await withFakeAvenPath(async () => {
    const { exec, calls } = gateExec({
      listStdout: JSON.stringify([
        { slug: 'rev-1', updated_at: '2026-11-05T10:00:00+00:00' },
      ]),
      commentsStdout: 'blocker: null deref in auth.ts',
    })
    const { execute, landingState } = codeReviewExecute(exec)
    const result = await execute(
      't4',
      { ref: 'PMR-ABC1' },
      new AbortController().signal,
      undefined,
      ctxWith([{ name: 'ask_user_question' }], async () =>
        askAnswer('User selected: fail'),
      ),
    )
    assert.equal(result.isError, true)
    assert.equal(landingState.humanReviewPassed, null)
    const text = result.content.map((c) => c.text).join('\n')
    assert.match(text, /human FAIL/)
    assert.match(text, /\/implement PMR-ABC1/)
    const tuicrCalls = calls
      .filter((c) => c.cmd === 'tuicr')
      .map((c) => c.args[1])
    assert.deepEqual(tuicrCalls, ['list', 'comments'])
  })
})

test('execute: fail with empty comments falls back to free-text findings', async () => {
  await withFakeAvenPath(async () => {
    const { exec } = gateExec({ listStdout: '[]', commentsStdout: '' })
    const { execute } = codeReviewExecute(exec)
    const asked: string[] = []
    const result = await execute(
      't5',
      { ref: 'PMR-ABC1' },
      new AbortController().signal,
      undefined,
      ctxWith([{ name: 'ask_user_question' }], async (_name, args) => {
        const question = (args as { question: string }).question
        asked.push(question)
        if (question.includes('pass or fail'))
          return askAnswer('User selected: fail')
        return askAnswer('User answered: stale lock in the gate')
      }),
    )
    assert.equal(result.isError, true)
    assert.equal(asked.length, 2)
    assert.match(asked[1] ?? '', /findings note/)
    assert.match(
      result.content.map((c) => c.text).join('\n'),
      /findings recorded/,
    )
  })
})

test('execute: unclear ask answer does NOT point at outcome="pass"', async () => {
  await withFakeAvenPath(async () => {
    const { exec } = gateExec({ listStdout: '[]', commentsStdout: '' })
    const { execute } = codeReviewExecute(exec)
    const result = await execute(
      't6',
      { ref: 'PMR-ABC1' },
      new AbortController().signal,
      undefined,
      ctxWith([{ name: 'ask_user_question' }], async () =>
        askAnswer('User selected: Other'),
      ),
    )
    assert.equal(result.isError, true)
    const text = result.content.map((c) => c.text).join('\n')
    assert.match(text, /unclear/)
    assert.doesNotMatch(text, /outcome="pass"/)
  })
})

test('execute: unresolved worktree is a loud refusal', async () => {
  const exec: MockExec = async (cmd, args) => {
    if (cmd === 'aven')
      return { code: 0, stdout: 'PMR-ABC1 status=todo\n', stderr: '' }
    if (cmd === 'herdr' && args[0] === 'worktree') {
      return {
        code: 0,
        stdout: JSON.stringify({ result: { worktrees: [] } }),
        stderr: '',
      }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const { execute } = codeReviewExecute(exec)
  const result = await execute(
    't7',
    { ref: 'PMR-ABC1' },
    new AbortController().signal,
    undefined,
    ctxWith([{ name: 'ask_user_question' }]),
  )
  assert.equal(result.isError, true)
  assert.match(
    result.content.map((c) => c.text).join('\n'),
    /no worktree found for PMR-ABC1/,
  )
})
