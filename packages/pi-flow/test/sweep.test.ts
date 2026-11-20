import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type FlowRunEvent,
  projectRunState,
  readRunEvents,
  recordRunEvent,
  runStatePath,
} from '../run-state.ts'
import {
  isTerminalSweepOutcome,
  lastSweepOutcome,
  refsFromRunsDir,
  sweepCandidateInput,
} from '../worktree/sweep.ts'

function sweepEvent(overrides: {
  at: string
  ref?: string
  source?: 'flow-done' | 'sweep'
  outcome: 'removed' | 'noop' | 'kept-all' | 'deferred'
  detail?: string
}): FlowRunEvent {
  return {
    kind: 'worktree-sweep',
    at: overrides.at,
    ref: overrides.ref ?? 'PMR-1',
    source: overrides.source ?? 'sweep',
    outcome: overrides.outcome,
    ...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
  }
}

function runStart(at: string, ref = 'PMR-1'): FlowRunEvent {
  return { kind: 'run-start', at, ref, mode: 'work' }
}

// --- isTerminalSweepOutcome ---

test('isTerminalSweepOutcome: removed and noop are terminal', () => {
  assert.equal(isTerminalSweepOutcome('removed'), true)
  assert.equal(isTerminalSweepOutcome('noop'), true)
})

test('isTerminalSweepOutcome: kept-all and deferred are not terminal', () => {
  assert.equal(isTerminalSweepOutcome('kept-all'), false)
  assert.equal(isTerminalSweepOutcome('deferred'), false)
})

// --- lastSweepOutcome ---

test('lastSweepOutcome: returns the latest worktree-sweep event', () => {
  const events = [
    runStart('t0'),
    sweepEvent({ at: 't1', outcome: 'deferred' }),
    sweepEvent({ at: 't2', source: 'flow-done', outcome: 'noop' }),
  ]
  assert.deepEqual(lastSweepOutcome(events), {
    outcome: 'noop',
    source: 'flow-done',
  })
})

test('lastSweepOutcome: null when there are no sweep events', () => {
  assert.equal(lastSweepOutcome([runStart('t0')]), null)
  assert.equal(lastSweepOutcome([]), null)
})

// --- refsFromRunsDir ---

test('refsFromRunsDir: strips suffixes, filters invalid, sorts, dedupes', () => {
  const names = [
    'PMR-ABC123.journal.jsonl',
    'PMR-ABC123.json',
    'DP-71.journal.jsonl',
    'evil/ref.journal.jsonl',
    '../traversal.journal.jsonl',
    'has space.journal.jsonl',
    '-leading-dash.journal.jsonl',
    'PMR-ABC123.journal.jsonl',
    '.hidden.journal.jsonl',
  ]
  assert.deepEqual(refsFromRunsDir(names), ['DP-71', 'PMR-ABC123'])
})

test('refsFromRunsDir: empty input yields empty list', () => {
  assert.deepEqual(refsFromRunsDir([]), [])
})

// --- sweepCandidateInput ---

test('sweepCandidateInput: returns the latest run-input mode and gitRoot', () => {
  const events: FlowRunEvent[] = [
    runStart('t0'),
    {
      kind: 'run-input',
      at: 't1',
      ref: 'PMR-1',
      input: {
        mode: 'work',
        gitRoot: '/repo',
        workRoots: ['/repo'],
      },
    },
    {
      kind: 'run-input',
      at: 't2',
      ref: 'PMR-1',
      input: {
        mode: 'personal',
        gitRoot: '/repo2',
        workRoots: [],
      },
    },
  ]
  assert.deepEqual(sweepCandidateInput(events), {
    mode: 'personal',
    gitRoot: '/repo2',
  })
})

test('sweepCandidateInput: null for journals without a run-input', () => {
  assert.equal(sweepCandidateInput([runStart('t0')]), null)
  assert.equal(sweepCandidateInput([]), null)
  assert.equal(sweepCandidateInput(null), null)
})

// --- journal round-trip: worktree-sweep survives append -> read -> projection ---

type MemFiles = Map<string, string>

