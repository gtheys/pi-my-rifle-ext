import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'
import type { AutocompleteItem } from '@earendil-works/pi-tui'
import { Text } from '@earendil-works/pi-tui'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

// AIDEV-NOTE: TypeBox schema is the source of truth for config shape.
// config.schema.json (checked in) is regenerated from this at startup if
// missing. Global path: getAgentDir()/pi-teams-transcript/config.json.
// Project override: <cwd>/CONFIG_DIR_NAME/pi-teams-transcript/config.json.
const TeamsTranscriptConfigSchema = Type.Object({
  outDir: Type.Optional(
    Type.String({
      description:
        'Directory to write downloaded transcripts to. Relative paths resolve from cwd.',
    }),
  ),
  userId: Type.Optional(
    Type.String({
      description:
        "Default meeting organizer's user ID or UPN, used when a tool/command call omits userId.",
    }),
  ),
  timezone: Type.Optional(
    Type.String({
      description:
        "IANA timezone (e.g. 'Asia/Bangkok') used for day boundaries (today/yesterday) and displayed meeting times in the sync report. Defaults to the system timezone.",
    }),
  ),
})

const GLOBAL_CONFIG_PATH = path.join(
  getAgentDir(),
  'pi-teams-transcript',
  'config.json',
)

function projectConfigPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, 'pi-teams-transcript', 'config.json')
}

async function readConfigFile(
  file: string,
): Promise<{ outDir?: string; userId?: string; timezone?: string }> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Value.Check(TeamsTranscriptConfigSchema, parsed)) return {}
    return parsed
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read pi-teams-transcript config ${file}: ${msg}`)
  }
}

// AIDEV-NOTE: precedence is explicit CLI arg > project config > global config
// > cwd-based default (resolveTranscriptsDir's existing fallback).
async function resolveConfiguredOutDir(
  cwd: string,
): Promise<string | undefined> {
  const global = await readConfigFile(GLOBAL_CONFIG_PATH)
  const project = await readConfigFile(projectConfigPath(cwd))
  return project.outDir || global.outDir
}

// AIDEV-NOTE: precedence is explicit CLI arg > TEAMS_USER_ID env var >
// project config > global config.
async function resolveConfiguredUserId(
  cwd: string,
): Promise<string | undefined> {
  const global = await readConfigFile(GLOBAL_CONFIG_PATH)
  const project = await readConfigFile(projectConfigPath(cwd))
  return process.env.TEAMS_USER_ID || project.userId || global.userId
}

// AIDEV-NOTE: precedence is project config > global config > system
// timezone (Intl.DateTimeFormat().resolvedOptions().timeZone). Used for
// both day-boundary math (today/yesterday) and displayed meeting times, so
// a user not physically in the system's timezone still sees/gets "today"
// meaning their own local day.
async function resolveConfiguredTimezone(cwd: string): Promise<string> {
  const global = await readConfigFile(GLOBAL_CONFIG_PATH)
  const project = await readConfigFile(projectConfigPath(cwd))
  return (
    project.timezone ||
    global.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone
  )
}

// AIDEV-NOTE: app-only (client_credentials) Graph auth. Requires the app registration
// to have OnlineMeetingTranscript.Read.All + OnlineMeetings.Read.All application
// permissions with admin consent granted (see MS Graph calltranscript docs).
let cachedToken: { token: string; expiresAt: number } | undefined

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Set TEAMS_TENANT_ID, TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET for app-only Graph auth.`,
    )
  }
  return value
}

async function getAccessToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.token
  }
  const tenantId = requireEnv('TEAMS_TENANT_ID')
  const clientId = requireEnv('TEAMS_CLIENT_ID')
  const clientSecret = requireEnv('TEAMS_CLIENT_SECRET')

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  )
  const body = await res.json()
  if (!res.ok) {
    throw new Error(
      `Graph token request failed (${res.status}): ${body.error_description || body.error || JSON.stringify(body)}`,
    )
  }
  cachedToken = {
    token: body.access_token,
    expiresAt: now + Number(body.expires_in || 3600) * 1000,
  }
  return cachedToken.token
}

async function graphFetch(url: string, accept?: string): Promise<Response> {
  const token = await getAccessToken()
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (accept) headers.Accept = accept
  const res = await fetch(url, { headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `Graph API ${res.status} for ${url}: ${text.slice(0, 1000)}`,
    )
  }
  return res
}

