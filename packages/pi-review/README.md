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

### Subagent review (default)

When [pi-interactive-subagents](https://github.com/gtheys/pi-my-rifle-ext/tree/main/packages/pi-interactive-subagents) is installed and pi runs inside a supported terminal multiplexer (cmux, tmux, zellij, WezTerm, Herdr), `/review` spawns the bundled `reviewer` agent (Opus, read+bash, auto-exit) in a background pane. The review runs non-blocking — the main session stays usable — and the findings are steered back into the main session automatically when the reviewer finishes. Override the reviewer by placing your own `reviewer.md` in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global).

### Legacy in-session review (no mux)

Without a supported multiplexer (or if spawning fails), `/review` falls back to running the review in the session itself: pick "Empty branch" to review on a labeled session-tree branch (return with `/end-review`), or "Current session".

When reviewing a pull request, if `tuicr` and `herdr` are on PATH and the session is running inside Herdr (`HERDR_ENV=1`), `/review` also opens a `tuicr pr <n>` TUI in a Herdr pane on the right, and asks the agent to add its findings into that session via `tuicr review add` (see the `tuicr` skill).

PR reviews are worktree-based by default: with Herdr and a mux available, the PR is fetched into a dedicated `review/pr-<n>` branch in its own Herdr worktree, the reviewer subagent runs there, and the worktree (and its branch) is removed automatically once the review finishes. The main checkout is never touched — a dirty working tree is fine. Without Herdr/mux, the legacy in-place `gh pr checkout` flow is used, which requires a clean tree.

If the `ocr` (OpenCodeReview) binary is on PATH, PR reviews also spawn a scout subagent that runs `ocr review --from <base> --to <pr-branch>` in the review worktree and steers the raw output back as an `ocr_result` message — a second opinion alongside the reviewer findings. The worktree stays alive until both jobs finish.

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