function fakeIo(files: MemFiles) {
  return {
    readFile: async (p: string) => {
      const content = files.get(p)
      if (content === undefined) throw new Error('ENOENT')
      return content
    },
    appendFile: async (p: string, data: string) => {
      files.set(p, (files.get(p) ?? '') + data)
    },
    writeFile: async (p: string, data: string) => {
      files.set(p, data)
    },
    mkdir: async () => {},
  }
}

test('worktree-sweep journal round-trip survives append, read, projection', async () => {
  const files: MemFiles = new Map()
  const agentDir = '/agent'
  await recordRunEvent(agentDir, runStart('t0'), fakeIo(files))
  await recordRunEvent(
    agentDir,
    sweepEvent({
      at: 't1',
      source: 'flow-done',
      outcome: 'removed',
      detail: 'PMR-ABC123',
    }),
    fakeIo(files),
  )
  const events = await readRunEvents('/agent', 'PMR-1', fakeIo(files))
  assert.ok(events)
  const sweep = events.find((e) => e.kind === 'worktree-sweep')
  assert.ok(sweep)
  assert.equal(sweep.source, 'flow-done')
  assert.equal(sweep.outcome, 'removed')
  assert.equal(sweep.detail, 'PMR-ABC123')
  // Projection tolerates the sweep event without crashing.
  const state = projectRunState(events)
  assert.ok(state)
  assert.equal(state.ref, 'PMR-1')
  assert.equal(state.updatedAt, 't1')
})

test('worktree-sweep round-trip: readRunEvents and projection keep it', async () => {
  const files: MemFiles = new Map()
  const ref = 'PMR-1'
  const statePath = runStatePath('/agent', ref)
  assert.ok(statePath)
  const journalPath = `${statePath.slice(0, -'.json'.length)}.journal.jsonl`
  files.set(
    journalPath,
    [
      JSON.stringify(runStart('t0')),
      JSON.stringify(
        sweepEvent({ at: 't1', outcome: 'deferred', detail: 'labels' }),
      ),
      JSON.stringify(
        sweepEvent({ at: 't2', source: 'flow-done', outcome: 'noop' }),
      ),
    ]
      .join('\n')
      .concat('\n'),
  )
  const events = await readRunEvents('/agent', ref, fakeIo(files))
  assert.ok(events)
  const sweeps = events.filter((e) => e.kind === 'worktree-sweep')
  assert.equal(sweeps.length, 2)
  assert.deepEqual(lastSweepOutcome(events), {
    outcome: 'noop',
    source: 'flow-done',
  })
  // Projection tolerates the sweep events without crashing (PMR-Z2K7).
  const state = projectRunState(events)
  assert.ok(state)
  assert.equal(state.ref, ref)
  assert.equal(state.updatedAt, 't2')
})

// --- resolveNoteWorktree ---
// AIDEV-NOTE: PMR-8SFJ resolver matrix. aven goes through a fake on PATH
// (routed by mode file) because avenShowFull execs the real binary; herdr
// goes through a routed pi.exec fake following makeCleanupExec
// (test/worktree.test.ts:1350+).

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { setAvenSessionCwd } from '../aven/client.ts'
import type { EffectJournal } from '../run-state.ts'
import {
  resolveNoteWorktree,
  sweepMergedFlowWorktrees,
} from '../worktree/sweep.ts'

const NOTE_BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-note-bin-'))
const NOTE_SHOW_FILE = path.join(NOTE_BIN_DIR, 'show.txt')
const NOTE_MODE_FILE = path.join(NOTE_BIN_DIR, 'mode.txt')
writeFileSync(NOTE_MODE_FILE, 'ok')
writeFileSync(
  path.join(NOTE_BIN_DIR, 'aven'),
  `#!/bin/sh
mode=$(cat ${NOTE_MODE_FILE})
if [ "$mode" = "fail" ]; then
  echo "aven exploded" >&2
  exit 1
fi
cat ${NOTE_SHOW_FILE}
`,
)
chmodSync(path.join(NOTE_BIN_DIR, 'aven'), 0o755)

