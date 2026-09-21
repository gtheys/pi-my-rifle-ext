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
| `timezone` | `string` | system timezone | IANA timezone (e.g. `Asia/Bangkok`) used for day boundaries (today/yesterday) and displayed meeting times in the sync report. |
| `weekly` | `string` | none | Directory to write `/teams-transcript-weekly` reports to. Required for that command — no default, since it's a deliberate separate folder. |
| `projects` | `string` | none | Directory of one `.md` file per project (e.g. an Obsidian vault `Projects` folder). When set, `/teams-transcript-summarize` and `/teams-transcript-weekly` cross-link meeting/weekly notes with matching project notes. Optional — skipped entirely when unset. |
| `znServer` | `string` | none | ZenNotes server base URL (e.g. `http://100.108.226.64:8089`) that `/teams-transcript-push` targets for the workspace vault. Env `ZENNOTES_SERVER` overrides. |
| `znToken` | `string` | none | Auth token for `znServer`, used by `/teams-transcript-push`. Env `ZENNOTES_REMOTE_TOKEN` overrides. |

```json
{
  "$schema": "./config.schema.json",
  "outDir": "./teams-transcripts",
  "userId": "you@example.com",
  "timezone": "Asia/Bangkok",
  "weekly": "./teams-transcripts/weekly",
  "projects": "/home/you/ZenVault/Projects",
  "znServer": "http://100.108.226.64:8089",
  "znToken": "your-token"
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

`/teams-transcript-sync [today|yesterday|week|month]`

Scans the calendar for the given range (default `today`) via `/calendarView` (so recurring meetings expand into real occurrences), and for each non-all-day meeting with a transcript, downloads the raw transcript into `outDir/vtt/` and writes the `.md` note into `outDir` itself, both as `<date>_<slugified-subject>__<transcriptId>.<ext>` (only the `.vtt`/`.md` extension differs). Re-running the command **skips files that already exist on disk** — no manifest, the filename itself is the idempotency key. Cancelled meetings are reported but skipped (never had a call, so never have a transcript).

`week`/`month` sync the last 7/30 days, one day at a time (same logic as `today`/`yesterday`, just repeated) — each day keeps its own transcript-date filter, so a recurring meeting's shared onlineMeeting object still only contributes the transcript that actually belongs to that day, not the whole series' history.

```
/teams-transcript-sync
/teams-transcript-sync yesterday
/teams-transcript-sync week
/teams-transcript-sync month
```

Tab-complete on the `today`/`yesterday`/`week`/`month` argument. `userId` comes from config `userId`, else `TEAMS_USER_ID` env var — required, no positional arg anymore. `outDir` comes from config, else `./teams-transcripts`.

The command hands off to the agent (`action="sync"` on the `teams_transcript` tool) instead of running the sync itself, so the report renders themed and colored — same mechanism as built-in tools like `read`/`write` (green=downloaded, dim=no transcript, yellow=cancelled, red=error). A command's own `ctx.ui.notify` has no per-line styling API, only the tool-call rendering pipeline does. One line per meeting: local time, subject, status, truncated `meetingId`.

Per-meeting status values: `downloaded`/`already-synced` (green), `no-transcript`/`not-started` (nothing there — `not-started` means the occurrence hasn't happened yet, checked before any Graph call so it's free), `not-organizer` (you're not that meeting's organizer, so the app access policy doesn't cover it — expected for meetings you only attend), `cancelled` (yellow), `error` (red, unexpected).

Sync also writes a sibling `.md` for each downloaded transcript, pre-filled with Obsidian frontmatter (`title`/`date`/`attendees`, from the calendar event), a matching `# title` / Date / Attendees header, and the full `## Transcript` section — all deterministic, no LLM involved. Only the Summary/Decisions/Action Items/Open Questions/Commitments sections are left for `/teams-transcript-summarize` to fill in.

