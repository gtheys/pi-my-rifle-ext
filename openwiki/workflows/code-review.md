# Code Review Workflow

Three cooperating slash commands under `packages/pi-review/`, sharing
`packages/pi-review/shared/sonarqube-utils.ts`. None of them share code with the
`pi-planning` package — review and planning are fully independent domains.

## The three commands and when to use which

| Command | Input | Output |
|---|---|---|
| `/review` | PR / branch / commit / uncommitted / folder / custom instructions | Prompts the **agent** to do a full code review right now |
| `/sonarqube` | PR number (or auto-detect) | Static report: coverage gaps + quality issues from SonarCloud, analysis-only |
| `/pr-quality` | PR number (or auto-detect) | Unified pass: unresolved GitHub review threads **+** SonarCloud issues, triaged and **fixed immediately** |
| `/pr-watch` | (background) | Polls PR checks until green, then auto-triggers `/pr-quality` |

## `/review` — `packages/pi-review/review/review.ts`

Modes: `/review pr 123`, `/review pr <url>`, `/review uncommitted`,
`/review branch main`, `/review commit <sha>`, `/review folder src docs` (snapshot, not
diff), `/review custom "<instructions>"`. No args → interactive selector.

- PR-review mode checks the PR out locally via `gh`/`git` and **requires a clean
  working tree** (refuses if there are uncommitted changes to tracked files) — it
  can't safely check out a branch over dirty state.
- Injects semantic-tool guidance into the review prompt via
  `buildSemReviewGuidance()`/`getSemToolAvailability()` from `sem-guidance.mjs`: if
  `pi-sem` tools are available, the agent is told to prefer `sem_diff`/`sem_impact`
  over raw `git diff` for entity-level review.
- If a `REVIEW_GUIDELINES.md` file sits next to `.pi/` in the repo, its contents are
  appended to the review prompt — the mechanism for repo-specific review rules
  without editing this extension.
- Tracks a single "review session" via module-level state (`reviewOriginId`,
  `endReviewInProgress`) — only one review can be active at a time, by design; see the
  in-file comment for why this isn't per-session state.

## `/sonarqube` — `packages/pi-review/sonarqube/sonarqube.ts`

Rewrite of legacy `salaryhero/opencode/bin/sonar-*` bash scripts as a typed pi
extension. **Analysis only — makes no code changes.**

```
/sonarqube                              # auto-detect PR + sonar-project.properties
/sonarqube 283                          # explicit PR number
/sonarqube 283 --severity=BLOCKER,CRITICAL
/sonarqube 283 --types=BUG,VULNERABILITY
```

Requires `SONARQUBE_TOKEN` env var. Auto-detects the Sonar project key/org from
`sonar-project.properties` if `--config` not given. Reports coverage gaps
(`analyzeCoverage`) and issues (`analyzeIssues`) filtered by severity/type.

## `/pr-quality` — `packages/pi-review/pr-quality/index.ts`

The "do the work" command — combines both signal sources and expects the agent to act:

1. Fetch unresolved GitHub review threads via inline `gh api graphql`
   (`REVIEW_THREADS_QUERY` — same query as the `gh-unresolved-comments` skill, but
   inlined here so this extension has no shell-script dependency).
2. Fetch SonarCloud coverage + issues for the same PR (shared utils).
3. Send both as one context message to the LLM, which is expected to:
   - Triage each review thread **VALID** or **INVALID**.
   - Auto-resolve INVALID threads via the GraphQL API.
   - Cross-reference VALID comments with Sonar issues by file.
   - **Fix issues immediately** — deliberately no plan file is written for this
     (changed in commit `f68b45b5`; an earlier version wrote a plan file first).

Prerequisites: `gh` CLI authenticated, `SONARQUBE_TOKEN` set,
`sonar-project.properties` present (or `SONAR_PROJECT_KEY`/`SONAR_ORGANIZATION` env
vars).

## `/pr-watch` — same file, background half of the loop

Polls `gh pr view --json statusCheckRollup` on a `setInterval` (not a blocking
`gh pr checks --watch`, replaced in `a30502f6`/`a3fcdae7`/`202b3de7` after a flaky
detached-bash+sentinel-file+`fs.watch` approach) — treats `SKIPPED` checks as
non-blocking. When all relevant checks complete, it automatically triggers
`/pr-quality`. Interval is cleaned up on `session_shutdown` (`index.ts:499`) so it
doesn't leak across sessions.

## Recommended loop

```
open PR → /pr-watch (fire and forget) → checks go green →
  /pr-quality auto-fires → agent triages + fixes → you review + commit
```

Or synchronously: `/review pr <n>` for a human-style read-through before merging, and
`/sonarqube <n>` any time you just want the static report without the agent acting on
it.

## See also

- [Extension reference](../architecture/extensions.md#pi-review-review--sonarqube--pr-quality)
- `skills/engineering/gh-unresolved-comments/SKILL.md` — the standalone skill
  `/pr-quality`'s GraphQL query is derived from.
- `skills/engineering/pr-description/SKILL.md`, `teams-pr-notify/SKILL.md` — adjacent
  PR-lifecycle skills not covered by these extensions.
