# pi-teams-transcript

> ⚠️ **Work in progress.** App-only Graph access to `/onlineMeetings` also requires a Teams-side Application Access Policy per organizer (see below) — this is easy to get wrong and the error messages are not obvious. Expect rough edges.

Pi extension exposing a `teams_transcript` tool that lists and downloads Microsoft Teams meeting transcripts via the Microsoft Graph API, using app-only (client credentials) auth.

## Prerequisites

### 1. Azure AD app registration (Entra portal)

App registration with these **application** permissions, admin-consented (Entra ID → App registrations → your app → API permissions → Add → Application permissions → grant admin consent):

- `OnlineMeetingTranscript.Read.All`
- `OnlineMeetings.Read.All`
- `Calendars.Read` — needed for `action=listMeetings`

Grab these from the app's Overview page for the env vars below:

- **Directory (tenant) ID** → `TEAMS_TENANT_ID`
- **Application (client) ID** → `TEAMS_CLIENT_ID`
- **Client secret** → Certificates & secrets → New client secret → copy the **Value** (shown once) → `TEAMS_CLIENT_SECRET`

### 2. Teams Application Access Policy (PowerShell only — not in Entra portal)

Graph admin consent is not enough for `/onlineMeetings` and `/onlineMeetings/{id}/transcripts` — Teams additionally enforces an **Application Access Policy** per user whose meetings you query. There is no Entra/Teams-admin-center UI for this; it's PowerShell-only, via the `MicrosoftTeams` module (cross-platform, works fine on Linux via `pwsh`).

```bash
# Arch Linux example
yay -S powershell-bin
pwsh
```

```powershell
Install-Module MicrosoftTeams -Scope CurrentUser -Force
Import-Module MicrosoftTeams

# If local browser launch fails (e.g. missing/broken xdg-open), use device-code login instead:
Connect-MicrosoftTeams -UseDeviceAuthentication

# Create the policy once, referencing your app's client ID
New-CsApplicationAccessPolicy -Identity "TranscriptAppPolicy" -AppIds "<TEAMS_CLIENT_ID>" -Description "Allow transcript app"

# Grant it for every organizer whose meetings you want to query
Grant-CsApplicationAccessPolicy -PolicyName "TranscriptAppPolicy" -Identity <organizer-upn>
```

Verify a grant landed:

```powershell
Get-CsApplicationAccessPolicy -Identity "TranscriptAppPolicy"
Get-CsOnlineUser -Identity <organizer-upn> | Select-Object -ExpandProperty ApplicationAccessPolicy
```

Policy changes can take **up to 15-30 minutes** to propagate — a `403`/`forbidden` with `"No application access policy found for this app ... on the user"` right after granting usually just means "wait and retry", not a misconfiguration.

If you only know a user's Entra object ID (e.g. from a meeting's `joinUrl` context) and need their UPN to grant the policy:

```powershell
Get-CsOnlineUser -Identity <object-id> | Select-Object UserPrincipalName
```

## Configuration

Secrets via environment variables (no config file):

| Env var | Description |
|---|---|
| `TEAMS_TENANT_ID` | Azure AD tenant ID |
| `TEAMS_CLIENT_ID` | App registration client ID |
| `TEAMS_CLIENT_SECRET` | App registration client secret |

Non-secret settings live in `~/.pi/agent/pi-teams-transcript/config.json`.

| Option | Type | Default | Description |
|---|---|---|---|
| `outDir` | `string` | `./teams-transcripts` | Directory to write downloaded transcripts to. Relative paths resolve from cwd. |
| `userId` | `string` | none | Default meeting organizer's user ID or UPN, used by `/teams-transcript-sync` when not set via the `TEAMS_USER_ID` env var. |

```json
{
  "$schema": "./config.schema.json",
  "outDir": "./teams-transcripts",
  "userId": "you@example.com"
}
```

## Tool: `teams_transcript`