const NOTE_SESSION_CWD = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-note-ws-'))
mkdirSync(path.join(NOTE_SESSION_CWD, '.pi', 'pi-flow'), { recursive: true })
writeFileSync(
  path.join(NOTE_SESSION_CWD, '.pi', 'pi-flow', 'config.json'),
  JSON.stringify({ workRoots: [], avenWorkspace: 'ws-note-test' }),
)

const NOTE_WT_PATH = path.join(NOTE_SESSION_CWD, 'wt', 'feat-note')
const NOTE_BRANCH = 'feat/note-x'

/** Route herdr worktree list through a pi.exec fake. */
function noteExec(worktrees: unknown, failHerdr = false) {
  return async (): Promise<{
    code: number
    stdout: string
    stderr: string
  }> => {
    if (failHerdr) {
      return { code: 1, stdout: '', stderr: 'herdr exploded' }
    }
    return {
      code: 0,
      stdout: JSON.stringify({ result: { worktrees } }),
      stderr: '',
    }
  }
}

async function withFakeAven(
  show: string,
  mode: string,
  fn: () => Promise<void>,
): Promise<void> {
  writeFileSync(NOTE_SHOW_FILE, show)
  writeFileSync(NOTE_MODE_FILE, mode)
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${NOTE_BIN_DIR}:${previousPath}`
  setAvenSessionCwd(NOTE_SESSION_CWD)
  try {
    await fn()
  } finally {
    process.env.PATH = previousPath
  }
}

function noteShow(bodyLines: string[]): string {
  return [
    'PMR-1 status=todo title="x"',
    'note id=n1 key=worktree',
    'body<<EOF',
    ...bodyLines,
    'EOF',
    '',
  ].join('\n')
}

const LINKED_WT = {
  path: NOTE_WT_PATH,
  branch: NOTE_BRANCH,
  label: 'feat-note',
  workspace_id: 'ws1',
  is_linked_worktree: true,
}

test('resolveNoteWorktree: bound via single-line note', async () => {
  await withFakeAven(
    noteShow([`worktree: ${NOTE_WT_PATH} branch: ${NOTE_BRANCH}`]),
    'ok',
    async () => {
      const binding = await resolveNoteWorktree(
        { exec: noteExec([LINKED_WT]) } as unknown as ExtensionAPI,
        NOTE_SESSION_CWD,
        'PMR-1',
      )
      assert.deepEqual(binding, {
        kind: 'bound',
        worktree: { ref: 'PMR-1', path: NOTE_WT_PATH, branch: NOTE_BRANCH },
      })
    },
  )
})

test('resolveNoteWorktree: bound via two-line note', async () => {
  await withFakeAven(
    noteShow([`worktree: ${NOTE_WT_PATH}`, `branch: ${NOTE_BRANCH}`]),
    'ok',
    async () => {
      const binding = await resolveNoteWorktree(
        { exec: noteExec([LINKED_WT]) } as unknown as ExtensionAPI,
        NOTE_SESSION_CWD,
        'PMR-1',
      )
      assert.deepEqual(binding, {
        kind: 'bound',
        worktree: { ref: 'PMR-1', path: NOTE_WT_PATH, branch: NOTE_BRANCH },
      })
    },
  )
})

test('resolveNoteWorktree: bound via path match when note branch is null', async () => {
  await withFakeAven(
    noteShow([`worktree: ${NOTE_WT_PATH}`]),
    'ok',
    async () => {
      const binding = await resolveNoteWorktree(
        { exec: noteExec([LINKED_WT]) } as unknown as ExtensionAPI,
        NOTE_SESSION_CWD,
        'PMR-1',
      )
      assert.deepEqual(binding, {
        kind: 'bound',
        worktree: { ref: 'PMR-1', path: NOTE_WT_PATH, branch: NOTE_BRANCH },
      })
    },
  )
})

test('resolveNoteWorktree: gone when note path does not exist', async () => {
  await withFakeAven(
    noteShow(['worktree: /tmp/does-not-exist-wt branch: feat/gone']),
    'ok',
    async () => {
      const binding = await resolveNoteWorktree(
        { exec: noteExec([LINKED_WT]) } as unknown as ExtensionAPI,
        NOTE_SESSION_CWD,
        'PMR-1',
      )
      assert.deepEqual(binding, { kind: 'gone' })
    },
  )
})

test('resolveNoteWorktree: gone on herdr branch mismatch', async () => {
  await withFakeAven(
    noteShow([`worktree: ${NOTE_WT_PATH} branch: ${NOTE_BRANCH}`]),
    'ok',
    async () => {
      const binding = await resolveNoteWorktree(
        {
          exec: noteExec([
            { ...LINKED_WT, branch: 'other/branch', path: '/tmp/other' },
          ]),
        } as unknown as ExtensionAPI,
        NOTE_SESSION_CWD,
        'PMR-1',
      )
      assert.deepEqual(binding, { kind: 'gone' })
    },
  )
})

test('resolveNoteWorktree: none when show has no worktree note body', async () => {
  await withFakeAven('PMR-1 status=todo title="x"\n', 'ok', async () => {
    const binding = await resolveNoteWorktree(
      { exec: noteExec([LINKED_WT]) } as unknown as ExtensionAPI,
      NOTE_SESSION_CWD,
      'PMR-1',
      [],
    )
    assert.deepEqual(binding, { kind: 'none' })
  })
})

test('resolveNoteWorktree: unverifiable when aven show fails', async () => {
  await withFakeAven('', 'fail', async () => {
    const binding = await resolveNoteWorktree(
      { exec: noteExec([LINKED_WT]) } as unknown as ExtensionAPI,
      NOTE_SESSION_CWD,
      'PMR-1',
      [],
    )
    assert.equal(binding.kind, 'unverifiable')
  })
})

test('resolveNoteWorktree: unverifiable when herdr worktree list fails', async () => {
  await withFakeAven(
    noteShow([`worktree: ${NOTE_WT_PATH} branch: ${NOTE_BRANCH}`]),
    'ok',
    async () => {
      const binding = await resolveNoteWorktree(
        { exec: noteExec([], true) } as unknown as ExtensionAPI,
        NOTE_SESSION_CWD,
        'PMR-1',
      )
      assert.equal(binding.kind, 'unverifiable')
    },
  )
})

test('resolveNoteWorktree: chat-text worktree mentions are ignored', async () => {
  await withFakeAven(
    [
      'PMR-1 status=todo title="x"',
      'the worktree: should be ignored in chat text',
      '',
    ].join('\n'),
    'ok',
    async () => {
      const binding = await resolveNoteWorktree(
        { exec: noteExec([LINKED_WT]) } as unknown as ExtensionAPI,
        NOTE_SESSION_CWD,
        'PMR-1',
      )
      assert.deepEqual(binding, { kind: 'none' })
    },
  )
})

// The bound cases need note.path to exist on disk.
mkdirSync(NOTE_WT_PATH, { recursive: true })

// AIDEV-NOTE: herdr worktree list output paths come from the CLI, so the
// parsed `path` string equals NOTE_WT_PATH only if the fixture uses it.
process.on('exit', () => {
  try {
    rmSync(NOTE_SESSION_CWD, { recursive: true, force: true })
    rmSync(NOTE_BIN_DIR, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

// --- sweepMergedFlowWorktrees (engine smoke tests; full scenario matrix
// --- belongs to subtask 2.2's harness) ---

test('sweepMergedFlowWorktrees: sessionGitRoot null returns quietly with zero deps calls', async () => {
  let listRefsCalls = 0
  await sweepMergedFlowWorktrees(
    {} as ExtensionAPI,
    { declare: async () => {} } as unknown as EffectJournal,
    '/tmp',
    {
      listRefs: async () => {
        listRefsCalls++
        return ['PMR-1']
      },
      readEvents: async () => [],
      appendEvent: async () => {},
      readLabels: async () => [],
      annotate: async () => {},
      sessionGitRoot: async () => null,
    },
  )
  assert.equal(listRefsCalls, 0)
})
