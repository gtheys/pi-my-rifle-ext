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
diff), `/review custom "<instructions>"`. No args → interactive selector (which also
offers the ocr-delegate preset, below).

- When a supported multiplexer is available, `/review` spawns a **`reviewer`
  subagent** via `pi-interactive-subagents`' programmatic API (`launchSubagent`)
  — the review runs in its own pane and findings steer back into the session when
  done. The legacy in-session path remains as fallback (no mux, or spawn failed);
  with a mux, every mode runs in the subagent.
- PR reviews are **worktree-based by default**: with Herdr and a mux available, the
  PR is fetched into a dedicated `review/pr-<n>` branch in its own Herdr worktree,
  the reviewer subagent runs there, and the worktree (+ branch) is auto-removed
  when the review finishes. Fresh worktrees get `yarn install` with `GH_TOKEN`
  propagated (private registries). The main checkout is never touched. Without
  Herdr/mux, the legacy in-place `gh pr checkout` flow requires a clean tree.
- **ocr second opinion:** if the `ocr` binary (OpenCodeReview) is on PATH, every
  diff-based target also spawns a pure-runner **scout** subagent running
  `ocr <args> --format json --output <tmpfile>`: PR → `review --from <base> --to
  <worktree-branch>` in the worktree; base branch → `--from <merge-base> --to HEAD`;
  uncommitted → workspace `review`; commit → `--commit <sha>`; folder → `scan
  --path <paths>` (no diff). The scout cats the file; the JSON steers back as an
  `ocr_result` message (machine-parseable, first line = tmpfile path). `custom`
  and `ocrDelegate` targets get no scout. For PR reviews the worktree stays alive
  until both jobs (reviewer + scout) finish.
- **ocr delegate preset:** "Review with ocr delegate rules" reuses the branch
  selector, then the reviewer subagent itself runs `ocr delegate preview` +
  `ocr delegate rule` (LLM-free spec + resolved rules) and applies the rules to
  the diff — host-agent delegation, no ocr LLM configuration required.
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
it. The ocr delegate preset fits between: structured rule coverage without a second
LLM bill.

## See also

- [Extension reference](../architecture/extensions.md#pi-review-review--sonarqube--pr-quality)
- `skills/engineering/gh-unresolved-comments/SKILL.md` — the standalone skill
  `/pr-quality`'s GraphQL query is derived from.
- `skills/engineering/pr-description/SKILL.md`, `teams-pr-notify/SKILL.md` — adjacent
  PR-lifecycle skills not covered by these extensions.