| Parameter | Type | Description |
|---|---|---|
| `action` | `'listMeetings' \| 'list' \| 'get'` | List recent meetings, list transcripts for a meeting, or download one |
| `userId` | `string` | Meeting organizer's user ID or UPN (app-only auth has no "me", always required) |
| `meetingId` | `string?` | The `onlineMeeting` ID (required for list/get unless `joinUrl` given) |
| `joinUrl` | `string?` | Meeting joinUrl from `listMeetings`, resolved to a `meetingId` internally |
| `transcriptId` | `string?` | Required for `action=get` |
| `format` | `string?` | Content format for `action=get`, default `text/vtt` |
| `top` | `integer?` | Number of recent meetings for `action=listMeetings`, default 10 |

### Flow

1. `action: 'listMeetings'` → `GET /users/{userId}/calendarView?startDateTime=...&endDateTime=...&$orderby=start/dateTime desc&$top=<top*5>` (app-only calls reject `$filter=isOnlineMeeting eq true` with a 400, so results are filtered client-side for non-all-day events that have a joinUrl; `calendarView` is used instead of `/events` so recurring meetings expand into real per-day occurrences instead of only the series master) — returns subject/start/joinUrl to pick from.
2. `action: 'list'` with the picked `joinUrl` (resolved via `GET /users/{userId}/onlineMeetings?$filter=JoinWebUrl eq '...'`) or a known `meetingId` → `GET /users/{userId}/onlineMeetings/{meetingId}/transcripts`
3. `action: 'get'` with a `transcriptId` from step 2 → `GET .../transcripts/{transcriptId}/content?$format=text/vtt`

You still need the organizer's `userId` — app-only auth has no delegated "me" context. UPNs are resolved to Entra object IDs internally and cached, since `/onlineMeetings` rejects UPNs directly.

## Command: `/teams-transcript-sync`

`/teams-transcript-sync [today|yesterday]`

Scans the calendar for the given day (default `today`) via `/calendarView` (so recurring meetings expand into real occurrences), and for each non-all-day meeting with a transcript, downloads it into `outDir` as `<date>_<slugified-subject>__<transcriptId>.vtt`. Re-running the command **skips files that already exist on disk** — no manifest, the filename itself is the idempotency key. Cancelled meetings are reported but skipped (never had a call, so never have a transcript).

```
/teams-transcript-sync
/teams-transcript-sync yesterday
```

Tab-complete on the `today`/`yesterday` argument. `userId` comes from config `userId`, else `TEAMS_USER_ID` env var — required, no positional arg anymore. `outDir` comes from config, else `./teams-transcripts`.

Ends with a report table (subject, start, `meetingId`, status — `downloaded`/`already-synced`/`no-transcript`/`cancelled`/`error`) for every meeting that day.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `403 ErrorAccessDenied` on `listMeetings` | Missing `Calendars.Read` application permission, or a cached token issued before you granted it | Add the permission + admin consent, then **restart the pi session** (the access token is cached in-memory for ~1h and won't pick up new permissions until refetched) |
| `403 forbidden: "No application access policy found for this app ... on the user"` | Teams Application Access Policy not granted for that organizer, or not yet propagated | Run `Grant-CsApplicationAccessPolicy` for that organizer (see above), wait 15-30 min |
| `403 forbidden: "3003: User does not have access to lookup meeting"` | Policy is granted, but only for a *different* organizer than the one in this joinUrl | Grant the policy for that meeting's actual organizer too |
| `@odata.count: 0` from `action=list` | No transcript exists for that meeting (transcription wasn't enabled/recorded) | Nothing to fetch — try a different meeting |

## Reference

- [Microsoft Graph `callTranscript` resource](https://learn.microsoft.com/en-us/graph/api/resources/calltranscript?view=graph-rest-1.0)
- [Application access policy for Teams meeting APIs](https://learn.microsoft.com/en-us/graph/cloud-communication-online-meeting-application-access-policy)