async function listRecentMeetings(userId: string, top: number) {
  // AIDEV-NOTE: /events?$orderby=start desc only returns each recurring
  // series' master (its *original* start), not per-day occurrences — misses
  // daily/weekly standups entirely or hits them at the wrong date. Use
  // /calendarView over a lookback window instead: it expands recurrence into
  // real occurrences, same as Outlook's own calendar view. All-day events
  // never have onlineMeeting.joinUrl so the existing filter already excludes
  // them; isAllDay is fetched too for safety.
  const now = new Date()
  const lookbackDays = 60
  const start = new Date(now.getTime() - lookbackDays * 86_400_000)
  const res = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/calendarView?startDateTime=${start.toISOString()}&endDateTime=${now.toISOString()}&$orderby=start/dateTime desc&$top=${Math.max(top * 5, 50)}&$select=subject,start,end,isAllDay,onlineMeeting`,
  )
  const data = (await res.json()) as {
    value?: Array<{
      subject?: string
      start?: { dateTime?: string }
      isAllDay?: boolean
      onlineMeeting?: { joinUrl?: string }
    }>
  }
  return (data.value || [])
    .filter((e) => !e.isAllDay && e.onlineMeeting?.joinUrl)
    .slice(0, top)
    .map((e) => ({
      subject: e.subject,
      start: e.start?.dateTime,
      joinUrl: e.onlineMeeting?.joinUrl,
    }))
}

export type SyncDay = 'today' | 'yesterday'

// AIDEV-NOTE: no Intl.DateTimeFormat 'today' shortcut works across an
// arbitrary IANA timezone — have to compute the UTC instant of local
// midnight ourselves. tzOffsetMinutes(instant, tz) asks "what wall-clock
// time does this UTC instant show in tz", diffed against the instant
// itself, giving the zone's offset (e.g. +420 for Asia/Bangkok). One pass
// is enough here (day boundaries, not a DST-transition instant).
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value)
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return (asUTC - instant.getTime()) / 60_000
}

// AIDEV-NOTE: calendarView expands recurring series into real occurrences,
// so a daily/weekly standup only shows up on the day it actually falls on
// in the configured timezone. All-day events are skipped (no joinUrl).
function dayBounds(day: SyncDay, timeZone: string): { start: Date; end: Date } {
  const now = new Date()
  const dayOffset = day === 'yesterday' ? -1 : 0
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now) // 'YYYY-MM-DD' in the target timezone
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = new Date(Date.UTC(y, m - 1, d + dayOffset, 0, 0, 0))
  const offsetMin = tzOffsetMinutes(guess, timeZone)
  const start = new Date(guess.getTime() - offsetMin * 60_000)
  const end = new Date(start.getTime() + 86_400_000)
  return { start, end }
}

// AIDEV-NOTE: under app-only auth, /calendarView strips `onlineMeeting` off
// *expanded* recurring occurrences (confirmed via live testing) even though
// isOnlineMeeting stays true — a plain /events?$orderby scan of the same
// meeting does carry onlineMeeting.joinUrl, and so does a per-id /events/{id}
// fetch. So: use calendarView for correct day-bounded occurrences, then
// backfill joinUrl with a follow-up single-event fetch wherever it's missing.
async function backfillJoinUrl(
  userId: string,
  eventId: string,
): Promise<string | undefined> {
  const res = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/events/${encodeURIComponent(eventId)}?$select=onlineMeeting`,
  )
  const data = (await res.json()) as { onlineMeeting?: { joinUrl?: string } }
  return data.onlineMeeting?.joinUrl
}