Attendee names render as Obsidian wikilinks throughout the file: full names as `[[Geert Theys]]`, short mentions (e.g. a transcript speaker labeled `Geert`) as alias links `[[Geert Theys|Geert]]` that target the full attendee name from the header. Asian names that carry a bracketed nickname — `Lam [Liam] Pham` — are normalized to `[[Lam Pham|Liam]]` (brackets dropped from the full name, nickname becomes the visible alias), applied everywhere the person appears. Zero-width spaces that leak into some Graph names are stripped. Frontmatter `attendees` stays plain strings (structured properties); only the visible header and transcript/summary prose use the links.

## Command: `/teams-transcript-summarize`

`/teams-transcript-summarize [dir]`

Scans `dir` (default: same as sync's `outDir`) for transcripts whose `.md` stub doesn't have a `## Summary` section yet, then has the agent read each one and insert Summary/Decisions/Action Items/Open Questions/Commitments between the existing header and `## Transcript` — the frontmatter, title/date/attendees header, and transcript itself are never touched or regenerated. Person names in the inserted sections use the same Obsidian wikilink convention as the transcript (short names resolve to the full attendee name via an alias link).

If a `.vtt` in `outDir/vtt/` has no `.md` at all in `outDir` (dropped in manually, or synced before this existed), a stub is bootstrapped first from the file itself: attendees from the distinct `<v Name>` speakers in the VTT, date from the filename's `YYYY-MM-DD` prefix or file mtime, title de-slugified from the filename. Drop manually-added `.vtt` files into `outDir/vtt/`, same as synced ones.

```
/teams-transcript-summarize
/teams-transcript-summarize ./notes/transcripts
```

### Project cross-linking

When `projects` is configured, both this command and `/teams-transcript-weekly` scan that folder for a `.md` file matching any project discussed in the meeting (by filename or `# Title` heading). If found, the agent links the meeting note to it and adds a bullet to the project note's `## Meetings` section pointing back, matching the existing `# Title` / `## Status` / `## Meetings` convention. If the project's one-line description (right under `# Title`) is stale, it's refreshed; if no matching project note exists, one is created with a short description synthesized from the meeting. `/teams-transcript-weekly` additionally links the weekly report itself into each touched project's `## Meetings` section. Never invents a project that wasn't actually discussed.

## Command: `/teams-transcript-weekly`

`/teams-transcript-weekly`

Synthesizes the most recently *finished* Mon-Fri work week's meeting notes into one report, written to `weekly/<isoyear>-w<isoweek>.md` (e.g. `2026-w31.md`). No arguments — it always targets the last finished work week: while "today" still falls inside the current Mon-Fri span, that week isn't over, so it targets the previous week instead; once today is Sat/Sun, the week that just ended becomes the target. If that week's report file already exists, the command skips — permanently, since a target week is never re-touched once finished.

```
/teams-transcript-weekly
```

Zero recordings for that week is reported directly (no LLM call, no file written) rather than hallucinating a summary. Otherwise it hands off to the agent (same mechanism as sync/summarize) to: fill in any of that week's notes still missing a summary, then write Themes → Decision Arcs (cross-references the last 30 days of notes for the same topic, flags STABLE/VOLATILE/CONFLICTING/NEW) → Action Item Audit (open/completed/overdue — overdue needs a `(due YYYY-MM-DD)` on the action item, see below — /assigned-to-others) → Commitments (from each note's existing `## Commitments` section) → Attention Monday → a short closing reflection.

`/teams-transcript-summarize`'s Action Items now capture an optional due date — `- [ ] [[Owner]]: task (due 2026-08-10)` — only when the transcript actually states one (relative dates like "by Friday" get converted to an absolute date using the note's own date as reference); never invented. This is what lets the weekly Action Item Audit classify overdue vs. open.

## Command: `/teams-transcript-push`

`/teams-transcript-push [dir]`

