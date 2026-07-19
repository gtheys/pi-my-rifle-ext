import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from '@sinclair/typebox'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

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
  // AIDEV-NOTE: Graph /events does not support $filter on isOnlineMeeting for
  // app-only calls (400 ErrorInvalidProperty). Fetch recent events ordered by
  // start desc and filter client-side for ones with an onlineMeeting join URL.
  const fetchCount = Math.max(top * 5, 50)
  const res = await graphFetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(userId)}/events?$orderby=start/dateTime desc&$top=${fetchCount}&$select=subject,start,end,onlineMeeting`,
  )
  const data = (await res.json()) as {
    value?: Array<{
      subject?: string
      start?: { dateTime?: string }
      onlineMeeting?: { joinUrl?: string }
    }>
  }
  return (data.value || [])
    .filter((e) => e.onlineMeeting?.joinUrl)
    .slice(0, top)
    .map((e) => ({
      subject: e.subject,
      start: e.start?.dateTime,
      joinUrl: e.onlineMeeting?.joinUrl,
    }))
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'teams_transcript',
    label: 'Teams Meeting Transcript',
    description:
      'List calendar meetings, list transcripts, or download transcript content for Microsoft Teams meetings via Microsoft Graph (app-only auth).',
    promptSnippet:
      'List/download Teams meeting transcripts via Microsoft Graph.',
    promptGuidelines: [
      'Use action=listMeetings to find recent meetings and their joinUrl when meetingId is unknown.',
      'Use action=list (with meetingId or joinUrl) to discover transcriptId values for a meeting.',
      'Use action=get with a transcriptId to download transcript content (VTT or plain text).',
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal('listMeetings'),
          Type.Literal('list'),
          Type.Literal('get'),
        ],
        {
          description:
            "'listMeetings' recent calendar meetings for a user, 'list' transcripts for a meeting, or 'get' transcript content",
        },
      ),
      userId: Type.String({
        description: "Organizer's user ID or UPN (e.g. user@contoso.com)",
      }),
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
    }),
    async execute(_toolCallId, params) {
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
  })
}