async function listMeetingsForDay(
  userId: string,
  day: SyncDay,
  timeZone: string,
) {
  const { start, end } = dayBounds(day, timeZone)
  const res = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}&$orderby=start/dateTime asc&$top=100&$select=subject,start,end,isAllDay,isCancelled,isOnlineMeeting,onlineMeeting`,
  )
  const data = (await res.json()) as {
    value?: Array<{
      id?: string
      subject?: string
      start?: { dateTime?: string }
      isAllDay?: boolean
      isCancelled?: boolean
      isOnlineMeeting?: boolean
      onlineMeeting?: { joinUrl?: string }
    }>
  }
  const candidates = (data.value || []).filter(
    (e) => !e.isAllDay && e.isOnlineMeeting,
  )
  const results = []
  for (const e of candidates) {
    let joinUrl = e.onlineMeeting?.joinUrl
    if (!joinUrl && e.id) {
      joinUrl = await backfillJoinUrl(userId, e.id)
    }
    if (!joinUrl) continue
    results.push({
      subject: e.subject,
      start: e.start?.dateTime,
      isCancelled: Boolean(e.isCancelled),
      joinUrl,
    })
  }
  return results
}

// AIDEV-NOTE: /onlineMeetings (app-only) rejects UPNs — "userId in request URL
// is not a GUID". Resolve UPN -> AAD object id once and reuse for all
// onlineMeetings/transcripts calls.
const userIdCache = new Map<string, string>()
const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function resolveUserGuid(userId: string): Promise<string> {
  if (GUID_RE.test(userId)) return userId
  const cached = userIdCache.get(userId)
  if (cached) return cached
  const res = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}?$select=id`,
  )
  const data = (await res.json()) as { id?: string }
  if (!data.id)
    throw new Error(`Could not resolve AAD object id for user: ${userId}`)
  userIdCache.set(userId, data.id)
  return data.id
}

async function resolveMeetingId(userId: string, joinUrl: string) {
  const guid = await resolveUserGuid(userId)
  const res = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(guid)}/onlineMeetings?$filter=JoinWebUrl eq '${encodeURIComponent(joinUrl)}'`,
  )
  const data = await res.json()
  const meeting = (data.value || [])[0]
  if (!meeting)
    throw new Error(`No onlineMeeting found for joinUrl: ${joinUrl}`)
  return meeting.id as string
}

async function listTranscripts(userId: string, meetingId: string) {
  const guid = await resolveUserGuid(userId)
  const res = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(guid)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`,
  )
  return res.json()
}