Pushes synced meeting notes (`.md`) and raw transcripts (`.vtt` from `outDir/vtt/`) into a remote ZenNotes workspace vault via the `zn` CLI (installed from the ZenNotes app, Settings → CLI): notes land in `inbox/Meetings`, transcripts as notes in `inbox/Meetings/vtt`. Idempotent — each file is dedup-checked against the vault by full path, then moved to `outDir/pushed/` so re-runs are no-ops. Requires `znServer`/`znToken` in config or the `ZENNOTES_SERVER`/`ZENNOTES_REMOTE_TOKEN` env vars.

```
/teams-transcript-sync week
/teams-transcript-push
```

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `403 ErrorAccessDenied` on `listMeetings` | Missing `Calendars.Read` application permission, or a cached token issued before you granted it | Add the permission + admin consent, then **restart the pi session** (the access token is cached in-memory for ~1h and won't pick up new permissions until refetched) |
| `403 forbidden: "No application access policy found for this app ... on the user"` | Teams Application Access Policy not granted for that organizer, or not yet propagated | Run `Grant-CsApplicationAccessPolicy` for that organizer (see above), wait 15-30 min |
| `403 forbidden: "3003: User does not have access to lookup meeting"` | Policy is granted, but only for a *different* organizer than the one in this joinUrl | Grant the policy for that meeting's actual organizer too |
| `@odata.count: 0` from `action=list` | No transcript exists for that meeting (transcription wasn't enabled/recorded) | Nothing to fetch — try a different meeting |
| `403 Forbidden: "Speaker-attributed transcript content is disabled for this tenant"` (`SpeakerAttributionNotAllowed`) | Tenant admin turned off the **Speaker attribution** meeting setting | Handled automatically: the tool retries with the vendor content-type Graph's own error names (`application/vnd.microsoft.graph.transcript+text`), which has no per-speaker `<v Name>` tags. Those cues render without an Obsidian wikilink (just `` `time` text ``) since there's no speaker to link. See below to have the admin turn it back on |
| `403 Forbidden: "Graph API access to transcripts is disabled for this tenant"` (`GraphAccessToTranscriptsDisabled`) | Tenant admin turned off the **Graph API access to transcripts** setting — the master switch, separate from speaker attribution | No workaround, not even metadata (`action=list`) works. Admin must re-enable it (same two settings below) |

### Tenant admin controls for transcript access (as MS admin)

Two *independent* Teams tenant settings gate this whole API, both configured via Teams Admin Center or the `Set-CsTeamsMeetingConfiguration` PowerShell cmdlet (verified against [Microsoft's own docs](https://learn.microsoft.com/en-us/graph/api/calltranscript-get?view=graph-rest-1.0), not the Teams client UI — what a meeting participant sees in Teams is governed separately and does **not** reflect what this API can fetch):

1. **Graph API access to transcripts** — master switch. Off = every transcript request 403s (`GraphAccessToTranscriptsDisabled`), no format-level workaround.
2. **Speaker attribution** — narrower. Off = only the attributed format (`text/vtt`) 403s (`SpeakerAttributionNotAllowed`); the unattributed format (`application/vnd.microsoft.graph.transcript+text`) still works, which is exactly the fallback this tool already uses automatically.

```powershell
pwsh
Connect-MicrosoftTeams   # or -UseDeviceAuthentication
Get-CsTeamsMeetingConfiguration | Select-Object *SpeakerAttribution*, *Transcript*
Set-CsTeamsMeetingConfiguration -<ExactParamFromAbove> $true
```

This is evaluated live against the *current* setting on every request, not baked in at recording time — flipping it back on should restore `text/vtt` for old transcripts too, not just new ones (allow the usual 15-30 min propagation delay, then re-verify with a real fetch, not the Teams client display).

## Reference

- [Microsoft Graph `callTranscript` resource](https://learn.microsoft.com/en-us/graph/api/resources/calltranscript?view=graph-rest-1.0)
- [Get callTranscript — tenant administrator controls for transcript access](https://learn.microsoft.com/en-us/graph/api/calltranscript-get?view=graph-rest-1.0)
- [Application access policy for Teams meeting APIs](https://learn.microsoft.com/en-us/graph/cloud-communication-online-meeting-application-access-policy)
