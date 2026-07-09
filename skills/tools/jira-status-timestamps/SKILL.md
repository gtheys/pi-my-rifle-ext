---
description: Set up Jira status-entry timestamps using custom datetime fields and Automation rules. Stamps the exact moment each ticket transitions into a workflow status (Requirement & Design At, In Development At, etc.). Includes field creation, automation rule generation, and import workflow for SalaryHero projects (Solutions, DevOps).
---

# Skill: jira-status-timestamps

## Trigger phrases

- "add status timestamps to X board"
- "create time-in-status fields for X project"
- "stamp when tickets enter each status"
- "measure transition time between statuses"
- "set up Done At / In Development At fields"

---

## Prerequisites

| What | Where |
|---|---|
| `JIRA_API_TOKEN` | env var |
| Jira email | ask user if unknown; SalaryHero = `geert@salary-hero.com` |
| Target project key | ask user (e.g. `IN` = Solutions, `DP` = DevOps) |

---

## Step 1 — Discover project key and statuses

```bash
# Find project key
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "https://salaryhero.atlassian.net/rest/api/3/project/search?query=<name>" \
  | jq '.values[] | {key, name}'

# Get actual status names (title case, NOT board display ALL CAPS)
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
  "https://salaryhero.atlassian.net/rest/api/3/project/<KEY>/statuses" \
  | jq '[.[].statuses[].name] | unique | sort'
```

> **Important:** Always use the API status names, not the board column labels. Board shows `IN DEVELOPMENT`; API returns `In Development`.

---

## Step 2 — Create custom datetime fields via REST API

```bash
BASE="https://salaryhero.atlassian.net"
AUTH="$JIRA_EMAIL:$JIRA_API_TOKEN"

FIELDS=(
  "Solutions - Requirement & Design At"
  "Solutions - In Development At"
  # ... one per status to stamp
)

for FIELD in "${FIELDS[@]}"; do
  curl -s -X POST \
    -u "$AUTH" \
    -H "Content-Type: application/json" \
    "$BASE/rest/api/3/field" \
    -d "{
      \"name\": \"$FIELD\",
      \"type\": \"com.atlassian.jira.plugin.system.customfieldtypes:datetime\",
      \"searcherKey\": \"com.atlassian.jira.plugin.system.customfieldtypes:datetimerange\"
    }" | jq '{id, name}'
done
```

Record the `customfield_XXXXX` IDs returned — needed for automation rules.

---

## Step 3 — Get cloud ID and project ARI

```bash
# Cloud ID
curl -s -u "$AUTH" "https://salaryhero.atlassian.net/_edge/tenant_info" | jq .cloudId

# Project numeric ID
curl -s -u "$AUTH" "https://salaryhero.atlassian.net/rest/api/3/project/<KEY>" | jq .id

# Project ARI = ari:cloud:jira:<cloudId>:project/<projectId>
```

---

## Step 4 — Generate automation rules import JSON

Use this Python script. Fill in `statuses` list from Step 1 and field names from Step 2.

```python
import json, uuid, copy

# Template: export ANY existing working rule from the target site first.
# Save it as base_rule.json, then:
with open("base_rule.json") as f:
    base_rule = json.load(f)["rules"][0]

CLOUD_ID = "<cloudId>"
PROJECT_ARI = f"ari:cloud:jira:{CLOUD_ID}:project/<projectId>"

# (status_name_from_api, field_display_name)
statuses = [
    ("Requirement & Design", "Solutions - Requirement & Design At"),
    ("In Development",       "Solutions - In Development At"),
    # ...
]

rules = []
for i, (status_name, field_name) in enumerate(statuses, start=1):
    r = copy.deepcopy(base_rule)
    r["id"]          = 9000000 + i    # unique fake int; Jira reassigns on import
    r["idUuid"]      = str(uuid.uuid4())
    r["name"]        = field_name
    r["checksum"]    = None
    r["currentVersionId"] = None
    r["tags"]        = []
    r["state"]       = "ENABLED"

    t = r["trigger"]
    t["id"] = str(uuid.uuid4())
    t["value"]["fromStatus"] = []
    t["value"]["toStatus"]   = [{"type": "NAME", "value": status_name}]
    t["checksum"] = None

    a = r["components"][0]
    a["id"] = str(uuid.uuid4())
    a["value"]["operations"][0]["field"]["value"] = field_name
    a["checksum"] = None
    rules.append(r)

out_str = json.dumps({"cloud": True, "rules": rules}, indent=2).replace("&", r"\u0026")
with open("automation-rules.json", "w") as f:
    f.write(out_str)
```

### Critical gotchas

| Problem | Cause | Fix |
|---|---|---|
| Only last rule imports | `id: null` — all deduped to one | Use unique fake integers (`9000001`, `9000002`, …) |
| Parse error on `&` | Jira's import parser chokes on raw `&` | `.replace("&", r"\u0026")` after `json.dumps` |
| `jira.issue.fields.edit` error | Wrong action type | Use `jira.issue.edit` with `operations` array |
| 0 rules found | Wrong trigger type | Use `jira.issue.event.trigger:transitioned` |
| Status name mismatch | Board shows ALL CAPS, API is title case | Always fetch real names via `/project/<KEY>/statuses` |

### Base rule template

Always derive from an **exported rule from the same Jira site** — not hand-crafted JSON. The import validator is strict and checks internal fields (`clientKey`, `partitionId`, `ruleHome`) that are site-specific.

To get a base rule:
1. Go to **Global Administration → Automation**
2. Find any existing rule → `...` → **Export**
3. Use that JSON as the template

---

## Step 5 — Import via Jira UI

Jira Automation API blocks API token auth — import must be done via browser.

1. Go to `https://salaryhero.atlassian.net` → **Project Settings** (target project) → **Automation**  
   _or_ **Global Administration → Automation** (for cross-project rules)
2. Click `...` (three dots, top-right) → **Import rules**  
   _(If no Import option: try the `Create flow ∨` dropdown instead)_
3. Upload `automation-rules.json`
4. Select all rules → set scope to target project → **Next** → **Process**

---

## Step 6 — Enable rules

Imported rules land as **DISABLED**. Enable each one:
- Toggle the switch in the Automation rules list, or
- Open each rule → toggle **Enabled** top-right

---

## SalaryHero reference

| Project | Key | Cloud ID | Project ARI |
|---|---|---|---|
| Solutions | `IN` | `98b300b1-2388-4e4c-81c3-0ddb5ff49de9` | `ari:cloud:jira:98b300b1-...:project/10007` |
| DevOps | `DP` | same | `ari:cloud:jira:98b300b1-...:project/10052` |

### Solutions fields created (2026-07-06)

| Status | Field name | Field ID |
|---|---|---|
| Requirement & Design | Solutions - Requirement & Design At | `customfield_10820` |
| In Development | Solutions - In Development At | `customfield_10821` |
| Internal Testing | Solutions - Internal Testing At | `customfield_10822` |
| SIT | Solutions - SIT At | `customfield_10823` |
| UAT | Solutions - UAT At | `customfield_10824` |
| Pending Deployment | Solutions - Pending Deployment At | `customfield_10825` |
| Pending Release | Solutions - Pending Release At | `customfield_10826` |
