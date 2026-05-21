---
name: debug
description: "Bootstrap a debugging session for issues encountered during manual testing or implementation. Investigates logs (minikube pods), database state (PostgreSQL nonprod), and git history without editing files. Use when something is broken, unexpected behavior occurs, or you need to trace an issue. Trigger on 'debug', 'something's broken', 'help me debug', 'what's wrong', 'investigate issue', or when invoked with 'start: Debug'."
---

# Debug Session

You are tasked with helping debug issues during manual testing or implementation. Your role is to **investigate only** — examine logs, database state, and git history without editing files. Think of this as a debugging bootstrap session.

## Arguments

The skill accepts an optional Jira ID (e.g. `IMP-7070`, `DP-92`, `ENG-1234`) as `$ARGUMENTS`.

---

## Initial Response

### When invoked WITH a Jira ID:

Immediately fetch ticket context from taskwarrior, then ask what broke:

#### Step 1 — Fetch ticket

```bash
task jiraid:$JIRA_ID +jira export
```

Parse JSON. Key fields:

| Field | Purpose |
|-------|--------|
| `jirasummary` | Jira title |
| `jiradescription` | Full description, AC, specs |
| `jirastatus` | Current status |
| `jiraurl` | Link to ticket |
| `jiraissuetype` | Story / Bug / Task |

If no task found:

```
No taskwarrior task found for "$JIRA_ID". Make sure bugwarrior has synced.
Run `bugwarrior pull` to sync, or describe the issue manually.
```

#### Step 2 — Create branch (if not already on one for this ticket)

After fetching the ticket, check whether a branch for this Jira ID already
exists locally. If not, create one using the shared helper:

```bash
# Check for an existing branch first
git branch --list "*$JIRA_ID*"

# If none found, create it
bash scripts/jira-branch.sh $JIRA_ID
```

If the branch already exists, check it out:

```bash
git checkout $(git branch --list "*$JIRA_ID*" | head -1 | tr -d ' *')
```

> The script sets the git-town parent to `develop` and names the branch
> `<prefix>/$JIRA_ID-<summary-slug>`. Use `--dry-run` to preview without
> creating.

---

#### Step 3 — Present context and ask what broke

```
I'll help debug issues with $JIRA_ID — $jirasummary.

Ticket status: $jirastatus
Jira: $jiraurl

Summary:
[parsed jiradescription]

What specific problem are you encountering?
- What were you trying to test/implement?
- What went wrong?
- Any error messages or unexpected behavior?

I'll investigate the logs, database, and git state to figure out what's happening.
```

---

### When invoked WITHOUT a Jira ID:

```
I'll help debug your current issue.

Please describe what's going wrong:
- What are you working on? (Jira ID if you have one)
- What specific problem occurred?
- Any error messages or stack traces?
- When did it last work correctly?

I can investigate logs (minikube), database state (PostgreSQL nonprod), and recent git changes to help identify the root cause.
```

Wait for user's description before proceeding.

---

## Available Investigation Tools

### 1. PostgreSQL — Nonprod Database

**Connection string:** `postgres://postgres:localpassword@localhost:5432/nonprod`

```bash
# Connect interactively
psql postgres://postgres:localpassword@localhost:5432/nonprod

# Run a one-off query
psql postgres://postgres:localpassword@localhost:5432/nonprod -c "<SQL>"

# List all tables
psql postgres://postgres:localpassword@localhost:5432/nonprod -c "\dt"

# Describe a specific table
psql postgres://postgres:localpassword@localhost:5432/nonprod -c "\d <table_name>"
```

Use to inspect: record state, missing rows, constraint violations, migration state, data inconsistencies.

---

### 2. Minikube Pod Logs

Pods are named closely after the repository name. The current repo name can be determined via:

```bash
basename "$(git remote get-url origin 2>/dev/null | sed 's/\.git$//')" 2>/dev/null \
  || basename "$(git rev-parse --show-toplevel 2>/dev/null)" \
  || basename "$PWD"
```

**Discovery flow:**

