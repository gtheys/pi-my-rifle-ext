import { spawn } from 'node:child_process'
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
  weekly: Type.Optional(
    Type.String({
      description:
        'Directory to write /teams-transcript-weekly reports to, one file per ISO week (e.g. 2026-w32.md). Relative paths resolve from cwd. Required for that command — no default.',
    }),
  ),
  projects: Type.Optional(
    Type.String({
      description:
        'Directory of one .md file per project (e.g. an Obsidian vault Projects folder). When set, /teams-transcript-summarize and /teams-transcript-weekly cross-link meeting notes with matching project notes, creating or updating a project note when a discussed project has none yet. Relative paths resolve from cwd. Optional — feature is skipped entirely when unset.',
    }),
  ),
  // AIDEV-NOTE: znServer/znToken are consumed by push-to-zn.sh (ships next to
  // the global config), not by the extension itself — schema lives here so
  // the config file stays single-source and Value.Check accepts the keys.
  znServer: Type.Optional(
    Type.String({
      description:
        'ZenNotes server base URL (e.g. http://100.108.226.64:8089) that push-to-zn.sh targets for the workspace vault. Env ZENNOTES_SERVER overrides.',
    }),
  ),
  znToken: Type.Optional(
    Type.String({
      description:
        'Auth token for znServer, used by push-to-zn.sh. Env ZENNOTES_REMOTE_TOKEN overrides.',
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

async function readConfigFile(file: string): Promise<{
  outDir?: string
  userId?: string
  timezone?: string
  weekly?: string
  projects?: string
  znServer?: string
  znToken?: string
}> {
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

async function resolveConfiguredWeeklyDir(
  cwd: string,
): Promise<string | undefined> {
  const global = await readConfigFile(GLOBAL_CONFIG_PATH)
  const project = await readConfigFile(projectConfigPath(cwd))
  return project.weekly || global.weekly
}

async function resolveConfiguredProjectsDir(
  cwd: string,
): Promise<string | undefined> {
  const global = await readConfigFile(GLOBAL_CONFIG_PATH)
  const project = await readConfigFile(projectConfigPath(cwd))
  return project.projects || global.projects
}

// AIDEV-NOTE: zn server/token precedence — ZENNOTES_* env vars > project
// config > global config. Consumed by /teams-transcript-push.
async function resolveConfiguredZn(
  cwd: string,
): Promise<{ server?: string; token?: string }> {
  const global = await readConfigFile(GLOBAL_CONFIG_PATH)
  const project = await readConfigFile(projectConfigPath(cwd))
  return {
    server: process.env.ZENNOTES_SERVER || project.znServer || global.znServer,
    token:
      process.env.ZENNOTES_REMOTE_TOKEN || project.znToken || global.znToken,
  }
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
export type SyncRange = SyncDay | 'week' | 'month'

// AIDEV-NOTE: 'week'/'month' are just N repeats of the existing single-day
// sync (today, today-1, ... today-N+1) — each day keeps its own
// dayBounds()-scoped transcript filter (see syncTranscripts), so this reuses
// the recurring-meeting date-window fix rather than introducing a second
// code path that could reintroduce the duplicate/mislabeled-date bug.
function dayOffsetsFor(range: SyncRange): number[] {
  if (range === 'week') return [0, -1, -2, -3, -4, -5, -6]
  if (range === 'month') return Array.from({ length: 30 }, (_, i) => -i)
  return range === 'yesterday' ? [-1] : [0]
}

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
function dayBounds(
  dayOffset: number,
  timeZone: string,
): { start: Date; end: Date } {
  const now = new Date()
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

// AIDEV-NOTE: standard ISO 8601 week number algorithm — shifts to the
// Thursday of the same week, since ISO week-year is defined by which
// calendar year contains that week's Thursday (handles the Dec/Jan boundary
// correctly, e.g. Dec 31 2029 is ISO week 1 of 2030).
function isoWeek(date: Date): { isoYear: number; isoWeek: number } {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  )
  const dayNum = d.getUTCDay() || 7 // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const isoYear = d.getUTCFullYear()
  const yearStart = new Date(Date.UTC(isoYear, 0, 1))
  const isoWeekNum = Math.ceil(
    ((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  )
  return { isoYear, isoWeek: isoWeekNum }
}

// AIDEV-NOTE: work week is Mon-Fri only (no weekend meetings expected). We
// only ever report on an already-*finished* work week: while "today" (in
// timeZone) still falls inside the current Mon-Fri span, that week isn't
// over yet, so target the previous week instead. Once today is Sat/Sun, the
// week that just ended becomes the target — this is also why skip-if-exists
// (see the command handler) is safe to be permanent: a target week is never
// touched again once its report exists, and we never re-target a week still
// in progress.
function targetWeekBounds(timeZone: string): {
  monday: string // YYYY-MM-DD
  friday: string
  weekLabel: string // '2026-w32'
} {
  const now = new Date()
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const [y, m, d] = ymd.split('-').map(Number)
  const today = new Date(Date.UTC(y, m - 1, d))
  const isoDow = today.getUTCDay() || 7 // Mon=1..Sun=7
  const thisMonday = new Date(today.getTime() - (isoDow - 1) * 86_400_000)
  const currentWeekFinished = isoDow >= 6 // Sat or Sun
  const targetMonday = currentWeekFinished
    ? thisMonday
    : new Date(thisMonday.getTime() - 7 * 86_400_000)
  const targetFriday = new Date(targetMonday.getTime() + 4 * 86_400_000)
  const { isoYear, isoWeek: weekNum } = isoWeek(targetMonday)
  return {
    monday: targetMonday.toISOString().slice(0, 10),
    friday: targetFriday.toISOString().slice(0, 10),
    weekLabel: `${isoYear}-w${String(weekNum).padStart(2, '0')}`,
  }
}

// AIDEV-NOTE: pure filesystem scan, no Graph call needed — .md notes live at
// the top level of outDir (see vttSubdir), frontmatter date is always a
// plain `date: YYYY-MM-DD` scalar (see buildTranscriptStub), so string
// comparison against the YYYY-MM-DD bounds sorts correctly.
async function findWeekMeetings(
  outDir: string,
  monday: string,
  friday: string,
): Promise<Array<{ path: string; hasSummary: boolean }>> {
  const entries = await fs.readdir(outDir).catch(() => [] as string[])
  const results: Array<{ path: string; hasSummary: boolean }> = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(outDir, entry)
    const content = await fs.readFile(filePath, 'utf8').catch(() => null)
    if (content === null) continue
    const dateMatch = content.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m)
    if (!dateMatch) continue
    const date = dateMatch[1]
    if (date < monday || date > friday) continue
    results.push({
      path: filePath,
      hasSummary: /^## Summary\b/m.test(content),
    })
  }
  results.sort((a, b) => a.path.localeCompare(b.path))
  return results
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
  dayOffset: number,
  timeZone: string,
) {
  const { start, end } = dayBounds(dayOffset, timeZone)
  const res = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}&$orderby=start/dateTime asc&$top=100&$select=subject,start,end,isAllDay,isCancelled,isOnlineMeeting,onlineMeeting,attendees`,
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
      attendees?: Array<{ emailAddress?: { name?: string } }>
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
      attendees: (e.attendees || [])
        .map((a) => a.emailAddress?.name)
        .filter((n): n is string => Boolean(n)),
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

// AIDEV-NOTE: "Speaker attribution" is one of two independent tenant admin
// settings gating this API (the other, "Graph API access to transcripts",
// blocks everything with GraphAccessToTranscriptsDisabled and has no
// workaround). Both are configured via Teams Admin Center or
// Set-CsTeamsMeetingConfiguration — see Microsoft Graph's callTranscript-get
// docs, "Tenant administrator controls for transcript access". Verified live:
// this is evaluated per-request against the *current* tenant setting, not
// baked in at recording time — toggling it back on should make text/vtt work
// again for old transcripts too (allow for propagation delay). Graph's own
// error names the fallback content-type; retry with it once so sync still
// gets a transcript instead of erroring the whole meeting. Fallback body has
// no <v Name> tags (parseVttCues handles that).
const SPEAKER_ATTRIBUTION_FALLBACK_ACCEPT =
  'application/vnd.microsoft.graph.transcript+text'

async function getTranscriptContent(
  userId: string,
  meetingId: string,
  transcriptId: string,
  format: string,
) {
  const guid = await resolveUserGuid(userId)
  const base = `${GRAPH_BASE}/users/${encodeURIComponent(guid)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content`
  try {
    const res = await graphFetch(
      `${base}?$format=${encodeURIComponent(format)}`,
      format,
    )
    return res.text()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (!msg.includes('SpeakerAttributionNotAllowed')) throw error
    const res = await graphFetch(base, SPEAKER_ATTRIBUTION_FALLBACK_ACCEPT)
    return res.text()
  }
}

// AIDEV-NOTE: one aligned line per meeting instead of a markdown table —
// pipe tables wrap badly in a narrow terminal and the full meetingId (a
// long base64-ish blob) is pure noise here; truncate it, it's not
// actionable from this report anyway (sync already used it internally).
const STATUS_ICON: Record<string, string> = {
  downloaded: '\u2713',
  'already-synced': '\u2713',
  'no-transcript': '\u00b7',
  'not-started': '\u00b7',
  'not-organizer': '\u00b7',
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
  'not-started': 'dim',
  'not-organizer': 'dim',
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

// AIDEV-NOTE: raw downloaded transcripts (.vtt/.txt) live under outDir/vtt/
// so the vault's top level only shows the .md notes. Single source of truth
// for that path — used by both the sync writer and findPendingSummaries'
// reader, so they can never drift apart.
function vttSubdir(outDir: string): string {
  return path.join(outDir, 'vtt')
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
  dayOffset: number
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
      | 'not-started'
      | 'not-organizer'
      | 'cancelled'
      | 'error'
  }>
}> {
  const { userId, outDir, dayOffset, timeZone, format } = opts
  const log = opts.onProgress ?? (() => {})
  const vttDir = vttSubdir(outDir)
  await fs.mkdir(vttDir, { recursive: true })

  const dayWindow = dayBounds(dayOffset, timeZone)
  const meetings = await listMeetingsForDay(userId, dayOffset, timeZone)
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
      | 'not-started'
      | 'not-organizer'
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
    // AIDEV-NOTE: a recurring meeting's joinUrl resolves to ONE onlineMeeting
    // object shared by the whole series (Graph doesn't scope it per
    // occurrence) — its /transcripts collection can already hold a transcript
    // from a *previous* day before today's occurrence has even started.
    // Never call Graph for an occurrence that hasn't happened yet; there is
    // no way it has a real transcript of its own.
    const hasOffset = /[Zz]$|[+-]\d{2}:\d{2}$/.test(start)
    const startMs = Date.parse(hasOffset ? start : `${start}Z`)
    if (!Number.isNaN(startMs) && startMs > Date.now()) {
      report.push({ subject, start, meetingId: null, status: 'not-started' })
      continue
    }
    try {
      const meetingId = await resolveMeetingId(userId, meeting.joinUrl)
      const data = (await listTranscripts(userId, meetingId)) as {
        value?: Array<{ id: string; createdDateTime?: string }>
      }
      // AIDEV-NOTE: a recurring series' /transcripts collection holds every
      // occurrence's transcript ever generated, not just today's — without
      // this filter every sync run re-downloads the whole history under
      // *today's* filename (confirmed: same transcriptId on disk 3x under 3
      // different dates). Keep only transcripts actually created within the
      // day being synced; a transcript with no createdDateTime falls back to
      // the old (permissive) behavior rather than being dropped outright.
      const transcripts = (data.value || []).filter((t) => {
        const createdMs = Date.parse(t.createdDateTime || '')
        if (Number.isNaN(createdMs)) return true
        return (
          createdMs >= dayWindow.start.getTime() &&
          createdMs < dayWindow.end.getTime()
        )
      })
      if (transcripts.length === 0) {
        skippedNoTranscript.push(`${baseName} (no transcript)`)
        report.push({ subject, start, meetingId, status: 'no-transcript' })
        continue
      }
      let anyDownloaded = false
      for (const t of transcripts) {
        const fileName = `${baseName}__${shortId(t.id)}.${extForFormat(format)}`
        const filePath = path.join(vttDir, fileName)
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

        // AIDEV-NOTE: pre-create the sibling .md stub right away, while we
        // still have real Graph metadata (subject/date/attendees) — the
        // manually-dropped-.vtt fallback in findPendingSummaries only kicks
        // in when this never ran. Never overwrite an existing .md (could
        // already have a filled-in summary).
        if (format === 'text/vtt') {
          const mdPath = path.join(outDir, `${baseName}__${shortId(t.id)}.md`)
          try {
            await fs.access(mdPath)
          } catch {
            const cues = parseVttCues(content)
            const stub = buildTranscriptStub(
              {
                title: subject,
                date: dateStr,
                attendees: meeting.attendees || [],
              },
              cues,
            )
            await fs.writeFile(mdPath, stub, 'utf8')
          }
        }
      }
      report.push({
        subject,
        start,
        meetingId,
        status: anyDownloaded ? 'downloaded' : 'already-synced',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // AIDEV-NOTE: "3003: User does not have access to lookup meeting" means
      // the configured userId isn't that meeting's actual organizer (app
      // access policy is granted per-organizer) — expected for meetings you
      // only attend, not an actionable error worth surfacing in red.
      if (msg.includes('3003')) {
        report.push({
          subject,
          start,
          meetingId: null,
          status: 'not-organizer',
        })
        continue
      }
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

// AIDEV-NOTE: 'week'/'month' just call syncTranscripts once per day offset
// and concatenate the reports — each day keeps its own dayBounds()-scoped
// transcript filter, so backfilling a range can't reintroduce the
// mislabeled-date bug a single shared window would.
async function syncTranscriptsRange(opts: {
  userId: string
  outDir: string
  range: SyncRange
  timeZone: string
  format: string
  onProgress?: (line: string) => void
}) {
  const offsets = dayOffsetsFor(opts.range)
  const results = []
  for (const dayOffset of offsets) {
    results.push(
      await syncTranscripts({
        userId: opts.userId,
        outDir: opts.outDir,
        dayOffset,
        timeZone: opts.timeZone,
        format: opts.format,
        onProgress: opts.onProgress,
      }),
    )
  }
  return {
    scanned: results.reduce((n, r) => n + r.scanned, 0),
    downloaded: results.flatMap((r) => r.downloaded),
    skippedExisting: results.flatMap((r) => r.skippedExisting),
    skippedNoTranscript: results.flatMap((r) => r.skippedNoTranscript),
    errors: results.flatMap((r) => r.errors),
    timeZone: opts.timeZone,
    meetings: results.flatMap((r) => r.meetings),
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

// AIDEV-NOTE: unlike outDir, weekly has no sane default — it's a deliberate
// separate folder the user opts into, so return undefined (not a fallback
// path) when unconfigured and let the command tell the user to set it.
async function resolveWeeklyDir(cwd: string): Promise<string | undefined> {
  const configured = await resolveConfiguredWeeklyDir(cwd)
  if (!configured) return undefined
  return path.resolve(cwd, configured)
}

// AIDEV-NOTE: same shape as resolveWeeklyDir — project cross-linking is an
// opt-in feature, no fallback path when unconfigured.
async function resolveProjectsDir(cwd: string): Promise<string | undefined> {
  const configured = await resolveConfiguredProjectsDir(cwd)
  if (!configured) return undefined
  return path.resolve(cwd, configured)
}

// AIDEV-NOTE: VTT → transcript-line conversion is pure parsing, no LLM
// needed, so it happens in code (both at sync time with fresh Graph
// metadata, and lazily here for a manually-dropped .vtt with none).
interface TranscriptCue {
  speaker: string
  time: string
  text: string
}

function vttTimestampToMSS(ts: string): string {
  const [h, m, s] = ts.split(':')
  const totalMin = Number(h) * 60 + Number(m)
  const sec = Math.floor(Number(s))
  return `${totalMin}:${String(sec).padStart(2, '0')}`
}

function parseVttCues(vttContent: string): TranscriptCue[] {
  const lines = vttContent.split(/\r?\n/)
  const cues: TranscriptCue[] = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(
      /^(\d\d:\d\d:\d\d\.\d+)\s*-->\s*(\d\d:\d\d:\d\d\.\d+)/,
    )
    if (m) {
      const time = vttTimestampToMSS(m[1])
      let j = i + 1
      const textLines: string[] = []
      while (j < lines.length && lines[j].trim() !== '') {
        textLines.push(lines[j])
        j++
      }
      const joined = textLines.join(' ')
      const vMatch = joined.match(/<v\s+([^>]+)>([\s\S]*?)<\/v>/)
      if (vMatch) {
        cues.push({
          speaker: vMatch[1].trim(),
          time,
          text: vMatch[2].replace(/\s+/g, ' ').trim(),
        })
      } else if (joined.trim()) {
        // AIDEV-NOTE: speaker-attribution-disabled fallback content has no <v
        // Name> tag at all — keep the cue (real transcript text) with an empty
        // speaker rather than dropping it silently.
        cues.push({
          speaker: '',
          time,
          text: joined.replace(/\s+/g, ' ').trim(),
        })
      }
      i = j
    } else {
      i++
    }
  }
  return cues
}

function attendeesFromCues(cues: TranscriptCue[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const c of cues) {
    if (!c.speaker || seen.has(c.speaker)) continue
    seen.add(c.speaker)
    result.push(c.speaker)
  }
  return result
}

// AIDEV-NOTE: attendee name → Obsidian wikilink. Graph display names in Asia
// often embed a bracketed nickname — "Lam [Liam] Pham". The canonical full
// name is "Lam Pham" and the nickname is "Liam"; everywhere the person appears
// we render [[Lam Pham|Liam]] (full-name link target, nickname as the visible
// alias) so a given person always looks the same. Names without a bracket use
// the full name directly, aliasing a short mention ([[Geert Theys|Geert]]).
// Also strips zero-width spaces that sneak into some Graph names
// ("Natthawarin\u200b [Nut] Kitthanatsakul\u200b"). Used for the Attendees
// header, transcript speaker labels, and (via the summary guidance) names the
// agent writes.
// ponytail: first match wins on ambiguous short names (e.g. two attendees
// sharing a first name); per-mention disambiguation isn't worth it, surface
// the ambiguity in the summary if it matters.
const ZWS = /\u200b/g

export function normalizeName(s: string): string {
  return s.replace(ZWS, '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function parseAttendee(raw: string): {
  full: string
  nickname: string | null
} {
  const clean = raw.replace(ZWS, '')
  const m = clean.match(/^(.*?)\s*\[([^\]]+)\]\s*(.*)$/)
  if (!m) {
    return { full: clean.replace(/\s+/g, ' ').trim(), nickname: null }
  }
  const before = m[1].replace(/\s+/g, ' ').trim()
  const after = m[3].replace(/\s+/g, ' ').trim()
  const full = `${before} ${after}`.replace(/\s+/g, ' ').trim()
  const nickname = m[2].replace(/\s+/g, ' ').trim()
  // ponytail: a name that is only "[Nick]" (no surrounding tokens) — fall back
  // to the nickname as the full name rather than emitting an empty link target.
  if (!full) return { full: nickname, nickname: null }
  return { full, nickname }
}

export function resolveAttendee(
  attendees: string[],
  name: string,
): { full: string; alias: string | null } {
  const parsed = attendees.map((raw) => ({ raw, ...parseAttendee(raw) }))
  const raw = name.trim().replace(ZWS, '')
  const n = normalizeName(raw)
  if (!n) return { full: raw, alias: null }

  // Match most-specific first: raw Graph name, de-bracketed full name, then
  // the bracketed nickname itself. A matched person always renders the same
  // way — nickname alias if they have one, else alias the short mention.
  const matched =
    parsed.find((p) => normalizeName(p.raw) === n) ||
    parsed.find((p) => normalizeName(p.full) === n) ||
    parsed.find((p) => p.nickname && normalizeName(p.nickname) === n)
  if (matched) {
    if (matched.nickname) return { full: matched.full, alias: matched.nickname }
    if (normalizeName(matched.full) !== n) {
      return { full: matched.full, alias: raw }
    }
    return { full: matched.full, alias: null }
  }

  const tokens = n.split(' ')
  if (tokens.length === 1) {
    const tok = parsed.find((p) => {
      const ft = normalizeName(p.full).split(' ')
      return ft[0] === n || ft[ft.length - 1] === n
    })
    if (tok) {
      if (tok.nickname) return { full: tok.full, alias: tok.nickname }
      return { full: tok.full, alias: raw }
    }
  }
  const sub = parsed.find((p) => normalizeName(p.full).includes(n))
  if (sub) {
    if (sub.nickname) return { full: sub.full, alias: sub.nickname }
    return { full: sub.full, alias: raw }
  }
  return { full: raw, alias: null }
}

export function attendeeLink(attendees: string[], name: string): string {
  const { full, alias } = resolveAttendee(attendees, name)
  if (alias) return `[[${full}|${alias}]]`
  return `[[${full}]]`
}

// AIDEV-NOTE: de-slugify a filename basename into a human title, for the
// manually-dropped-.vtt fallback where we have no Graph subject to use.
function titleFromFilename(basename: string): string {
  let name = basename.replace(/__[0-9a-f]{8,}$/i, '')
  name = name.replace(/^\d{4}-\d{2}-\d{2}_/, '')
  if (name.includes('-') && !name.includes(' ')) {
    name = name.replace(/-/g, ' ')
  }
  name = name.replace(/\s+/g, ' ').trim()
  return name.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Meeting'
}

async function dateFromFile(
  filePath: string,
  basename: string,
): Promise<string> {
  const m = basename.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m) return m[1]
  const stat = await fs.stat(filePath)
  return stat.mtime.toISOString().slice(0, 10)
}

// AIDEV-NOTE: minimal YAML scalar escaping — quote if it has YAML-special
// chars or leading/trailing whitespace, otherwise emit bare.
function yamlScalar(s: string): string {
  if (/^[\s]|[\s]$|[:#\-[\]{}&*!|>'"%@`]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`
  }
  return s
}

interface TranscriptMeta {
  title: string
  date: string
  attendees: string[]
}

// AIDEV-NOTE: builds the full stub — frontmatter (Obsidian properties) +
// the user-visible "# title / Date / Attendees" header + the already-final
// Transcript section. Summarization only ever inserts sections *between*
// the header and Transcript; nothing here should need to change later.
function buildTranscriptStub(
  meta: TranscriptMeta,
  cues: TranscriptCue[],
): string {
  const attendeesYaml = meta.attendees.length
    ? [
        'attendees:',
        // AIDEV-NOTE: de-bracket nicknames so frontmatter holds the canonical
        // full name (the link target), not the raw Graph display name — e.g.
        // "Lam [Liam] Pham" is stored as "Lam Pham". The nickname survives as
        // the visible alias in the header/summary wikilinks.
        ...meta.attendees.map(
          (a) => `  - ${yamlScalar(parseAttendee(a).full)}`,
        ),
      ].join('\n')
    : 'attendees: []'
  const frontmatter = [
    '---',
    `title: ${yamlScalar(meta.title)}`,
    `date: ${meta.date}`,
    attendeesYaml,
    '---',
  ].join('\n')
  // AIDEV-NOTE: attendee names render as Obsidian wikilinks in the visible
  // header, going through attendeeLink so a bracketed nickname like
  // "Lam [Liam] Pham" becomes [[Lam Pham|Liam]] here too (same form as the
  // transcript + summary). Frontmatter stays plain strings — structured
  // data, not prose.
  const header = [
    `# ${meta.title}`,
    '',
    `- **Date:** ${meta.date}`,
    `- **Attendees:** ${meta.attendees
      .map((a) => attendeeLink(meta.attendees, a))
      .join(', ')}`,
  ].join('\n')
  const transcript = [
    '## Transcript',
    '',
    cues
      .map((c) =>
        // AIDEV-NOTE: no speaker (tenant's speaker-attribution policy was off
        // when this transcript was recorded) — print the line without a
        // wikilink instead of linking to a made-up/empty name.
        c.speaker
          ? `${attendeeLink(meta.attendees, c.speaker)} \`${c.time}\` ${c.text}`
          : `\`${c.time}\` ${c.text}`,
      )
      .join('\n'),
  ].join('\n')
  return `${frontmatter}\n\n${header}\n\n${transcript}\n`
}

async function findPendingSummaries(dir: string): Promise<{
  dir: string
  pending: string[]
  alreadyDone: number
}> {
  const vttDir = vttSubdir(dir)
  const entries = await fs.readdir(vttDir).catch(() => [] as string[])
  const vttFiles = entries.filter((f) => f.endsWith('.vtt'))
  const pending: string[] = []
  let alreadyDone = 0
  for (const vttFile of vttFiles) {
    const base = vttFile.slice(0, -4)
    const vttPath = path.join(vttDir, vttFile)
    // AIDEV-NOTE: .md notes stay at the top level (dir), not vttDir — only the
    // raw .vtt lives in the vtt/ subfolder.
    const mdPath = path.join(dir, `${base}.md`)
    let mdContent: string | null = null
    try {
      mdContent = await fs.readFile(mdPath, 'utf8')
    } catch {
      mdContent = null
    }
    // AIDEV-NOTE: no .md at all (e.g. a .vtt dropped in manually, or synced
    // before this feature existed) — bootstrap the stub now, deterministically,
    // so the agent's job is always the same: fill in an existing stub.
    if (mdContent === null) {
      const vttContent = await fs.readFile(vttPath, 'utf8')
      const cues = parseVttCues(vttContent)
      const stub = buildTranscriptStub(
        {
          title: titleFromFilename(base),
          date: await dateFromFile(vttPath, base),
          attendees: attendeesFromCues(cues),
        },
        cues,
      )
      await fs.writeFile(mdPath, stub, 'utf8')
      pending.push(mdPath)
      continue
    }
    // AIDEV-NOTE: anchor to an actual heading line, not a bare substring —
    // a Transcript line where someone literally says "## Summary" (rare but
    // real in a raw speech dump) would otherwise false-positive as done.
    if (/^## Summary\b/m.test(mdContent)) {
      alreadyDone++
    } else {
      pending.push(mdPath)
    }
  }
  return { dir, pending, alreadyDone }
}

// AIDEV-NOTE: exact section order/style the agent must follow when filling
// each stub .md — kept as a literal template (not just prose) since prose
// alone drifted on checkbox style in practice.
const SUMMARY_SECTIONS_TEMPLATE = `## Summary

- <bullet per topic discussed>

## Decisions

- <decision made>

## Action Items

- [ ] [[<Owner>]]: <task> (due <YYYY-MM-DD>, if a due date was mentioned)

## Open Questions

- <unresolved question raised>

## Commitments

- [[<Person>]]: <what they committed to>
`

const SUMMARY_FORMAT_GUIDANCE =
  'Each path in `pending` is a .md file that already has frontmatter (title/date/attendees), ' +
  'a "# title" header with Date/Attendees bullets, and a full "## Transcript" section at the ' +
  'bottom — do not touch any of that, do not create a new file. Read it, then insert these ' +
  'sections between the header and "## Transcript" (omit a section entirely if it has ' +
  'nothing real to put in it):\n\n' +
  `${SUMMARY_SECTIONS_TEMPLATE}\n` +
  'Action Items use `- [ ]` (open todo, not done yet — never `- [x]`, even if the ' +
  'transcript says work already started). Decisions, Open Questions, and Commitments are ' +
  'plain bullets, no checkboxes. Render every ' +
  'person name as an Obsidian wikilink, matching the speaker links already in the Transcript ' +
  'section. Attendee names often embed a bracketed nickname — `Lam [Liam] Pham` becomes full ' +
  'name `Lam Pham` with nickname `Liam`, rendered `[[Lam Pham|Liam]]`; apply that exact form ' +
  'everywhere the person appears (do NOT keep the brackets inside the link). For names without ' +
  'a bracket, use the full attendee name from the **Attendees** header and alias a short mention ' +
  '(`[[Geert Theys|Geert]]` for "Geert", `[[Geert Theys]]` for the full name). Base every ' +
  'bullet only on what is actually said in the Transcript section already in the file; never ' +
  'invent decisions, owners, or action items not present. Only add a `(due YYYY-MM-DD)` to an ' +
  'Action Item if the transcript explicitly states a due date or deadline — convert a relative ' +
  'date ("by Friday", "end of next week") to an absolute YYYY-MM-DD using the note\'s own ' +
  '**Date** as the reference point; omit the due-date parenthetical entirely if none was stated, ' +
  'never invent one.'

// AIDEV-NOTE: adapted from a different tool's weekly-synthesis skill spec —
// kept the shape (themes/decision-arcs/action-audit/forward-brief/closing),
// dropped everything needing that tool's CLI (search/actions/people/
// commitments), its prep/debrief files, and its presentation-focus
// preference-learning hooks, none of which exist here. Commitments come
// from the '## Commitments' section already in each note instead of a
// separate relationship-intelligence system. Fixed decisions-first
// ordering, no persisted preference (ask if that's wanted later).
const WEEKLY_FORMAT_GUIDANCE =
  'Some of these files may still be missing their summary sections — fill those in first ' +
  'using this format:\n\n' +
  `${SUMMARY_FORMAT_GUIDANCE}\n\n` +
  "Then write a weekly synthesis to the exact path given below (create it, don't overwrite " +
  'anything else). Structure, in this order:\n\n' +
  "## This Week's Themes\n\n" +
  "Identify the 3-5 dominant themes across this week's meetings. A theme is a topic that " +
  'appeared in 2+ meetings. For each: which meetings discussed it, how the conversation ' +
  'evolved, whether resolved. Example:\n\n' +
  '### 1. Pricing (3 meetings)\n- Mon: proposed $599 baseline\n- Wed: pushback to annual ' +
  'billing\n- Fri: agreed on monthly billing experiment\n- Status: RESOLVED\n\n' +
  '## Decision Arcs\n\n' +
  'For every decision found this week, check whether the same topic was decided differently ' +
  'in the last 30 days — read the other .md notes in the same directory (not just this ' +
  "week's) to find prior mentions. Classify each: STABLE (held across 2+ mentions), " +
  'VOLATILE (changed 2+ times in 14 days), CONFLICTING (two active contradictory decisions ' +
  '— flag prominently with ⚠️), NEW (first time decided). Present as a table: Decision | ' +
  'Status | Arc | Last Meeting.\n\n' +
  '## Action Item Audit\n\n' +
  "Scan this week's and recent notes' Action Items. Categorize: Completed this week, " +
  'Still open (on track), Overdue (has a `(due YYYY-MM-DD)` in the past, still unchecked — ' +
  'flag prominently), Assigned to others. An item with no due date is never "overdue", just ' +
  '"open" — don\'t guess a date.\n\n' +
  '## Commitments\n\n' +
  'Summarize the "## Commitments" section across this week\'s notes — who committed to what.\n\n' +
  '## Attention Monday\n\n' +
  'What deserves attention next Monday, prioritized: CONFLICTING decisions > overdue action ' +
  'items > open commitments. State facts plainly ("overdue since Friday"), not naggy tone.\n\n' +
  '## Closing\n\n' +
  'Three short beats: (1) a reflection on a pattern from the week, (2) the single most ' +
  "important thing to do Monday, (3) nothing else — no tool nudges for tools that don't " +
  'exist here.\n\n' +
  "Guardrails: base everything only on what's actually written in the notes, never invent a " +
  'decision, owner, theme, or date. If a category has nothing real, omit that subsection ' +
  'rather than padding it.'

// AIDEV-NOTE: matches the observed convention of real project notes in a
// vault Projects folder — `# Title`, then a one-line description, then
// `## Status` (dated bullet subsections) and `## Meetings` (bullets linking
// back to meeting note filenames). Only built when `projects` is configured;
// callers must skip entirely otherwise — no hardcoded fallback path.
function buildProjectCrosslinkGuidance(projectsDir: string): string {
  return (
    `Project cross-linking: for every project discussed, check ${projectsDir} for a matching ` +
    '.md file (filename or `# Title` heading matching the project name, case-insensitive; a ' +
    'close/renamed match still counts as the same project, ask the user only if genuinely ' +
    'ambiguous). If found:\n' +
    '- Add a `[[Project Name]]` wikilink into the meeting note wherever that project is ' +
    'discussed (Summary/Decisions/etc.).\n' +
    "- Add a bullet to that project note's `## Meetings` section linking back to this meeting " +
    'note, e.g. `- [[<meeting-filename-without-.md>]] <one-line takeaway>` (create the ' +
    '`## Meetings` section if missing).\n' +
    "- If the project note's one-line description (the text right under the `# Title` heading, " +
    'before the first `##`) is stale or missing given what was just discussed, replace/add it ' +
    "with an accurate one-liner — keep it short, don't rewrite the rest of the note.\n\n" +
    `If no matching file exists in ${projectsDir}, create \`<Project Name>.md\` there with:\n` +
    '```\n# <Project Name>\n\n<one-line description synthesized from what was discussed>\n\n' +
    '## Status\n\n### [[<meeting-date>]]\n\n- <bullet summarizing what was decided/discussed>\n\n' +
    '## Meetings\n\n- [[<meeting-filename-without-.md>]] <one-line takeaway>\n```\n' +
    'and link it from the meeting note the same way as an existing match. Never invent a project ' +
    "that wasn't actually discussed; skip this entirely for meetings that don't mention any project."
  )
}

// AIDEV-NOTE: push core — moves synced meeting notes + raw vtt from the
// staging outDir into the ZenNotes workspace vault via the zn CLI
// (installed from the ZenNotes app, Settings → CLI). Runs as a package
// command so deployment needs no per-machine script; server/token come
// from config/env (see resolveConfiguredZn).
export type ZnRunner = (args: string[], input?: string) => Promise<string>

export function createZnRunner(server: string, token: string): ZnRunner {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn('zn', args, {
        env: {
          ...process.env,
          ZENNOTES_SERVER: server,
          ZENNOTES_REMOTE_TOKEN: token,
        },
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d) => (stdout += d))
      child.stderr?.on('data', (d) => (stderr += d))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`zn ${args[0]} exited ${code}: ${stderr.trim()}`))
      })
      if (input !== undefined) child.stdin?.end(input)
    })
}

