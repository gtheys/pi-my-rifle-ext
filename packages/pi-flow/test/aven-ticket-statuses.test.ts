import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AvenRunner,
  classifyTicketStatuses,
  listTicketStatuses,
  ticketStatusOf,
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

// AIDEV-NOTE (PMR-MSDJ fix round, P2-2): the BOTH-empty expectation flipped.
// `classifyTicketStatuses('[]')` keeps returning an empty Map (the PARSER
// contract, pinned by its own test above), but an empty MERGED universe is an
// anomaly: a host holding ~900 tickets that answers `[]` for every workspace
// is aven failing, not a real zero-ticket answer, and reading it as a real
// answer tombstones EVERY halted/paused run in one pass.
test('both workspaces empty is an anomaly, not a real answer (null)', async () => {
  const { aven } = workspaceRunner({ projects: '[]', salaryhero: '[]' })
  assert.equal(await listTicketStatuses(aven), null)
})

test('one empty workspace with the other populated is a real answer', async () => {
  const { aven } = workspaceRunner({
    projects: '[]',
    salaryhero: `[${ticket('SCR-VQDA', 'active')}]`,
  })
  assert.deepEqual(
    await listTicketStatuses(aven),
    new Map([['SCR-VQDA', 'active']]),
  )
})

// ---------------------------------------------------------------------------
// ticketStatusOf — the bounded single-ref confirmation (PMR-MSDJ fix round,
// P2-1). A ref MISSING from the merged listing is not tombstoned on that
// evidence alone: `aven show <ref> --json` gets to VETO the tombstone (a live
// ticket) or confirm it (aven's own unknown-ref), and anything else fails
// closed to null so the engine skips the ref. The probe is workspace-EXPLICIT
// like the listing, because an un-pinned `show` is cwd-route dependent and was
// measured against the real CLI to answer `unknown-ref` for LIVE tickets from
// an unrouted cwd — a single un-pinned shell-out would therefore be a silent
// no-op here. Order: the two pinned workspaces, then aven's own cwd-inferred
// resolution (the only universe that can see an `avenWorkspace` override).
// ---------------------------------------------------------------------------

/** The exec rejection shape promisify(execFile) produces for aven's exit 1. */
function avenExit1(stderr: string): Error {
  const error = new Error(`Command failed: aven show\n${stderr}`)
  return Object.assign(error, { stderr, stdout: '' })
}

/** aven's "no such ticket" answer, which arrives as a rejection (exit 1). */
const UNKNOWN_REF_EXIT1 = avenExit1('Error: error unknown-ref input=PMR-GONE\n')

/**
 * Probe runner keyed by UNIVERSE: the `--workspace` value, or `'cwd'` for the
 * un-pinned call. An unkeyed universe answers aven's exit-1 unknown-ref (the
 * real shape of "no such ticket here"), so a test scripts only what differs.
 */
function probeRunner(answers: Record<string, string | Error> = {}): {
  aven: AvenRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const aven: AvenRunner = async (args) => {
    calls.push([...args])
    const at = args.indexOf('--workspace')
    const universe = at < 0 ? 'cwd' : args[at + 1]
    const next = answers[universe] ?? UNKNOWN_REF_EXIT1
    if (next instanceof Error) throw next
    return { stdout: next, stderr: '' }
  }
  return { aven, calls }
}

const SHOW_PROJECTS = ['show', 'PMR-62EN', '--json', '--workspace', 'projects']
const SHOW_SALARYHERO = [
  'show',
  'PMR-62EN',
  '--json',
  '--workspace',
  'salaryhero',
]
const SHOW_CWD = ['show', 'PMR-62EN', '--json']

test('ticketStatusOf short-circuits on the first universe that knows the ref', async () => {
  const { aven, calls } = probeRunner({
    projects: '{"ref":"PMR-62EN","status":"active"}',
  })
  assert.deepEqual(await ticketStatusOf('PMR-62EN', aven), {
    kind: 'ticket',
    status: 'active',
  })
  assert.deepEqual(calls, [SHOW_PROJECTS])
})

test("ticketStatusOf consults the pinned workspaces THEN aven's own routing", async () => {
  // The override case: the ticket is in neither pinned workspace but IS
  // reachable through aven's cwd-inferred resolution.
  const { aven, calls } = probeRunner({
    cwd: '{"ref":"PMR-62EN","status":"todo"}',
  })
  assert.deepEqual(await ticketStatusOf('PMR-62EN', aven), {
    kind: 'ticket',
    status: 'todo',
  })
  assert.deepEqual(calls, [SHOW_PROJECTS, SHOW_SALARYHERO, SHOW_CWD])
})

test('ticketStatusOf reads unknown-ref in EVERY universe as genuinely missing', async () => {
  const { aven, calls } = probeRunner()
  assert.deepEqual(await ticketStatusOf('PMR-62EN', aven), { kind: 'missing' })
  assert.equal(calls.length, 3)
})

test('ticketStatusOf reads a non-live status verbatim (the engine decides)', async () => {
  const { aven } = probeRunner({
    salaryhero: '{"ref":"PMR-62EN","status":"backlog"}',
  })
  assert.deepEqual(await ticketStatusOf('PMR-62EN', aven), {
    kind: 'ticket',
    status: 'backlog',
  })
})

test('ticketStatusOf reads exit-0 unknown-ref text as missing too (ISC-13)', async () => {
  // aven prints domain errors WITH exit 0, so the marker wins over the exit
  // code on the resolve path as well.
  const { aven } = probeRunner({
    projects: 'Error: error unknown-ref input=PMR-GONE\n',
  })
  assert.deepEqual(await ticketStatusOf('PMR-GONE', aven), { kind: 'missing' })
})

test('ticketStatusOf fails closed to null when ANY universe is anomalous', async () => {
  // A half-verified universe is not evidence of absence: `missing` costs a
  // tombstone, so one broken shell-out must outrank two unknown-refs.
  const spawn = probeRunner({ salaryhero: new Error('spawn aven ENOENT') })
  assert.equal(await ticketStatusOf('PMR-1', spawn.aven), null)

  const timeout = probeRunner({
    cwd: new Error('kill ETLAVETIMEDOUT after 5000ms'),
  })
  assert.equal(await ticketStatusOf('PMR-1', timeout.aven), null)

  const badJson = probeRunner({ projects: '{not json' })
  assert.equal(await ticketStatusOf('PMR-1', badJson.aven), null)

  const noStatus = probeRunner({ projects: '{"ref":"PMR-1"}' })
  assert.equal(await ticketStatusOf('PMR-1', noStatus.aven), null)

  const otherError = probeRunner({
    projects: avenExit1('Error: database is locked\n'),
  })
  assert.equal(await ticketStatusOf('PMR-1', otherError.aven), null)
})

test('ticketStatusOf never trusts a prefix-matched ref (PMR-F8HB)', async () => {
  // `aven show PMR-TPN` happily returns PMR-TPN7. Another ticket's status is
  // not an answer about this one — not `ticket` (wrong evidence) and not
  // `missing` (would tombstone), so it is inconclusive.
  const fuzzy = probeRunner({ projects: '{"ref":"PMR-TPN7","status":"done"}' })
  assert.equal(await ticketStatusOf('PMR-TPN', fuzzy.aven), null)

  // The same ref in another letter case IS the same ticket.
  const cased = probeRunner({ projects: '{"ref":"pmr-62en","status":"todo"}' })
  assert.deepEqual(await ticketStatusOf('PMR-62EN', cased.aven), {
    kind: 'ticket',
    status: 'todo',
  })
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