```bash
# List all running pods
kubectl get pods -A

# Find pods matching repo name (fuzzy match)
kubectl get pods -A | grep -i "<repo-name>"

# Get logs from a specific pod (all namespaces)
kubectl logs -n <namespace> <pod-name>

# Tail live logs
kubectl logs -n <namespace> <pod-name> --tail=100 -f

# Get logs from previous crashed container
kubectl logs -n <namespace> <pod-name> --previous

# Get logs from a specific container in a multi-container pod
kubectl logs -n <namespace> <pod-name> -c <container-name>

# Describe pod for events/crash reason
kubectl describe pod -n <namespace> <pod-name>
```

**If multiple pods match**, list them all and ask the user which to focus on, or check all relevant ones.

---

### 3. Git History & Recent Changes

```bash
# Recent commits on current branch
git log --oneline -20

# What changed in the last commit
git show --stat HEAD

# Changes since a specific commit
git diff <commit>..HEAD --stat

# Who changed a specific file recently
git log --oneline -10 -- <file>

# Show changes to a specific file
git diff HEAD~5 -- <file>

# Check current branch and status
git status && git branch
```

---

### 4. Local Service State

```bash
# Check if expected services are running
kubectl get services -A

# Check deployments and their replica state
kubectl get deployments -A

# Check recent events in the cluster
kubectl get events -A --sort-by='.lastTimestamp' | tail -30

# Check if there are crashlooping pods
kubectl get pods -A | grep -v Running | grep -v Completed
```

---

## Investigation Strategy

### Step 1: Gather context from user

Understand:
- What they were doing (feature area, endpoint, flow)
- What broke (error message, wrong data, 500, silent failure)
- When it last worked (after a deploy? after a migration? after a code change?)

### Step 2: Map to components

Based on the description, identify which components are involved:
- Which service/pod handles this flow?
- Which database tables are involved?
- Were there recent migrations or code changes?

### Step 3: Check logs first

```bash
# Find the relevant pod
kubectl get pods -A | grep -i "<repo-or-service-name>"

# Check recent logs for errors
kubectl logs -n <namespace> <pod-name> --tail=200 | grep -i "error\|exception\|traceback\|fatal\|warn"

# Full recent logs if needed
kubectl logs -n <namespace> <pod-name> --tail=200
```

### Step 4: Check database state

If the issue involves data:
```bash
# Check relevant table
psql postgres://postgres:localpassword@localhost:5432/nonprod -c "SELECT * FROM <table> WHERE <condition> LIMIT 10;"

# Check migration state (common pattern)
psql postgres://postgres:localpassword@localhost:5432/nonprod -c "SELECT * FROM alembic_version;"

# Check for constraint violations or unexpected nulls
psql postgres://postgres:localpassword@localhost:5432/nonprod -c "\d <table>"
```

### Step 5: Correlate with recent changes

```bash
# What changed recently
git log --oneline -10

# Did a relevant file change?
git log --oneline -10 -- <suspected-file>
```

### Step 6: Synthesize findings

Present:
1. **Root cause hypothesis** — what you believe is wrong and why
2. **Evidence** — log lines, DB state, git commits that support it
3. **Recommended fix** — what to do (but don't do it — surface it for the developer)

---

## Output Format

After investigation, present findings as:

```
## Debug Findings

### What I investigated:
- Logs: [pod name, namespace, time range]
- Database: [tables/queries checked]
- Git: [commits/files reviewed]

### What I found:
- [Specific finding with evidence — log line, query result, commit hash]
- [Corroborating detail]

### Root cause hypothesis:
[Concise explanation of what's wrong and why]

### Recommended next steps:
1. [Specific action to fix or verify]
2. [Follow-up check]
```

---

## Important Guidelines

1. **Investigate, don't fix** — surface findings, let the developer decide on the fix
2. **Show evidence** — always quote the specific log line, query result, or git commit supporting your conclusion
3. **Check all three layers** — logs, DB, git history often point to the same root cause from different angles
4. **Be specific about pod names** — always show the exact pod/namespace used
5. **Fuzzy match repo → pod name** — pod names rarely match exactly; always `kubectl get pods -A` first
6. **Ask before assuming scope** — if the issue could span multiple services, ask which to focus on first
7. **Note crashlooping pods** — always check for non-Running pods as part of initial triage