export async function pushStagingToZn(
  staging: string,
  run: ZnRunner,
): Promise<string[]> {
  const lines: string[] = []
  const groups: Array<{ dir: string; sub: string; ext: string }> = [
    { dir: staging, sub: 'Meetings', ext: '.md' },
    { dir: path.join(staging, 'vtt'), sub: 'Meetings/vtt', ext: '.vtt' },
  ]
  for (const { dir, sub, ext } of groups) {
    const entries = await fs.readdir(dir).catch(() => [] as string[])
    const names = entries.filter((n) => n.endsWith(ext)).sort()
    for (const name of names) {
      const file = path.join(dir, name)
      const title = name.slice(0, -ext.length)
      const vaultPath = `${sub}/${title}.md`
      // dedup on full vault path — the .md note and .vtt note share a basename
      const search = JSON.parse(
        await run(['search-title', title, '--json']),
      ) as Array<{
        path?: string
      }>
      if (Array.isArray(search) && search.some((h) => h.path === vaultPath)) {
        lines.push(`skip (exists): ${vaultPath}`)
      } else {
        const body = await fs.readFile(file, 'utf8')
        await run(
          [
            'create',
            '--folder',
            'inbox',
            '--subpath',
            sub,
            '--title',
            title,
            '--body',
            '-',
          ],
          body,
        )
        lines.push(`pushed: ${vaultPath}`)
      }
      // move to pushed/ so re-runs are no-ops even without the remote check
      const dest = path.join(staging, 'pushed', path.relative(staging, file))
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.rename(file, dest)
    }
  }
  return lines
}

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
      'List calendar meetings, list transcripts, or download transcript content for Microsoft Teams meetings via Microsoft Graph (app-only auth); or find synced transcripts whose .md stub is still missing its summary sections.',
    promptSnippet:
      'List/download Teams meeting transcripts via Microsoft Graph, or find .vtt files needing summarization.',
    promptGuidelines: [
      'Use action=listMeetings to find recent meetings and their joinUrl when meetingId is unknown.',
      'Use action=list (with meetingId or joinUrl) to discover transcriptId values for a meeting.',
      'Use action=get with a transcriptId to download transcript content (VTT or plain text).',
      'Use action=pendingSummaries with dir to find .md stubs (frontmatter + header + Transcript already filled in) still missing their summary sections, then follow the returned formatGuidance to fill each one in.',
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
            "'listMeetings' recent calendar meetings for a user, 'list' transcripts for a meeting, 'get' transcript content, 'pendingSummaries' to find .md stubs still missing their summary sections, or 'sync' to download today's/yesterday's transcripts",
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
            'Directory of synced transcripts to scan for .md stubs still missing their summary (required for action=pendingSummaries)',
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
        Type.Union(
          [
            Type.Literal('today'),
            Type.Literal('yesterday'),
            Type.Literal('week'),
            Type.Literal('month'),
          ],
          {
            description:
              "Range to sync for action=sync: 'today'/'yesterday' (default 'today'), or 'week'/'month' for the last 7/30 days (each day filtered independently, so recurring meetings still resolve to the right day's transcript)",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === 'pendingSummaries') {
        if (!params.dir)
          throw new Error('dir is required for action=pendingSummaries')
        const result = await findPendingSummaries(params.dir)
        const projectsDir = await resolveProjectsDir(ctx.cwd)
        const formatGuidance = projectsDir
          ? `${SUMMARY_FORMAT_GUIDANCE}\n\n${buildProjectCrosslinkGuidance(projectsDir)}`
          : SUMMARY_FORMAT_GUIDANCE
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...result, formatGuidance }, null, 2),
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
        const range: SyncRange = params.day || 'today'
        const result = await syncTranscriptsRange({
          userId,
          outDir,
          range,
          timeZone,
          format: 'text/vtt',
        })
        const lines = [
          `# Teams Transcript Sync (${range}, ${timeZone})`,
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

  pi.registerCommand('teams-transcript-push', {
    description:
      'Push synced meeting notes and raw transcripts from outDir into the ZenNotes workspace vault (inbox/Meetings, inbox/Meetings/vtt) via the zn CLI. Requires znServer/znToken in config or ZENNOTES_* env vars. Usage: /teams-transcript-push [dir]',
    handler: async (args, ctx) => {
      const [argDir] = args.trim().split(/\s+/).filter(Boolean)
      const dir = await resolveTranscriptsDir(ctx.cwd, argDir)
      const { server, token } = await resolveConfiguredZn(ctx.cwd)
      if (!server || !token) {
        ctx.ui.notify(
          'No ZenNotes server configured. Set znServer/znToken in pi-teams-transcript/config.json (global or project), or the ZENNOTES_SERVER / ZENNOTES_REMOTE_TOKEN env vars.',
          'warning',
        )
        return
      }
      ctx.ui.notify(`Pushing from ${dir} to ${server}...`, 'info')
      try {
        const lines = await pushStagingToZn(dir, createZnRunner(server, token))
        ctx.ui.notify(
          lines.length ? lines.join('\n') : `Nothing to push in ${dir}.`,
          'info',
        )
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`push failed: ${msg}`, 'error')
      }
    },
  })

  pi.registerCommand('teams-transcript-sync', {
    description:
      'Fetch Teams meeting transcripts into a folder, skipping already-downloaded ones. Usage: /teams-transcript-sync [today|yesterday|week|month]',
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
        {
          value: 'week',
          label: 'week',
          description: 'Sync the last 7 days',
        },
        {
          value: 'month',
          label: 'month',
          description: 'Sync the last 30 days',
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
      const range: SyncRange =
        argDay === 'yesterday' || argDay === 'week' || argDay === 'month'
          ? argDay
          : 'today'
      const userId = await resolveConfiguredUserId(ctx.cwd)
      if (!userId) {
        ctx.ui.notify(
          'No userId configured. Set "userId" in pi-teams-transcript/config.json (global or project), or the TEAMS_USER_ID env var.',
          'warning',
        )
        return
      }
      pi.sendUserMessage(
        `Call the teams_transcript tool with action="sync", day="${range}".`,
      )
    },
  })

  pi.registerCommand('teams-transcript-summarize', {
    description:
      'Find synced transcripts whose .md stub is still missing its summary sections and have the agent fill them in. Usage: /teams-transcript-summarize [dir]',
    handler: async (args, ctx) => {
      const [argDir] = args.trim().split(/\s+/).filter(Boolean)
      const dir = await resolveTranscriptsDir(ctx.cwd, argDir)
      const result = await findPendingSummaries(dir)

      if (result.pending.length === 0) {
        ctx.ui.notify(
          `No pending transcripts in ${dir} — all ${result.alreadyDone} transcript(s) already have a filled-in summary.`,
          'info',
        )
        return
      }

      ctx.ui.notify(
        `Summarizing ${result.pending.length} transcript(s) in ${dir}...`,
        'info',
      )
      const projectsDir = await resolveProjectsDir(ctx.cwd)
      const projectGuidance = projectsDir
        ? `\n\n${buildProjectCrosslinkGuidance(projectsDir)}`
        : ''
      // AIDEV-NOTE: no LLM-calling API is exposed to command handlers either —
      // hand the pending file list + format spec to the running agent via
      // sendUserMessage, and let it read/summarize/write each one with its
      // own tools (mirrors the pendingSummaries tool action's approach).
      pi.sendUserMessage(
        `Summarize these Teams transcripts. ${SUMMARY_FORMAT_GUIDANCE}${projectGuidance}\n\nFiles:\n${result.pending.map((p) => `- ${p}`).join('\n')}`,
      )
    },
  })

  pi.registerCommand('teams-transcript-weekly', {
    description:
      "Synthesize the most recently *finished* Mon-Fri work week's meeting notes into a weekly report. Usage: /teams-transcript-weekly",
    handler: async (_args, ctx) => {
      const weeklyDir = await resolveWeeklyDir(ctx.cwd)
      if (!weeklyDir) {
        ctx.ui.notify(
          'No "weekly" directory configured. Set "weekly" in pi-teams-transcript/config.json (global or project) to a path for weekly reports.',
          'warning',
        )
        return
      }
      const outDir = await resolveTranscriptsDir(ctx.cwd)
      const timeZone = await resolveConfiguredTimezone(ctx.cwd)
      const { monday, friday, weekLabel } = targetWeekBounds(timeZone)
      const reportPath = path.join(weeklyDir, `${weekLabel}.md`)

      try {
        await fs.access(reportPath)
        ctx.ui.notify(
          `${weekLabel} already exists at ${reportPath} — skipping (a finished week is never regenerated).`,
          'info',
        )
        return
      } catch {
        // doesn't exist yet, proceed
      }

      const meetings = await findWeekMeetings(outDir, monday, friday)
      if (meetings.length === 0) {
        ctx.ui.notify(
          `No recordings found for ${monday} to ${friday} (${weekLabel}). Nothing to synthesize. ` +
            'Ask me to check a different week if you want a wider look.',
          'info',
        )
        return
      }

      await fs.mkdir(weeklyDir, { recursive: true })
      const lightWeekNote =
        meetings.length <= 2
          ? `\n\nLight week — only ${meetings.length} recording(s). Still worth a brief, just shorter; don't dismiss it.`
          : ''
      ctx.ui.notify(
        `Synthesizing ${weekLabel} (${monday} to ${friday}, ${meetings.length} meeting(s)) → ${reportPath}`,
        'info',
      )
      const projectsDir = await resolveProjectsDir(ctx.cwd)
      const projectGuidance = projectsDir
        ? `\n\n${buildProjectCrosslinkGuidance(projectsDir)} Also link the weekly report itself ` +
          `into each touched project's \`## Meetings\` section (e.g. \`- [[${weekLabel}]] weekly recap\`), ` +
          'and add a `## Projects` bullet list of `[[Project Name]]` links to the weekly report itself.'
        : ''
      // AIDEV-NOTE: same hand-off pattern as sync/summarize — no LLM-calling API
      // in command handlers, so the running agent does the actual synthesis
      // with its own read/write tools.
      pi.sendUserMessage(
        `Write the weekly synthesis for ${weekLabel} (${monday} to ${friday}) to ${reportPath}.${lightWeekNote}\n\n${WEEKLY_FORMAT_GUIDANCE}${projectGuidance}\n\n` +
          `This week's meeting notes:\n${meetings.map((m) => `- ${m.path}${m.hasSummary ? '' : ' (missing summary — fill in first)'}`).join('\n')}\n\n` +
          `For decision-arc history, also check other .md notes in ${outDir} from the last 30 days.`,
      )
    },
  })
}
