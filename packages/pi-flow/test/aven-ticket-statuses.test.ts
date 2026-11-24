import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AvenRunner,
  classifyTicketStatuses,
  listTicketStatuses,
} from '../aven/status.ts'

// PMR-MSDJ 1.4: `aven/status.ts` — the daemon-safe aven ticket status map for
// the liveness reconcile (plan PMR-V36Y decision 2: a halted/paused run is
// LIVE only while its ticket status is `active`). Fail-closed discipline is
// the same as classifyOpenTicketRefs (ISC-13, PMR-384R): aven exits 0 on its
// own errors, so classification is by TEXT, never by exit code, and ANY
// anomaly returns null (never a partial map — a partial map would let the
// reconcile tombstone a live run whose entry got dropped). [] / an empty Map
// is reserved for a successfully parsed empty array (a real zero answer).
//
// Pinned against the REAL CLI (aven 0.1.54, captured 2026-11-24): the fields
// are `ref` and `status`, statuses are inbox/backlog/todo/active/done/canceled,
// and closed tickets DO appear. The listing is also WORKSPACE-ROUTE DEPENDENT
// (`--all-projects` notwithstanding), so listTicketStatuses pins
// `--workspace projects` and `--workspace salaryhero` and merges both — the
// tests below assert that argv and the all-or-nothing merge.

/** Fixture shaped like the real CLI output (real field names). */
function ticket(ref: string, status: string): string {
  return JSON.stringify({
    ref,
    id: `ID-${ref}`,
    title: `ticket ${ref}`,
    project: 'pi-my-rifle-ext',
    status,
    priority: 'none',
    labels: ['impl'],
    deleted: false,
    is_epic: false,
  })
}

// --- classifyTicketStatuses ---

test('valid array with mixed statuses maps ref → status', () => {
  const stdout = `[${[
    ticket('PMR-MSDJ', 'todo'),
    ticket('PMR-62EN', 'active'),
    ticket('PMR-05MQ', 'done'),
    ticket('ADM-3HHH', 'canceled'),
  ].join(',')}]`
  assert.deepEqual(
    classifyTicketStatuses(stdout, ''),
    new Map([
      ['PMR-MSDJ', 'todo'],
      ['PMR-62EN', 'active'],
      ['PMR-05MQ', 'done'],
      ['ADM-3HHH', 'canceled'],
    ]),
  )
})

test('empty array is a real zero-ticket answer (empty Map, not null)', () => {
  assert.deepEqual(classifyTicketStatuses('[]', ''), new Map())
})

test('aven error text on stdout classifies as null (exit-0 failure)', () => {
  assert.equal(classifyTicketStatuses('Error: boom\n[]', ''), null)
  assert.equal(classifyTicketStatuses('error something went wrong', ''), null)
})

test('aven error text on stderr classifies as null', () => {
  assert.equal(classifyTicketStatuses('[]', 'error: aven unavailable'), null)
  assert.equal(
    classifyTicketStatuses('[]', 'Error: cannot open database'),
    null,
  )
})

test('indented stderr error line classifies as null (PMR-NPFR lesson)', () => {
  // avenErrorText's pattern needs `Error:` or `error ` (space); a lowercase
  // `error:` prefix is only caught by the classify-level /^error\b/ check,
  // which must trim first or an indented line evades both.
  assert.equal(classifyTicketStatuses('[]', '  error: indented boom'), null)
  assert.equal(classifyTicketStatuses('[]', '\terror: tabbed boom'), null)
  // A line that merely indents other text is not an error.
  assert.deepEqual(classifyTicketStatuses('[]', '  warning: fine'), new Map())
})

test('non-JSON stdout classifies as null, not an empty Map', () => {
  assert.equal(classifyTicketStatuses('{not json', ''), null)
})

test('non-array JSON (schema drift) classifies as null', () => {
  assert.equal(classifyTicketStatuses('{"tickets":[]}', ''), null)
})

test('entry missing status classifies as null (partial map is unsafe)', () => {
  const stdout = `[${ticket('PMR-62EN', 'active')},{"ref":"PMR-X","id":"1"}]`
  assert.equal(classifyTicketStatuses(stdout, ''), null)
})

test('entry missing ref classifies as null (partial map is unsafe)', () => {
  const stdout = `[${ticket('PMR-62EN', 'active')},{"status":"done"}]`
  assert.equal(classifyTicketStatuses(stdout, ''), null)
})

test('non-object entry and wrong field types classify as null', () => {
  assert.equal(classifyTicketStatuses('[ "PMR-62EN" ]', ''), null)
  assert.equal(
    classifyTicketStatuses('[{"ref":123,"status":"active"}]', ''),
    null,
  )
  assert.equal(classifyTicketStatuses('[{"ref":"PMR-1","status":7}]', ''), null)
  assert.equal(
    classifyTicketStatuses('[{"ref":"","status":"active"}]', ''),
    null,
  )
  assert.equal(
    classifyTicketStatuses('[{"ref":"PMR-1","status":""}]', ''),
    null,
  )
})

