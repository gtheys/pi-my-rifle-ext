---
name: teams-pr-notify
description: >-
  Send a PR review request notification to a Microsoft Teams channel via a
  Power Automate flow. Posts an Adaptive Card with the PR title, key facts
  (number, repo, base branch, Jira ticket), a short summary, and action buttons.
  Trigger when the user says "notify teams", "send PR to teams", "share PR in
  teams", "post PR review to teams", "tell teams about this PR", or similar.
  Works for any PR the user has just created or wants to surface for review.
---

# Teams PR Review Notification

Posts an Adaptive Card to a Microsoft Teams channel through a Power Automate
"manual trigger" flow. The flow accepts a JSON Adaptive Card payload and
forwards it to the configured channel.

## Prerequisites

- `curl` installed.
- A Power Automate flow with a **manual trigger** (When an HTTP request is
  received) wired to a "Post message in a chat or channel" Teams action. The
  trigger's `POST` URL contains a `sig=...` query param that authenticates the
  request — no OAuth or Graph permissions needed.
- The flow's trigger URL stored in the environment variable
  `TEAMS_PR_WEBHOOK_URL`. **Never hardcode the URL or `sig` in committed files.**

If `TEAMS_PR_WEBHOOK_URL` is not set, ask the user for the flow trigger URL
once and store it as an env var. Example URL shape (the `sig` is the secret):

```
https://<tenant>.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/<guid>/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=<SECRET>
```

## Payload format

Power Automate manual triggers accept an Adaptive Card wrapped in a Teams
message envelope (NOT a raw `{ "text": "..." }` body). Reference:
https://support.microsoft.com/en-US/Workflows/send-messages-in-teams-using-incoming-webhooks

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "contentUrl": null,
      "content": {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.2",
        "body": [ /* TextBlock / FactSet blocks */ ],
        "actions": [ /* Action.OpenUrl buttons */ ]
      }
    }
  ]
}
```

Power Automate returns **HTTP 202 Accepted** with an empty body for a successful
trigger. It does NOT validate the card shape until the flow runs — a malformed
card surfaces in the flow's run history, not the HTTP response.

## Workflow

### Step 1 — Gather PR facts

If the user just created the PR (typical), the values are already known from the
session. Otherwise, derive them from the current repo:

```bash
git remote get-url origin          # repo owner/name
git branch --show-current          # head branch
GH_PAGER=cat gh pr view --json number,title,url,baseRefName 2>/dev/null
```

Collect: **PR number, title, URL, repo name, base branch, Jira ticket ID**
(extract from the title or branch via the `[A-Z]+-\d+` regex).

### Step 2 — Write a 1–2 sentence summary

Read the PR description (`gh pr view <n> --json body`) and the diff stat, then
write a terse plain-text summary: what changed and why. Max ~280 chars so it fits
in one `TextBlock` line with `wrap: true`. No markdown in the summary — Adaptive
Cards use their own markup.

### Step 3 — Build the Adaptive Card

Assemble the card body. Standard layout:

- **Header `TextBlock`**: "PR Review Request" (`size: Medium`, `weight: Bolder`).
- **Title `TextBlock`**: the PR title (`wrap: true`).
- **`FactSet`**: PR #, Repo, Base, Jira (one fact each).
- **Summary `TextBlock`**: the summary from Step 2 (`wrap: true`, `isSubtle: true`).
- **`actions`**: two `Action.OpenUrl` buttons — "Review PR" (PR URL) and
  "Jira Ticket" (Jira URL, `https://salaryhero.atlassian.net/browse/<TICKET>`).

If the user's Jira instance lives elsewhere, swap the URL prefix. If there's no
Jira ticket, omit the Jira fact and the Jira button.

### Step 4 — POST to the flow

Write the payload to a temp file, then `curl`:

```bash
cat > /tmp/teams-pr-card.json <<'JSON'
{ /* the payload from Step 3 */ }
JSON

curl -sS -X POST "$TEAMS_PR_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d @/tmp/teams-pr-card.json \
  -w "\n[HTTP %{http_code}] %{time_total}s\n"
rm -f /tmp/teams-pr-card.json
```

### Step 5 — Report

Confirm HTTP 202 to the user. Tell them the card lands asynchronously (a few
seconds to ~30s depending on the flow). If the response is NOT 202:

| Code | Likely cause |
|------|--------------|
| 401 / 403 | Wrong or expired `sig`; regenerate the trigger URL in Power Automate. |
| 404 | Wrong workflow ID in the URL; the flow was renamed/deleted. |
| 400 | Malformed JSON payload. |

If 202 but the card never appears in Teams, the Adaptive Card JSON is invalid —
check the flow's run history in the Power Automate portal.

## Template — full Adaptive Card

Use this as the starting point and fill in the placeholders:

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "contentUrl": null,
      "content": {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.2",
        "body": [
          {
            "type": "TextBlock",
            "text": "PR Review Request",
            "size": "Medium",
            "weight": "Bolder"
          },
          {
            "type": "TextBlock",
            "text": "<PR TITLE>",
            "wrap": true
          },
          {
            "type": "FactSet",
            "facts": [
              { "title": "PR:", "value": "#<NUMBER>" },
              { "title": "Repo:", "value": "<REPO>" },
              { "title": "Base:", "value": "<BASE_BRANCH>" },
              { "title": "Jira:", "value": "<TICKET_ID>" }
            ]
          },
          {
            "type": "TextBlock",
            "text": "<ONE-TWO SENTENCE SUMMARY>",
            "wrap": true,
            "isSubtle": true
          }
        ],
        "actions": [
          {
            "type": "Action.OpenUrl",
            "title": "Review PR",
            "url": "<PR_URL>"
          },
          {
            "type": "Action.OpenUrl",
            "title": "Jira Ticket",
            "url": "https://salaryhero.atlassian.net/browse/<TICKET_ID>"
          }
        ]
      }
    }
  ]
}
```

## Notes

- **No Graph permissions required.** Unlike the `m365 teams message send`
  command (which needs `ChannelMessage.Send` + `Team.ReadBasic.All` consent),
  this approach only needs the flow's `sig` token. Works even when the m365 CLI
  app registration lacks delegated scopes.
- **The `sig` is a secret.** Store in `TEAMS_PR_WEBHOOK_URL` or a password
  manager — never commit it. If it leaks, regenerate via Power Automate
  (the flow's trigger → "Click to download" / "Show URL").
- **One channel per flow.** To post to a different channel, point a new flow at
  it and use that flow's URL instead. The skill is channel-agnostic.
- **Adaptive Card version 1.2** is the safe baseline for Teams. Higher versions
  work but may not render on older Teams clients.
