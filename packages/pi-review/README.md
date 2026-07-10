# pi-review

Pi extension providing code-review commands powered by GitHub and SonarCloud.

## Extensions

| Entry | Description |
|---|---|
| `review/review.ts` | `/review` — agent-driven code review |
| `sonarqube/sonarqube.ts` | `/sonarqube` — SonarCloud coverage and quality analysis |
| `pr-quality/index.ts` | `/pr-quality` — combined PR thread triage + SonarCloud |

---

## /review

Agent-driven code review. Supports multiple targets:

```
/review                     — pick mode interactively
/review pr <number>         — review a specific PR
```

Modes: uncommitted changes, base branch diff, specific commit, pull request, folder diff, or custom instructions.

---

## /sonarqube

Fetches SonarCloud coverage metrics and quality issues for a PR, generates a `sonarqube-report.md` in the repo root, then sends the report to the agent.

### Prerequisites

| Requirement | How to set up |
|-------------|---------------|
| `SONARQUBE_TOKEN` | `export SONARQUBE_TOKEN=<token>` from <https://sonarcloud.io/account/security> |
| SonarCloud project | `sonar-project.properties` with `sonar.projectKey` and `sonar.organization`, or `SONAR_PROJECT_KEY` + `SONAR_ORGANIZATION` env vars |

### Usage

```
/sonarqube                             — auto-detect PR from current branch
/sonarqube 283                         — explicit PR number
/sonarqube 283 --severity=BLOCKER,CRITICAL
/sonarqube 283 --types=BUG,VULNERABILITY
/sonarqube 283 --files=src/auth/*
```

---

## /pr-quality

Combined command: CI guard → GitHub unresolved threads + SonarCloud data (fetched in parallel) → structured agent prompt.

### Prerequisites

Same as `/sonarqube` above, plus `gh` CLI authenticated (`gh auth login`).

### Usage

```
/pr-quality          — auto-detect PR from current branch
/pr-quality 283      — explicit PR number
```

### What it does

1. **CI guard** — exits early if any check is `QUEUED` or `IN_PROGRESS`.
2. **Parallel fetch** — GitHub GraphQL (unresolved review threads) + SonarCloud (coverage + issues).
3. **Agent prompt** — three tasks:

| Task | What the agent does |
|------|---------------------|
| **A — Triage comments** | Classifies threads VALID/INVALID, auto-resolves INVALID via GitHub GraphQL |
| **B — SonarCloud issues** | Addresses issues in severity order (BLOCKER → CRITICAL → MAJOR) |
| **C — Action plan** | Writes `pr-quality-plan.md` with checkbox lists |