// --- listTicketStatuses (two workspace-pinned shell-outs, merged) ---

/** Runner that answers per workspace from a { projects, salaryhero } map. */
function workspaceRunner(response: Record<string, string | Error>): {
  aven: AvenRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const aven: AvenRunner = async (args) => {
    calls.push([...args])
    const workspace = args[args.indexOf('--workspace') + 1]
    const next = response[workspace]
    if (next instanceof Error) throw next
    if (next === undefined) throw new Error(`unexpected workspace ${workspace}`)
    return { stdout: next, stderr: '' }
  }
  return { aven, calls }
}

const PROJECTS_ARGV = [
  'list',
  '--all-projects',
  '--workspace',
  'projects',
  '--json',
]
const SALARYHERO_ARGV = [
  'list',
  '--all-projects',
  '--workspace',
  'salaryhero',
  '--json',
]

test('listTicketStatuses pins BOTH workspaces, exactly one call each', async () => {
  const { aven, calls } = workspaceRunner({
    projects: `[${ticket('PMR-62EN', 'active')}]`,
    salaryhero: `[${ticket('SCR-VQDA', 'active')}]`,
  })
  await listTicketStatuses(aven)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], PROJECTS_ARGV)
  assert.deepEqual(calls[1], SALARYHERO_ARGV)
})

test('listTicketStatuses merges both workspaces into one map', async () => {
  const { aven } = workspaceRunner({
    projects: `[${[ticket('PMR-MSDJ', 'todo'), ticket('PMR-62EN', 'active')].join(',')}]`,
    salaryhero: `[${[ticket('SCR-VQDA', 'active'), ticket('DP-71A', 'done')].join(',')}]`,
  })
  assert.deepEqual(
    await listTicketStatuses(aven),
    new Map([
      ['PMR-MSDJ', 'todo'],
      ['PMR-62EN', 'active'],
      ['SCR-VQDA', 'active'],
      ['DP-71A', 'done'],
    ]),
  )
})

test('a ref collision resolves to the LAST workspace (salaryhero, work mode)', async () => {
  const { aven } = workspaceRunner({
    projects: `[${ticket('SH-1AA', 'active')}]`,
    salaryhero: `[${ticket('SH-1AA', 'done')}]`,
  })
  assert.deepEqual(
    await listTicketStatuses(aven),
    new Map([['SH-1AA', 'done']]),
  )
})

test('either workspace empty still merges (an empty workspace is a real answer)', async () => {
  const { aven } = workspaceRunner({ projects: '[]', salaryhero: '[]' })
  assert.deepEqual(await listTicketStatuses(aven), new Map())
})

test('an anomaly in EITHER workspace nulls the WHOLE map (never partial)', async () => {
  const badProjects = workspaceRunner({
    projects: 'Error: boom\n[]',
    salaryhero: `[${ticket('SCR-VQDA', 'active')}]`,
  })
  assert.equal(await listTicketStatuses(badProjects.aven), null)

  const badSalaryhero = workspaceRunner({
    projects: `[${ticket('PMR-62EN', 'active')}]`,
    salaryhero: '{not json',
  })
  assert.equal(await listTicketStatuses(badSalaryhero.aven), null)

  // Schema drift in the second listing must not smuggle the first one in.
  const drift = workspaceRunner({
    projects: `[${ticket('PMR-62EN', 'active')}]`,
    salaryhero: '{"tickets":[]}',
  })
  assert.equal(await listTicketStatuses(drift.aven), null)
})

test('listTicketStatuses returns null when aven fails to spawn or times out', async () => {
  // First workspace fine, second killed — a half universe is not mergeable.
  const second = workspaceRunner({
    projects: `[${ticket('PMR-62EN', 'active')}]`,
    salaryhero: new Error('aven killed by timeout after 5000ms'),
  })
  assert.equal(await listTicketStatuses(second.aven), null)

  const spawn = workspaceRunner({
    projects: new Error('spawn aven ENOENT'),
    salaryhero: '[]',
  })
  assert.equal(await listTicketStatuses(spawn.aven), null)
})

test('listTicketStatuses stays compatible with ReconcileDeps (zero-param wiring)', async () => {
  // flow/reconcile.ts declares `listTicketStatuses(): Promise<Map<…> | null>`
  // with NO params, and the daemon/2.2 wires the function straight in. The
  // optional runner param must not break that assignment — tsc checks this
  // line (the runtime assert only proves the wiring is callable).
  const wired: {
    listTicketStatuses(): Promise<Map<string, string> | null>
  } = { listTicketStatuses }
  assert.equal(typeof wired.listTicketStatuses, 'function')
})