async function getTranscriptContent(
  userId: string,
  meetingId: string,
  transcriptId: string,
  format: string,
) {
  const guid = await resolveUserGuid(userId)
  const res = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(guid)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=${encodeURIComponent(format)}`,
    format,
  )
  return res.text()
}

// AIDEV-NOTE: one aligned line per meeting instead of a markdown table —
// pipe tables wrap badly in a narrow terminal and the full meetingId (a
// long base64-ish blob) is pure noise here; truncate it, it's not
// actionable from this report anyway (sync already used it internally).
const STATUS_ICON: Record<string, string> = {
  downloaded: '\u2713',
  'already-synced': '\u2713',
  'no-transcript': '\u00b7',
  cancelled: '\u2298',
  error: '\u2717',
}

function formatReportLine(
  m: {
    subject: string
    start: string
    meetingId: string | null
    status: string
  },
  timeZone: string,
): string {
  // AIDEV-NOTE: Graph's start.dateTime is a wall-clock string with no 'Z'/
  // offset (e.g. "2026-07-20T03:00:00.0000000"), always UTC since we never
  // send a Prefer: outlook.timezone header. `new Date(...)` on a string like
  // that parses as *local system time*, not UTC — silently reinterpreting
  // the instant and making the timeZone option below a no-op whenever system
  // TZ happens to equal the configured one. Force UTC by appending 'Z'.
  const hasOffset = /[Zz]$|[+-]\d{2}:\d{2}$/.test(m.start)
  const time = new Date(hasOffset ? m.start : `${m.start}Z`).toLocaleTimeString(
    [],
    { timeZone, hour: '2-digit', minute: '2-digit' },
  )
  const icon = STATUS_ICON[m.status] || '?'
  const idShort = m.meetingId ? `${m.meetingId.slice(0, 12)}\u2026` : '-'
  return `${icon} ${time}  ${m.subject.padEnd(40)}  ${m.status.padEnd(14)} ${idShort}`
}

// AIDEV-NOTE: theme-colored variant of formatReportLine for the `sync` tool
// action's renderResult — same layout, colored by status so a scan reads at
// a glance (green=got it, dim=nothing there, yellow=cancelled, red=error),
// matching how built-in tools (read/write/etc) color their output.
const STATUS_THEME_COLOR: Record<
  string,
  'success' | 'error' | 'warning' | 'dim'
> = {
  downloaded: 'success',
  'already-synced': 'success',
  'no-transcript': 'dim',
  cancelled: 'warning',
  error: 'error',
}

function themedReportLine(
  m: {
    subject: string
    start: string
    meetingId: string | null
    status: string
  },
  theme: Theme,
  timeZone: string,
): string {
  const color = STATUS_THEME_COLOR[m.status] || 'dim'
  return theme.fg(color, formatReportLine(m, timeZone))
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'meeting'
  )
}

// AIDEV-NOTE: transcriptId is a long base64-ish blob that blows past
// filesystem name limits (ENAMETOOLONG) when embedded raw. Use a short,
// stable hash instead — same transcriptId always hashes the same, so the
// idempotency check (file exists on disk) still works across re-runs.
function shortId(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 12)
}

function extForFormat(format: string): string {
  if (format === 'text/plain') return 'txt'
  return 'vtt'
}

// AIDEV-NOTE: idempotent sync — filename encodes date+subject+transcriptId,
// so a re-run just skips files that already exist on disk. No manifest/DB.
async function syncTranscripts(opts: {
  userId: string
  outDir: string
  day: SyncDay
  timeZone: string
  format: string
  onProgress?: (line: string) => void
}): Promise<{
  scanned: number
  downloaded: string[]
  skippedExisting: string[]
  skippedNoTranscript: string[]
  errors: string[]
  timeZone: string
  meetings: Array<{
    subject: string
    start: string
    meetingId: string | null
    status:
      | 'downloaded'
      | 'already-synced'
      | 'no-transcript'
      | 'cancelled'
      | 'error'
  }>
}> {
  const { userId, outDir, day, timeZone, format } = opts
  const log = opts.onProgress ?? (() => {})
  await fs.mkdir(outDir, { recursive: true })

  const meetings = await listMeetingsForDay(userId, day, timeZone)
  const downloaded: string[] = []
  const skippedExisting: string[] = []
  const skippedNoTranscript: string[] = []
  const errors: string[] = []
  const report: Array<{
    subject: string
    start: string
    meetingId: string | null
    status:
      | 'downloaded'
      | 'already-synced'
      | 'no-transcript'
      | 'cancelled'
      | 'error'
  }> = []

  for (const meeting of meetings) {
    if (!meeting.joinUrl) continue
    const dateStr = (meeting.start || '').slice(0, 10) || 'unknown-date'
    const baseName = `${dateStr}_${slugify(meeting.subject || 'meeting')}`
    const subject = meeting.subject || 'meeting'
    const start = meeting.start || 'unknown-date'
    // AIDEV-NOTE: a cancelled meeting never had a call, so /transcripts would
    // just come back empty — skip the two Graph calls entirely.
    if (meeting.isCancelled) {
      report.push({ subject, start, meetingId: null, status: 'cancelled' })
      continue
    }
    try {
      const meetingId = await resolveMeetingId(userId, meeting.joinUrl)
      const data = (await listTranscripts(userId, meetingId)) as {
        value?: Array<{ id: string }>
      }
      const transcripts = data.value || []
      if (transcripts.length === 0) {
        skippedNoTranscript.push(`${baseName} (no transcript)`)
        report.push({ subject, start, meetingId, status: 'no-transcript' })
        continue
      }
      let anyDownloaded = false
      for (const t of transcripts) {
        const fileName = `${baseName}__${shortId(t.id)}.${extForFormat(format)}`
        const filePath = path.join(outDir, fileName)
        try {
          await fs.access(filePath)
          skippedExisting.push(fileName)
          continue
        } catch {
          // doesn't exist yet, proceed to download
        }
        log(`Downloading ${fileName}...`)
        const content = await getTranscriptContent(
          userId,
          meetingId,
          t.id,
          format,
        )
        await fs.writeFile(filePath, content, 'utf8')
        downloaded.push(fileName)
        anyDownloaded = true
      }
      report.push({
        subject,
        start,
        meetingId,
        status: anyDownloaded ? 'downloaded' : 'already-synced',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      errors.push(`${baseName}: ${msg.slice(0, 200)}`)
      report.push({ subject, start, meetingId: null, status: 'error' })
    }
  }

  return {
    scanned: meetings.length,
    meetings: report,
    downloaded,
    skippedExisting,
    skippedNoTranscript,
    errors,
    timeZone,
  }
}

// AIDEV-NOTE: no LLM-calling API is exposed to tool execute() in this SDK —
// summarization has to happen in the calling agent's own turn. This action
// only does the filesystem diffing (which .vtt lack a sibling .md); the
// agent reads/summarizes/writes using its own read+write tools per the
// format spec returned in the guidance.
// AIDEV-NOTE: default outDir is 'teams-transcripts' relative to cwd, but if
// the user already cd'd into ~/teams-transcripts and re-runs without an
// explicit dir, resolving 'teams-transcripts' again nests a duplicate folder
// inside itself. Reuse cwd as-is when its basename already matches. Shared by
// both /teams-transcript-sync and /teams-transcript-summarize.
async function resolveTranscriptsDir(
  cwd: string,
  argDir?: string,
): Promise<string> {
  if (argDir) return path.resolve(cwd, argDir)
  const configuredOutDir = await resolveConfiguredOutDir(cwd)
  if (configuredOutDir) return path.resolve(cwd, configuredOutDir)
  return path.basename(cwd) === 'teams-transcripts'
    ? cwd
    : path.resolve(cwd, 'teams-transcripts')
}

async function findPendingSummaries(dir: string): Promise<{
  dir: string
  pending: string[]
  alreadyDone: number
}> {
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  const vttFiles = entries.filter((f) => f.endsWith('.vtt'))
  const mdSet = new Set(entries.filter((f) => f.endsWith('.md')))
  const pending = vttFiles.filter((f) => !mdSet.has(f.slice(0, -4) + '.md'))
  return {
    dir,
    pending: pending.map((f) => path.join(dir, f)),
    alreadyDone: vttFiles.length - pending.length,
  }
}

const SUMMARY_FORMAT_GUIDANCE =
  'For each path in `pending`: read the .vtt, convert cues to "Speaker: text" lines ' +
  '(drop WEBVTT header + timestamp lines, merge consecutive same-speaker lines), then write ' +
  'a sibling .md (same basename, .md extension) with sections in this order, omitting any ' +
  'empty one except Transcript: "## Summary" (bullets), "## Decisions" (- [x] ...), ' +
  '"## Action Items" (- [ ] @Owner: ...), "## Open Questions" (bullets), "## Commitments" ' +
  '(@Person: ...), "## Transcript" (the converted speaker lines, full). Base every bullet ' +
  'only on what is actually said; do not invent decisions/owners/action items.'

export default function (pi: ExtensionAPI) {
  // Scaffold config.schema.json next to this file when missing.
  pi.on('session_start', async (event) => {
    if (event.reason !== 'startup') return
    const schemaPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'config.schema.json',
    )
    try {
      await fs.access(schemaPath)
    } catch {
      await fs.writeFile(
        schemaPath,
        JSON.stringify(TeamsTranscriptConfigSchema, null, 2),
        'utf-8',
      )
    }
  })

  pi.registerTool({
    name: 'teams_transcript',
    label: 'Teams Meeting Transcript',
    description:
      'List calendar meetings, list transcripts, or download transcript content for Microsoft Teams meetings via Microsoft Graph (app-only auth); or find synced .vtt transcripts missing a summarized .md sibling.',
    promptSnippet:
      'List/download Teams meeting transcripts via Microsoft Graph, or find .vtt files needing summarization.',
    promptGuidelines: [
      'Use action=listMeetings to find recent meetings and their joinUrl when meetingId is unknown.',
      'Use action=list (with meetingId or joinUrl) to discover transcriptId values for a meeting.',
      'Use action=get with a transcriptId to download transcript content (VTT or plain text).',
      'Use action=pendingSummaries with dir to find .vtt files lacking a same-basename .md, then follow the returned formatGuidance to write each one.',
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('listMeetings'),
          Type.Literal('list'),
          Type.Literal('get'),
          Type.Literal('pendingSummaries'),
          Type.Literal('sync'),
        ],
        {
          description:
            "'listMeetings' recent calendar meetings for a user, 'list' transcripts for a meeting, 'get' transcript content, 'pendingSummaries' to find synced .vtt files missing a summarized .md, or 'sync' to download today's/yesterday's transcripts",
        },
      ),
      userId: Type.Optional(
        Type.String({
          description:
            "Organizer's user ID or UPN (e.g. user@contoso.com); required for listMeetings/list/get, not for pendingSummaries",
        }),
      ),
      dir: Type.Optional(
        Type.String({
          description:
            'Directory of synced .vtt transcripts to scan (required for action=pendingSummaries)',
        }),
      ),
      meetingId: Type.Optional(
        Type.String({
          description:
            'The onlineMeeting ID (required for list/get unless joinUrl given)',
        }),
      ),
      joinUrl: Type.Optional(
        Type.String({
          description:
            'Meeting joinUrl from listMeetings, resolved to a meetingId (alternative to meetingId for list/get)',
        }),
      ),
      transcriptId: Type.Optional(
        Type.String({ description: 'Transcript ID (required for action=get)' }),
      ),
      format: Type.Optional(
        Type.String({
          description:
            "Content format for action=get, e.g. 'text/vtt' (default) or 'text/plain'",
        }),
      ),
      top: Type.Optional(
        Type.Integer({
          description:
            'Number of recent meetings to return for listMeetings (default 10)',
          minimum: 1,
          maximum: 50,
        }),
      ),
      day: Type.Optional(
        Type.Union([Type.Literal('today'), Type.Literal('yesterday')], {
          description: "Day to sync for action=sync, default 'today'",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === 'pendingSummaries') {
        if (!params.dir)
          throw new Error('dir is required for action=pendingSummaries')
        const result = await findPendingSummaries(params.dir)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { ...result, formatGuidance: SUMMARY_FORMAT_GUIDANCE },
                null,
                2,
              ),
            },
          ],
          details: result,
        }
      }

      if (params.action === 'sync') {
        const userId = params.userId || (await resolveConfiguredUserId(ctx.cwd))
        if (!userId) {
          throw new Error(
            'No userId given and none configured (pi-teams-transcript config.json userId, or TEAMS_USER_ID env var)',
          )
        }
        const outDir = await resolveTranscriptsDir(ctx.cwd)
        const timeZone = await resolveConfiguredTimezone(ctx.cwd)
        const day: SyncDay = params.day === 'yesterday' ? 'yesterday' : 'today'
        const result = await syncTranscripts({
          userId,
          outDir,
          day,
          timeZone,
          format: 'text/vtt',
        })
        const lines = [
          `# Teams Transcript Sync (${day}, ${timeZone})`,
          `Meetings scanned: ${result.scanned}`,
          `Downloaded: ${result.downloaded.length}`,
          ...result.downloaded.map((f) => `  + ${f}`),
          `Already present (skipped): ${result.skippedExisting.length}`,
          `No transcript available: ${result.skippedNoTranscript.length}`,
          ...(result.errors.length
            ? [
                `Errors: ${result.errors.length}`,
                ...result.errors.map((e) => `  ! ${e}`),
              ]
            : []),
          `Saved to: ${outDir}`,
          ``,
          `## Report`,
          ...result.meetings.map((m) => formatReportLine(m, timeZone)),
        ]
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          details: result,
        }
      }

      if (!params.userId) {
        throw new Error('userId is required for listMeetings/list/get')
      }

      if (params.action === 'listMeetings') {
        const meetings = await listRecentMeetings(
          params.userId,
          params.top || 10,
        )
        return {
          content: [{ type: 'text', text: JSON.stringify(meetings, null, 2) }],
          details: meetings,
        }
      }

      let meetingId = params.meetingId
      if (!meetingId && params.joinUrl) {
        meetingId = await resolveMeetingId(params.userId, params.joinUrl)
      }
      if (!meetingId) {
        throw new Error('meetingId or joinUrl is required for list/get')
      }

      if (params.action === 'list') {
        const data = await listTranscripts(params.userId, meetingId)
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          details: data,
        }
      }
      if (!params.transcriptId) {
        throw new Error('transcriptId is required for action=get')
      }
      const text = await getTranscriptContent(
        params.userId,
        meetingId,
        params.transcriptId,
        params.format || 'text/vtt',
      )
      return {
        content: [{ type: 'text', text }],
        details: {
          userId: params.userId,
          meetingId,
          transcriptId: params.transcriptId,
        },
      }
    },
    // AIDEV-NOTE: renderCall/renderResult give this tool the same colored,
    // themed look as built-in tools (read/write/etc) instead of the plain
    // ctx.ui.notify text a command is stuck with (notify has no per-line
    // styling API). Uses `details` (structured, not the LLM-facing text) so
    // ANSI/theme codes never leak into the model's context.
    renderCall(args, theme) {
      const parts = [theme.fg('accent', args.action)]
      if (args.action === 'sync')
        parts.push(theme.fg('dim', args.day || 'today'))
      if (args.userId) parts.push(theme.fg('dim', args.userId))
      return new Text(parts.join(' '), 0, 0)
    },
    renderResult(result, _options, theme) {
      const details = result.details as
        | {
            scanned?: number
            downloaded?: string[]
            skippedExisting?: string[]
            skippedNoTranscript?: string[]
            errors?: string[]
            timeZone?: string
            meetings?: Array<{
              subject: string
              start: string
              meetingId: string | null
              status: string
            }>
          }
        | undefined
      if (!details?.meetings) {
        const text = result.content.find((c) => c.type === 'text')
        const raw = text?.type === 'text' ? text.text : ''
        return new Text(`\n${theme.fg('toolOutput', raw)}`, 0, 0)
      }
      // AIDEV-NOTE: print the resolved timezone in the visible header —
      // otherwise there's no way to tell from the rendered output alone
      // whether times were actually converted or just happen to already be
      // in the right zone (both look identical for a UTC+0 misconfiguration).
      const lines = [
        theme.fg('dim', `tz: ${details.timeZone || '(system default)'}`),
        theme.fg('text', `Scanned ${details.scanned ?? 0}`) +
          theme.fg('dim', ' · ') +
          theme.fg('success', `${details.downloaded?.length ?? 0} downloaded`) +
          theme.fg('dim', ' · ') +
          theme.fg(
            'dim',
            `${details.skippedExisting?.length ?? 0} already synced`,
          ),
        '',
        ...details.meetings.map((m) =>
          themedReportLine(
            m,
            theme,
            details.timeZone ||
              Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
        ),
      ]
      return new Text(`\n${lines.join('\n')}`, 0, 0)
    },
  })

  pi.registerCommand('teams-transcript-sync', {
    description:
      "Fetch today's or yesterday's Teams meeting transcripts into a folder, skipping already-downloaded ones. Usage: /teams-transcript-sync [today|yesterday]",
    getArgumentCompletions: (argumentPrefix) => {
      const options: AutocompleteItem[] = [
        {
          value: 'today',
          label: 'today',
          description: "Sync today's meetings",
        },
        {
          value: 'yesterday',
          label: 'yesterday',
          description: "Sync yesterday's meetings",
        },
      ]
      return options.filter((o) => o.value.startsWith(argumentPrefix))
    },
    // AIDEV-NOTE: hands off to the agent via sendUserMessage instead of
    // running syncTranscripts here directly — the teams_transcript tool's
    // action=sync has a themed renderCall/renderResult (colored per status,
    // like read/write), which only kicks in for a real LLM tool call. A
    // command running the same logic itself is stuck with plain ctx.ui.notify
    // (no per-line styling API). Mirrors /teams-transcript-summarize's pattern.
    handler: async (args, ctx) => {
      const argDay = args.trim().split(/\s+/).filter(Boolean)[0]
      const day: SyncDay = argDay === 'yesterday' ? 'yesterday' : 'today'
      const userId = await resolveConfiguredUserId(ctx.cwd)
      if (!userId) {
        ctx.ui.notify(
          'No userId configured. Set "userId" in pi-teams-transcript/config.json (global or project), or the TEAMS_USER_ID env var.',
          'warning',
        )
        return
      }
      pi.sendUserMessage(
        `Call the teams_transcript tool with action="sync", day="${day}".`,
      )
    },
  })

  pi.registerCommand('teams-transcript-summarize', {
    description:
      'Find synced .vtt transcripts missing a summarized .md sibling and have the agent write them. Usage: /teams-transcript-summarize [dir]',
    handler: async (args, ctx) => {
      const [argDir] = args.trim().split(/\s+/).filter(Boolean)
      const dir = await resolveTranscriptsDir(ctx.cwd, argDir)
      const result = await findPendingSummaries(dir)

      if (result.pending.length === 0) {
        ctx.ui.notify(
          `No pending transcripts in ${dir} — all ${result.alreadyDone} .vtt file(s) already have a summary .md.`,
          'info',
        )
        return
      }

      ctx.ui.notify(
        `Summarizing ${result.pending.length} transcript(s) in ${dir}...`,
        'info',
      )
      // AIDEV-NOTE: no LLM-calling API is exposed to command handlers either —
      // hand the pending file list + format spec to the running agent via
      // sendUserMessage, and let it read/summarize/write each one with its
      // own tools (mirrors the pendingSummaries tool action's approach).
      pi.sendUserMessage(
        `Summarize these Teams transcripts. ${SUMMARY_FORMAT_GUIDANCE}\n\nFiles:\n${result.pending.map((p) => `- ${p}`).join('\n')}`,
      )
    },
  })
}
