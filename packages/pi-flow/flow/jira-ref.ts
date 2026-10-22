// AIDEV-NOTE: Jira-ID → local-epic resolution for /flow and the phase
// commands (option B). The feature-plan-aven skill plans on a LOCAL epic
// carrying jira-ref=<JIRA-ID> metadata, dep-linked to the synced ticket —
// but /flow needs a real aven ref BEFORE the plan phase runs (labels are the
// run state), so the extension resolves or creates the epic itself. The
// shared contract with the skill is exactly two things: the jira-ref
// metadata key and the dep-link. aven prints errors (unknown-metadata-field,
// unknown-ref) with exit 0, so detection is by output text, not exit code.

export type AvenRunner = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>

export type EpicLookup =
  | { kind: 'found'; ref: string }
  | { kind: 'none' }
  | { kind: 'error'; reason: string }

export type JiraEpicResolution =
  | { kind: 'epic'; ref: string; created: boolean }
  | { kind: 'abort'; reason: string }

interface AvenEntry {
  ref: string
  title: string
  isEpic: boolean
}

// AIDEV-NOTE: aven prints errors (unknown-metadata-field, unknown-ref) with
// exit 0, so detection is by output text. unknown-metadata-field = the
// workspace never registered the field (nothing pulled in yet) -> same as an
// empty list, NOT an aven failure. Fail-closed on everything else.
async function listByMetadata(
  aven: AvenRunner,
  key: string,
  value: string,
): Promise<
  | { kind: 'none' }
  | { kind: 'entries'; entries: AvenEntry[] }
  | { kind: 'error'; reason: string }
> {
  let stdout: string
  try {
    const out = await aven(['list', '--metadata', `${key}=${value}`, '--json'])
    stdout = out.stdout
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { kind: 'error', reason: `aven list failed: ${msg}` }
  }
  if (/unknown-metadata-field/.test(stdout)) return { kind: 'none' }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {
      kind: 'error',
      reason: `aven list returned bad JSON: ${stdout.slice(0, 120)}`,
    }
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'error', reason: 'aven list JSON was not an array' }
  }
  const entries: AvenEntry[] = parsed.flatMap((e) => {
    if (typeof e !== 'object' || e === null) return []
    const ref = (e as { ref?: unknown }).ref
    if (typeof ref !== 'string') return []
    const rawTitle = (e as { title?: unknown }).title
    return [
      {
        ref,
        title: typeof rawTitle === 'string' ? rawTitle : value,
        isEpic: (e as { is_epic?: unknown }).is_epic === true,
      },
    ]
  })
  return { kind: 'entries', entries }
}

export async function findJiraEpic(
  jiraId: string,
  aven: AvenRunner,
): Promise<EpicLookup> {
  const result = await listByMetadata(aven, 'jira-ref', jiraId)
  if (result.kind === 'none') return { kind: 'none' }
  if (result.kind === 'error') return result
  const refs = result.entries.map((e) => e.ref)
  if (refs.length === 0) return { kind: 'none' }
  if (refs.length > 1) {
    return {
      kind: 'error',
      reason: `multiple local epics for ${jiraId} (${refs.join(', ')}) — pass the epic ref explicitly`,
    }
  }
  return { kind: 'found', ref: refs[0] as string }
}

export type TicketResearchTarget =
  | { kind: 'epic'; ref: string }
  | { kind: 'synced'; ref: string }
  | { kind: 'none' }
  | { kind: 'error'; reason: string }

// AIDEV-NOTE: Research-time ticket resolution, strictest source first: the
// local epic (jira-ref) — labels land there and /flow resumes clean; else
// the synced ticket (jira-key) — full Jira content is already in aven, no
// acli needed; else acli fallback. Default `aven list` is workspace-scoped
// (reaches all projects of the routed workspace), verified 2026-02-09:
// a jira-key hit for a dp-project ticket from a flexben cwd.
export async function findTicketResearchTarget(
  jiraId: string,
  aven: AvenRunner,
): Promise<TicketResearchTarget> {
  const epic = await findJiraEpic(jiraId, aven)
  if (epic.kind === 'error') return epic
  if (epic.kind === 'found') return { kind: 'epic', ref: epic.ref }
  const synced = await findSyncedTicket(jiraId, aven)
  if (synced !== null && 'kind' in synced) return synced
  if (synced === null) return { kind: 'none' }
  return { kind: 'synced', ref: synced.ref }
}

interface SyncedTicket {
  ref: string
  title: string
}

async function findSyncedTicket(
  jiraId: string,
  aven: AvenRunner,
): Promise<SyncedTicket | null | { kind: 'error'; reason: string }> {
  const result = await listByMetadata(aven, 'jira-key', jiraId)
  if (result.kind === 'none') return null
  if (result.kind === 'error') return result
  const ticket = result.entries.find((e) => !e.isEpic)
  if (ticket === undefined) return null
  return { ref: ticket.ref, title: ticket.title }
}

export async function resolveJiraEpic(
  jiraId: string,
  aven: AvenRunner,
): Promise<JiraEpicResolution> {
  const existing = await findJiraEpic(jiraId, aven)
  if (existing.kind === 'found') {
    return { kind: 'epic', ref: existing.ref, created: false }
  }
  if (existing.kind === 'error') {
    return { kind: 'abort', reason: existing.reason }
  }
  const synced = await findSyncedTicket(jiraId, aven)
  if (synced !== null && 'kind' in synced) {
    return { kind: 'abort', reason: synced.reason }
  }
  if (synced === null) {
    return {
      kind: 'abort',
      reason: `${jiraId} is not aven-managed — sync the ticket first, or plan it in Jira directly`,
    }
  }
  let addStdout: string
  try {
    const out = await aven([
      'add',
      `${jiraId} — ${synced.title}`,
      '--epic',
      '--status',
      'todo',
      '--metadata',
      `jira-ref=${jiraId}`,
      '--description',
      `Jira ${jiraId} — source of truth: synced ticket ${synced.ref}.`,
    ])
    addStdout = out.stdout
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return { kind: 'abort', reason: `aven add failed: ${msg}` }
  }
  const created = /created (\S+)/.exec(addStdout)
  if (created === null) {
    return {
      kind: 'abort',
      reason: `aven add did not report a ref: ${addStdout.slice(0, 120)}`,
    }
  }
  const epicRef = created[1] as string
  try {
    await aven(['dep', 'add', epicRef, synced.ref])
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      kind: 'abort',
      reason: `epic ${epicRef} was created but the dep-link to ${synced.ref} failed (${msg}) — re-run /flow; the epic will be found and reused`,
    }
  }
  return { kind: 'epic', ref: epicRef, created: true }
}
