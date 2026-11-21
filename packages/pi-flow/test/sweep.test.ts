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
  const event: FlowRunEvent = {
    kind: 'worktree-sweep',
    at: overrides.at,
    ref: overrides.ref ?? 'PMR-1',
    source: overrides.source ?? 'sweep',
    outcome: overrides.outcome,
  }
  // AIDEV-NOTE: if/else assignment instead of a spread-ternary (PMR-B8MQ);
  // repo-wide rule forbids ternaries (PMR-YG2N constraint 4).
  if (overrides.detail !== undefined) {
    event.detail = overrides.detail
  }
  return event
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
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { setAvenSessionCwd } from '../aven/client.ts'
import {
  clearFlowWorktree,
  setActiveFlowRef,
  setFlowWorktree,
} from '../flow/worktree-context.ts'
import type { EffectJournal } from '../run-state.ts'
import {
  resolveDoneWorktree,
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

// --- sweepMergedFlowWorktrees: scenario matrix (2.2, PMR-YG2N/PMR-YAX8) ---
// AIDEV-NOTE: harness = routed pi.exec fake (git/herdr à la makeCleanupExec,
// test/worktree.test.ts:1350+) + in-memory journals (listRefs/readEvents/
// appendEvent/readLabels/annotate). aven show --full goes through a per-ref
// routing fake on PATH (same pattern as the resolver matrix above). appendEvent
// writes into the fake event store so terminal/deferred marker behavior is
// provable across repeated sweep runs.

const SWEEP_BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-sweep-bin-'))
const SWEEP_SHOW_DIR = path.join(SWEEP_BIN_DIR, 'shows')
const SWEEP_AVEN_LOG = path.join(SWEEP_BIN_DIR, 'aven-calls.log')
mkdirSync(SWEEP_SHOW_DIR, { recursive: true })
writeFileSync(
  path.join(SWEEP_BIN_DIR, 'aven'),
  `#!/bin/sh
ref=""
prev=""
for a in "$@"; do
  if [ "$prev" = "show" ]; then
    ref="$a"
  fi
  prev="$a"
done
echo "$ref" >> ${SWEEP_AVEN_LOG}
if [ -f "${SWEEP_SHOW_DIR}/$ref.txt" ]; then
  cat "${SWEEP_SHOW_DIR}/$ref.txt"
  exit 0
fi
echo "no show fixture for $ref" >&2
exit 1
`,
)
chmodSync(path.join(SWEEP_BIN_DIR, 'aven'), 0o755)

const SWEEP_GIT_ROOT = '/repo-sweep-root'
const SWEEP_MAIN_CWD = '/tmp/sweep-main-checkout'
const SWEEP_BASE_SHA = `${'c'.repeat(39)}d`
const SWEEP_WT_ROOT = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-sweep-wt-'))

const DONE_LABELS = ['planned', 'active', 'review-passed', 'done']

interface RefFixture {
  ref: string
  labels: string[] | null
  gitRoot?: string
  showBody?: string[] | null
  seedEvents?: FlowRunEvent[]
}

interface CapturedDeclarationShape {
  ref: string
  effect: string
  command: string
  recipe: string[]
  headSha?: string
}

type SweepMarkerEvent = Extract<FlowRunEvent, { kind: 'worktree-sweep' }>

interface SweepHarness {
  run: () => Promise<void>
  calls: Array<{ command: string; args: string; cwd: string | undefined }>
  herdrRemoves: string[]
  branchDeletes: string[]
  declarations: CapturedDeclarationShape[]
  annotations: Array<{ ref: string; body: string }>
  appendedEvents: FlowRunEvent[]
  avenRefs: () => string[]
  markersFor: (ref: string) => SweepMarkerEvent[]
  wtPathFor: (ref: string) => string
  branchFor: (ref: string) => string
  workspaceFor: (ref: string) => string
}

interface SweepHarnessOptions {
  refs: RefFixture[]
  sessionGitRoot?: string | null
  dirtyPaths?: string[]
  mergeBaseOk?: boolean
  agents?: unknown[]
  emptyHerdr?: boolean
  failAppend?: boolean
}

function sweepShowBody(ref: string, wtPath: string, branch: string): string[] {
  return [
    `${ref} status=todo title="sweep fixture"`,
    'note id=n1 key=worktree',
    'body<<EOF',
    `worktree: ${wtPath} branch: ${branch}`,
    'EOF',
    '',
  ]
}

function makeSweepHarness(options: SweepHarnessOptions): SweepHarness {
  const sessionGitRoot = options.sessionGitRoot ?? SWEEP_GIT_ROOT
  const calls: Array<{
    command: string
    args: string
    cwd: string | undefined
  }> = []
  const herdrRemoves: string[] = []
  const branchDeletes: string[] = []
  const declarations: CapturedDeclarationShape[] = []
  const annotations: Array<{ ref: string; body: string }> = []
  const appendedEvents: FlowRunEvent[] = []
  const eventStore = new Map<string, FlowRunEvent[]>()
  const branchByRef = new Map<string, string>()
  const wtPathByRef = new Map<string, string>()
  const wsByRef = new Map<string, string>()

  const worktrees: unknown[] = []
  if (options.emptyHerdr !== true) {
    for (const fixture of options.refs) {
      const branch = `feat/sweep-${fixture.ref.toLowerCase()}`
      const wtPath = path.join(SWEEP_WT_ROOT, fixture.ref.toLowerCase())
      const wsId = `ws-${fixture.ref.toLowerCase()}`
      mkdirSync(wtPath, { recursive: true })
      branchByRef.set(fixture.ref, branch)
      wtPathByRef.set(fixture.ref, wtPath)
      wsByRef.set(fixture.ref, wsId)
      worktrees.push({
        path: wtPath,
        branch,
        label: fixture.ref.toLowerCase(),
        workspace_id: wsId,
        is_linked_worktree: true,
      })
      let showBody: string[] | null
      if (fixture.showBody === null) {
        showBody = null
      } else if (fixture.showBody !== undefined) {
        showBody = fixture.showBody
      } else {
        showBody = sweepShowBody(fixture.ref, wtPath, branch)
      }
      if (showBody !== null) {
        writeFileSync(
          path.join(SWEEP_SHOW_DIR, `${fixture.ref}.txt`),
          `${showBody.join('\n')}\n`,
        )
      }
    }
  }

  for (const fixture of options.refs) {
    const events: FlowRunEvent[] = [
      {
        kind: 'run-start',
        at: 't0',
        ref: fixture.ref,
        mode: 'personal',
      },
      {
        kind: 'run-input',
        at: 't1',
        ref: fixture.ref,
        input: {
          mode: 'personal',
          gitRoot: fixture.gitRoot ?? sessionGitRoot,
          workRoots: [],
        },
      },
    ]
    if (fixture.seedEvents !== undefined) {
      events.push(...fixture.seedEvents)
    }
    eventStore.set(fixture.ref, events)
  }

  const dirtyPaths = options.dirtyPaths ?? []
  let mergeBaseCode = 1
  if (options.mergeBaseOk === true) {
    mergeBaseCode = 0
  }

  const exec = async (
    command: string,
    args: string[],
    execOptions?: { cwd?: string },
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    const cwd = execOptions?.cwd
    calls.push({ command, args: args.join(' '), cwd })
    if (command === 'git' && args[0] === 'status') {
      if (cwd !== undefined && dirtyPaths.includes(cwd)) {
        return { code: 0, stdout: ' M src/dirty.ts\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'herdr' && args[1] === 'agent') {
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ result: { agents: options.agents ?? [] } }),
      }
    }
    if (command === 'herdr' && args[1] === 'remove') {
      herdrRemoves.push(args.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'herdr') {
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ result: { worktrees } }),
      }
    }
    if (command === 'git' && args[0] === 'worktree') {
      return {
        code: 0,
        stderr: '',
        stdout: `worktree ${SWEEP_MAIN_CWD}\nbranch refs/heads/main\n`,
      }
    }
    if (command === 'git' && args[0] === 'merge-base') {
      return { code: mergeBaseCode, stdout: '', stderr: '' }
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stderr: '', stdout: `${SWEEP_BASE_SHA}\n` }
    }
    if (command === 'git' && args[0] === 'branch' && args[1] === '-D') {
      branchDeletes.push(args.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && args[0] === 'fetch') {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (command === 'git' && args[0] === 'config') {
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }

  const pi = { exec } as unknown as ExtensionAPI
  const effects = {
    declare: async (input: {
      ref: string
      effect: string
      command: string
      recipe: string[]
      headSha?: string
    }) => {
      declarations.push({
        ref: input.ref,
        effect: input.effect,
        command: input.command,
        recipe: input.recipe,
        headSha: input.headSha,
      })
      return { ok: true as const, effectId: 'sweepdeadbeef' }
    },
    find: async () => null,
  } as unknown as EffectJournal

  async function run(): Promise<void> {
    writeFileSync(SWEEP_AVEN_LOG, '')
    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${SWEEP_BIN_DIR}:${previousPath}`
    setAvenSessionCwd(NOTE_SESSION_CWD)
    try {
      await sweepMergedFlowWorktrees(pi, effects, SWEEP_MAIN_CWD, {
        listRefs: async () => options.refs.map((f) => f.ref).sort(),
        readEvents: async (ref) => eventStore.get(ref) ?? [],
        appendEvent: async (event: FlowRunEvent) => {
          if (options.failAppend === true) {
            throw new Error('append exploded')
          }
          const list = eventStore.get(event.ref) ?? []
          list.push(event)
          eventStore.set(event.ref, list)
          appendedEvents.push(event)
        },
        readLabels: async (ref) => {
          const fixture = options.refs.find((f) => f.ref === ref)
          if (fixture === undefined) return null
          return fixture.labels
        },
        annotate: async (ref: string, body: string) => {
          annotations.push({ ref, body })
        },
        sessionGitRoot: async () => sessionGitRoot,
      })
    } finally {
      process.env.PATH = previousPath
    }
  }

  return {
    run,
    calls,
    herdrRemoves,
    branchDeletes,
    declarations,
    annotations,
    appendedEvents,
    avenRefs: () => readFileSyncLog().filter((line) => line.trim() !== ''),
    markersFor: (ref) => {
      const events = eventStore.get(ref) ?? []
      const markers: SweepMarkerEvent[] = []
      for (const event of events) {
        if (event.kind === 'worktree-sweep' && event.source === 'sweep') {
          markers.push(event)
        }
      }
      return markers
    },
    wtPathFor: (ref) => wtPathByRef.get(ref) ?? '',
    branchFor: (ref) => branchByRef.get(ref) ?? '',
    workspaceFor: (ref) => wsByRef.get(ref) ?? '',
  }
}

function readFileSyncLog(): string[] {
  const content = readFileSync(SWEEP_AVEN_LOG, 'utf8')
  return content.split('\n')
}

function defaultRef(ref: string): RefFixture {
  return { ref, labels: DONE_LABELS }
}

test('sweep scenario 1: done+clean+merged removes worktree, declares with the ref, marks, annotates', async () => {
  await withFakeAven('', 'ok', async () => {
    const fx = makeSweepHarness({
      refs: [defaultRef('PMR-SW1')],
      mergeBaseOk: true,
    })
    await fx.run()
    const ref = 'PMR-SW1'
    const ws = fx.workspaceFor(ref)
    assert.ok(
      fx.herdrRemoves.includes(`worktree remove --workspace ${ws}`),
      'herdr worktree remove executed',
    )
    assert.equal(fx.declarations.length, 1)
    assert.equal(fx.declarations[0].ref, ref)
    assert.notEqual(fx.declarations[0].ref, 'worktree-ops')
    assert.equal(fx.declarations[0].effect, 'worktree-remove')
    assert.equal(
      fx.declarations[0].command,
      `herdr worktree remove --workspace ${ws}`,
    )
    assert.equal(fx.branchDeletes.length, 1, 'merged branch deleted')
    const markers = fx.markersFor(ref)
    assert.equal(markers.length, 1)
    assert.equal(markers[0].outcome, 'removed')
    assert.equal(fx.annotations.length, 1)
    assert.equal(fx.annotations[0].ref, ref)
    assert.match(fx.annotations[0].body, /worktree removed/)
  })
})

test('sweep scenario 2: done+dirty defers and a second run retries the cleanup', async () => {
  await withFakeAven('', 'ok', async () => {
    const fx = makeSweepHarness({
      refs: [defaultRef('PMR-SW2')],
      mergeBaseOk: true,
      dirtyPaths: [path.join(SWEEP_WT_ROOT, 'pmr-sw2')],
    })
    await fx.run()
    const ref = 'PMR-SW2'
    assert.equal(fx.herdrRemoves.length, 0, 'dirty worktree not removed')
    const markers = fx.markersFor(ref)
    assert.equal(markers.length, 1)
    assert.equal(markers[0].outcome, 'deferred')

    const statusCallsAfterFirstRun = fx.calls.filter(
      (c) => c.cwd === fx.wtPathFor(ref) && c.args === 'status --porcelain',
    ).length
    assert.equal(statusCallsAfterFirstRun, 1, 'first run attempted cleanup')
    await fx.run()
    const statusCallsAfterSecondRun = fx.calls.filter(
      (c) => c.cwd === fx.wtPathFor(ref) && c.args === 'status --porcelain',
    ).length
    assert.equal(
      statusCallsAfterSecondRun,
      statusCallsAfterFirstRun + 1,
      'deferred marker is non-terminal: second sweep re-attempts cleanup',
    )
    assert.equal(fx.markersFor(ref).length, 2)
  })
})

test('sweep scenario 3: done+unmerged keeps all, marker kept-all, no removal', async () => {
  await withFakeAven('', 'ok', async () => {
    const fx = makeSweepHarness({
      refs: [defaultRef('PMR-SW3')],
      mergeBaseOk: false,
    })
    await fx.run()
    const ref = 'PMR-SW3'
    assert.equal(fx.herdrRemoves.length, 0, 'worktree kept')
    assert.equal(fx.branchDeletes.length, 0, 'branch kept')
    const markers = fx.markersFor(ref)
    assert.equal(markers.length, 1)
    assert.equal(markers[0].outcome, 'kept-all')
    assert.equal(fx.annotations.length, 1)
    assert.match(fx.annotations[0].body, /worktree kept/)
  })
})

test('sweep scenario 4: not-done labels produce zero cleanup execs and zero markers', async () => {
  await withFakeAven('', 'ok', async () => {
    const fx = makeSweepHarness({
      refs: [{ ref: 'PMR-SW4', labels: ['planned', 'active'] }],
      mergeBaseOk: true,
    })
    await fx.run()
    const wtPath = fx.wtPathFor('PMR-SW4')
    const cleanupCalls = fx.calls.filter((c) => c.cwd === wtPath)
    assert.equal(
      cleanupCalls.length,
      0,
      'no git/agent probes against a mid-flight worktree',
    )
    assert.equal(fx.herdrRemoves.length, 0)
    assert.equal(fx.markersFor('PMR-SW4').length, 0, 'no marker')
    assert.equal(fx.annotations.length, 0)
  })
})

test('sweep scenario 5: foreign gitRoot skipped before aven', async () => {
  await withFakeAven('', 'ok', async () => {
    const fx = makeSweepHarness({
      refs: [
        { ref: 'PMR-SW5', labels: DONE_LABELS, gitRoot: '/some-other-repo' },
      ],
      mergeBaseOk: true,
    })
    await fx.run()
    assert.deepEqual(fx.avenRefs(), [], 'no aven exec for foreign gitRoot')
    assert.equal(fx.herdrRemoves.length, 0)
    assert.equal(fx.markersFor('PMR-SW5').length, 0)
  })
})

test('sweep scenario 6: terminal marker skips aven entirely on later runs', async () => {
  await withFakeAven('', 'ok', async () => {
    const fx = makeSweepHarness({
      refs: [
        {
          ref: 'PMR-SW6',
          labels: DONE_LABELS,
          seedEvents: [
            {
              kind: 'worktree-sweep',
              at: 't2',
              ref: 'PMR-SW6',
              source: 'sweep',
              outcome: 'removed',
              detail: 'earlier sweep',
            },
          ],
        },
      ],
      mergeBaseOk: true,
    })
    await fx.run()
    await fx.run()
    assert.deepEqual(fx.avenRefs(), [], 'terminal marker: zero aven execs')
    assert.equal(fx.herdrRemoves.length, 0)
    // markersFor includes the seeded terminal marker; assert nothing was
    // APPENDED by either run.
    const appendedForRef = fx.appendedEvents.filter(
      (e) => e.ref === 'PMR-SW6' && e.kind === 'worktree-sweep',
    )
    assert.equal(appendedForRef.length, 0, 'no new marker appended')
  })
})

test('sweep scenario 7: empty herdr list yields zero aven execs', async () => {
  await withFakeAven('', 'ok', async () => {
    const fx = makeSweepHarness({
      refs: [defaultRef('PMR-SW7')],
      emptyHerdr: true,
      mergeBaseOk: true,
    })
    await fx.run()
    assert.deepEqual(fx.avenRefs(), [], 'empty herdr list: zero aven execs')
    assert.equal(fx.herdrRemoves.length, 0)
    assert.equal(fx.markersFor('PMR-SW7').length, 0)
  })
})

test('sweep scenario 8: readLabels null skips the ref without a marker', async () => {
  await withFakeAven('', 'ok', async () => {
    const fx = makeSweepHarness({
      refs: [{ ref: 'PMR-SW8', labels: null }],
      mergeBaseOk: true,
    })
    await fx.run()
    assert.equal(fx.herdrRemoves.length, 0)
    assert.equal(
      fx.markersFor('PMR-SW8').length,
      0,
      'label failure leaves no marker',
    )
    assert.equal(fx.annotations.length, 0)
  })
})

test('sweep scenario 9: appendEvent failure does not throw out of the sweep', async () => {
  await withFakeAven('', 'ok', async () => {
    const fx = makeSweepHarness({
      refs: [defaultRef('PMR-SW9')],
      mergeBaseOk: true,
      failAppend: true,
    })
    // Must resolve, not reject — the sweep is never-throw by contract.
    await fx.run()
    assert.equal(fx.appendedEvents.length, 0)
    assert.equal(fx.markersFor('PMR-SW9').length, 0)
  })
})

test('sweep scenario 10: deterministic ref order; mid-flight ref with a bound note untouched', async () => {
  await withFakeAven('', 'ok', async () => {
    const midLabels = ['planned', 'active', 'review-passed']
    const fx = makeSweepHarness({
      refs: [
        { ref: 'PMR-SWZ', labels: midLabels },
        { ref: 'PMR-SWA', labels: DONE_LABELS },
      ],
      mergeBaseOk: true,
    })
    // Harness listRefs sorts, so processing order is deterministic.
    // The mid-flight ref fails the labels-done gate BEFORE aven, so only
    // the done ref ever reaches aven show.
    await fx.run()
    assert.deepEqual(fx.avenRefs(), ['PMR-SWA'])

    const doneRef = 'PMR-SWA'
    const ws = fx.workspaceFor(doneRef)
    assert.ok(
      fx.herdrRemoves.includes(`worktree remove --workspace ${ws}`),
      'done ref cleaned up',
    )
    assert.equal(fx.markersFor(doneRef).length, 1)

    const midRef = 'PMR-SWZ'
    const midWtPath = fx.wtPathFor(midRef)
    const midCleanup = fx.calls.filter((c) => c.cwd === midWtPath)
    assert.equal(midCleanup.length, 0, 'mid-flight ref untouched')
    assert.equal(fx.markersFor(midRef).length, 0, 'mid-flight ref no marker')
    assert.equal(
      fx.annotations.filter((a) => a.ref === midRef).length,
      0,
      'mid-flight ref not annotated',
    )
  })
})

// --- resolveDoneWorktree (PMR-YG2N 3.1) ---
// Uses the SWEEP_BIN_DIR aven fake + show fixtures: a note whose path does
// not exist resolves as 'gone' (unbound); a missing fixture makes aven fail
// (unverifiable). The attached-binding case uses the worktree-context
// globals with unique refs so the process-global state stays isolated.

const DONE_RESOLVE_PI = {} as unknown as ExtensionAPI

function writeDoneShowFixture(ref: string, body: string): void {
  writeFileSync(path.join(SWEEP_SHOW_DIR, `${ref}.txt`), body)
}

async function withDonePath(fn: () => Promise<void>): Promise<void> {
  const previousPath = process.env.PATH ?? ''
  process.env.PATH = `${SWEEP_BIN_DIR}:${previousPath}`
  setAvenSessionCwd(SWEEP_MAIN_CWD)
  try {
    await fn()
  } finally {
    process.env.PATH = previousPath
    setActiveFlowRef(null)
    clearFlowWorktree()
  }
}

test('resolveDoneWorktree: attached binding with matching ref wins, aven untouched', async () => {
  await withDonePath(async () => {
    const ref = 'PMR-RDW1'
    setActiveFlowRef(ref)
    assert.equal(
      setFlowWorktree('/tmp/rdw1-wt', 'feat/rdw1'),
      true,
      'binding applied',
    )
    const resolved = await resolveDoneWorktree(
      DONE_RESOLVE_PI,
      SWEEP_MAIN_CWD,
      ref,
    )
    assert.deepEqual(resolved, {
      ref,
      path: '/tmp/rdw1-wt',
      branch: 'feat/rdw1',
    })
  })
})

test('resolveDoneWorktree: non-matching attached binding falls through to the note (gone => undefined)', async () => {
  await withDonePath(async () => {
    const ref = 'PMR-RDW2'
    setActiveFlowRef('PMR-OTHER')
    setFlowWorktree('/tmp/other-wt', 'feat/other')
    writeDoneShowFixture(
      ref,
      'note id=w2 at=t ref=PMR-RDW2\nbody<<EOF\nworktree: /nonexistent-rdw2 branch: feat/rdw2\nEOF\n',
    )
    const resolved = await resolveDoneWorktree(
      DONE_RESOLVE_PI,
      SWEEP_MAIN_CWD,
      ref,
    )
    assert.equal(resolved, undefined)
  })
})

test('resolveDoneWorktree: aven failure (no fixture) never throws, returns undefined', async () => {
  await withDonePath(async () => {
    const resolved = await resolveDoneWorktree(
      DONE_RESOLVE_PI,
      SWEEP_MAIN_CWD,
      'PMR-RDW3-NO-FIXTURE',
    )
    assert.equal(resolved, undefined)
  })
})

process.on('exit', () => {
  try {
    rmSync(SWEEP_BIN_DIR, { recursive: true, force: true })
    rmSync(SWEEP_WT_ROOT, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})
