# The Coder's Creed

![This is my gun](assets/this_is_my_gun.png)

This is my Pi Agent. There are many like it, but this one is mine.

My Pi Agent is my best friend. It is my life. I must master it as I must master my life.

Without me, my Pi Agent is useless. Without my Pi Agent, I am useless — just a person staring at a terminal, mass-producing typos at scale.
I must prompt my Pi Agent true. I must code straighter than the bugs that are trying to kill my deploy. I must ship before they crash me. I will.

My Pi Agent and I know that what counts in coding is not the tokens we burn, the noise of our logs, nor the smoke from our GPUs. We know that it is the commits that count. We will commit.

My Pi Agent is human — even though it is not. Thus, I will treat it as a brother. I will learn its weaknesses, its strengths, its context window, its hallucinations, its token limits, and its uncanny ability to apologize for things that aren't its fault.

Before God, I swear this creed. My Pi Agent and I are the defenders of the codebase. We are the masters of our bugs. We are the saviors of my sprint.

So be it, until there are no bugs — only features.

And the backlog is empty.

Which it never will be.

Amen.

# pi-my-rifle-ext

Personal pi extensions, skills, commands, and themes.

## Structure

```
pi-custom-ext/
├── extensions/     # Custom extensions (index.ts)
├── skills/         # Skills (each in subdirectory with SKILL.md)
├── prompts/        # Prompt templates / slash commands (.md files)
├── themes/         # Theme JSON files
└── package.json    # pi package manifest
```

## Usage

Test locally by adding to `settings.json`:

```json
{
  "packages": [
    "/home/geert/Code/personal/pi-my-rifle-ext"
  ]
}
```

Or via CLI:

```bash
pi -e ./extensions/index.ts
```

## Extensions

### Local Extensions

| Extension | Description | Category |
|-----------|-------------|----------|
| `extensions/index.ts` | Startup bootstrap — symlinks `agents/AGENTS.md` to `~/.pi/agent/AGENTS.md` | Bootstrap |
| `extensions/review` | `/review` command — code review for PRs, branches, uncommitted changes, or specific commits with semantic tool guidance | Code Review |
| `extensions/tool-pills` | Colored pill badges for tool headers + Shiki-powered syntax-highlighted diffs for write/edit | UI Enhancement |
| `extensions/pi-sem` | Semantic code analysis tools — entity-level diff, impact analysis, context lookup, and blame via `pi-sem` | Code Analysis |
| `extensions/leader-key` | Ctrl+X floating command palette (Vim which-key / Emacs leader-key style) with grouped actions | UI Enhancement |
| `extensions/desktop-notify` | `/notify` command — desktop notifications (notify-send) when pi finishes work after an idle period | Notifications |
| `extensions/sonarqube` | `/sonarqube` command — fetches SonarCloud coverage gaps and quality issues for a PR, generates actionable report | Code Quality |
| `extensions/pr-quality` | `/pr-quality` command — combines GitHub PR review triage + SonarCloud analysis into a unified action plan | Code Quality |
| `extensions/test-runner` | `run_tests` tool — discovers and runs JS/TS tests from `package.json` using an isolated subagent; results injected back when done ⚠️ *experimental/WIP* | Testing |
| `extensions/fastcontext` | `fast_context_search` tool + `/fastcontext` command — fast read-only codebase search via local Microsoft FastContext (llama.cpp); returns compact `file:line` citations | Code Search |

### Published Packages

| Package | Description | Category |
|---------|-------------|----------|
| [@tomooshi/condensed-milk-pi](https://github.com/tomooshi/condensed-milk-pi) | Semantic token compression — filters noisy bash output and retroactively masks stale tool results | Token Reduction |
| [@sting8k/pi-vcc](https://www.npmjs.com/package/@sting8k/pi-vcc) | Algorithmic conversation compactor — transcript-preserving summaries, no LLM calls, searchable via `vcc_recall` | Token Reduction |
| [@tomooshi/caveman-milk-pi](https://www.npmjs.com/package/@tomooshi/caveman-milk-pi) | Injects caveman terseness rules into system prompt — cache-safe, opt-in | Token Reduction |
| [@gtheys/pi-per-commit-spend](https://www.npmjs.com/package/@gtheys/pi-per-commit-spend) | Tracks AI spend per git commit across sessions — calculates cost from token counts for subscription providers | Cost Tracking |

## Code Search Extension

### `fast_context_search` — FastContext

Runs a local [Microsoft FastContext](https://github.com/microsoft/fastcontext) model via llama.cpp to answer natural-language code-search queries without touching the LLM. Returns compact `file:line` citations only — read-only, no writes.

**How it works**

1. Spawns a mini agentic loop against a locally running llama.cpp server
2. The FastContext model gets three tools: `GLOB`, `GREP`, `READ` (all scoped to the repo root)
3. Runs up to `maxTurns` tool turns, then forces a `<final_answer>` block
4. Citations are validated (file exists, line numbers in bounds) and normalised to repo-relative paths
5. Returns up to 12 `relative/path:START-END — short reason` lines

**Prerequisites**

| Requirement | Details |
|-------------|--------|
| llama.cpp server | Running at `http://127.0.0.1:8772/v1` (default) with a FastContext model loaded |
| Model file | Default: `FastContext-1.0-4B-RL-Q4_K_M.gguf` |

**Tool parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | `string` | Natural-language code search query |
| `cwd` | `string?` | Repository root. Defaults to current pi cwd |
| `baseUrl` | `string?` | OpenAI-compatible base URL. Defaults to config/env or `http://127.0.0.1:8772/v1` |
| `model` | `string?` | Model ID. Defaults to config/env or `FastContext-1.0-4B-RL-Q4_K_M.gguf` |
| `maxTurns` | `integer?` | Tool turns before forced finalization (1–8). Default 6 |
| `maxTokens` | `integer?` | Max tokens per model response (128–4096). Default 1400 |
| `includeTranscript` | `boolean?` | Include raw turn-by-turn transcript in tool details. Default false |

**Commands**

```
/fastcontext <query>    # run a code search and display results as a notification
```

**Configuration**

Config is resolved in priority order (later overrides earlier):

1. Built-in defaults
2. User config: `~/.pi/agent/fastcontext.json`
3. Project config: `.pi/fastcontext.json` (in repo root)
4. Environment variables
5. Tool call parameters (highest priority)

```json
{
  "baseUrl": "http://127.0.0.1:8772/v1",
  "model": "FastContext-1.0-4B-RL-Q4_K_M.gguf",
  "maxTurns": 6,
  "maxTokens": 1400
}
```

**Environment variables**

| Variable | Description |
|----------|-------------|
| `FASTCONTEXT_BASE_URL` | Override llama.cpp server URL |
| `FASTCONTEXT_MODEL` | Override model ID |
| `FASTCONTEXT_MAX_TURNS` | Override max tool turns |
| `FASTCONTEXT_MAX_TOKENS` | Override max tokens per response |

**Output format**

```
# FastContext Result

<final_answer>
relative/path:START-END — short reason (≤8 words)
...
</final_answer>

## Validation
- Valid citations: 4/4
- Tool calls: 3 (0 failed)
- Time: 2.1s
- Tokens: prompt 1820, completion 312
```

**Files**

```
extensions/fastcontext/
└── index.ts    # Extension entry, tool + command registration, full FastContext loop
```

---

## Testing Extensions

### `run_tests` — Test Runner

> ⚠️ **Experimental / Work in Progress** — behaviour may change; use with caution.

Discovers and runs JS/TS test scripts from the nearest `package.json`. The test
execution is **non-blocking** — the subagent runs in the background and results
are injected back into the session automatically when done.

Uses [pi-intercom](https://github.com/nicobailon/pi-intercom) to wire up
`contact_supervisor` in the subagent so progress updates appear as inline
intercom messages during the run.

**How it works**

1. Scans up from the current directory to find the nearest `package.json`
2. Extracts scripts matching test patterns (`test`, `test:*`, `jest`, `vitest`,
   `playwright`, `mocha`, `cypress`, `e2e`, `spec`)
3. If multiple scripts exist and no `script` param is given, shows a picker
4. Detects the package manager from lockfiles (`yarn.lock`, `pnpm-lock.yaml`,
   fallback to `npm`)
5. Spawns an isolated pi subprocess (`--mode json --tools bash`) as the subagent
6. Returns **immediately** — session is unlocked while tests run
7. Subagent sends `contact_supervisor` progress updates via pi-intercom
8. When done, `pi.sendMessage({ triggerTurn: true })` re-engages the LLM with
   structured pass/fail results and per-failure details

**Tool parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `script` | `string?` | Script key from `package.json` (e.g. `test:unit`). Auto-detected if omitted. |
| `cwd` | `string?` | Working directory to search. Defaults to current project directory. |
| `model` | `string?` | Model ID for the subagent. Overrides the configured default. |

**Commands**

```
/run-tests                          # run tests — truly non-blocking, no LLM turn
/run-tests test:unit                # run a specific script

/test-runner                        # show current config
/test-runner model <id>             # set default subagent model
/test-runner model                  # show current default model
/test-runner reset                  # clear all config
```

**`/run-tests` vs `run_tests` tool**

| | `/run-tests` command | `run_tests` tool |
|--|---------------------|------------------|
| Triggered by | You (directly) | LLM |
| LLM turn while running | None | One turn for "started", one for results |
| Results delivery | `pi.sendMessage` in transcript, no LLM | `pi.sendMessage` + `triggerTurn` |
| Session stays idle? | ✓ Always | ✗ LLM responds twice |
| When to use | Normal test runs | LLM-driven workflows |

Use `/run-tests` for day-to-day test runs. The `run_tests` tool is for when the
LLM itself needs to check test results as part of a larger task.

**Configuration**

Config is stored at `~/.pi/agent/test-runner/config.json` and persists across
sessions, `/new`, and process restarts.

```json
{
  "defaultModel": "claude-haiku-4-5"
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaultModel` | `string` | _(pi default)_ | Model ID passed to the subagent via `--model`. Use a cheaper/faster model here since the subagent only runs bash and formats JSON. |

You can edit the file directly or use the `/test-runner model <id>` command.
The `model` tool parameter always wins over the config file for a single run.

**Result rendering**

| State | Display |
|-------|---------|
| Started | `⏳ Tests started in background: \`yarn test\`` |
| Passed | `✓ 14 passed` |
| Failures | `✗ 3 failed · 14 passed` → first failure name inline |
| Expanded (Ctrl+O) | Per-failure: file › test name, error message, stack trace (4 lines) |

**Detected test script patterns**

`test`, `test:*`, `jest`, `vitest`, `playwright`, `mocha`, `cypress`, `e2e`,
`e2e:*`, `spec`

**Files**

```
extensions/test-runner/
├── index.ts       # Extension entry, tool + command registration
├── discover.ts    # package.json scanner, package manager detection
└── runner.ts      # Subagent spawn, stdout parser, pi-intercom env wiring
```

---

## Code Quality Extensions

Two extensions work together to keep PRs clean. Both share utilities from
`extensions/shared/sonarqube-utils.ts`.

### `/sonarqube`

Fetches SonarCloud coverage metrics and quality issues for a PR, generates
a `sonarqube-report.md` in the repo root, then sends the report to the agent
so it can act on it.

**Prerequisites**

| Requirement | How to set up |
|-------------|---------------|
| `SONARQUBE_TOKEN` env var | Get at <https://sonarcloud.io/account/security>, then `export SONARQUBE_TOKEN=<token>` |
| SonarCloud project config | `sonar-project.properties` in repo root with `sonar.projectKey` and `sonar.organization`, **or** set `SONAR_PROJECT_KEY` + `SONAR_ORGANIZATION` env vars |

**Usage**

```
/sonarqube                          # auto-detect PR from current branch
/sonarqube 283                      # explicit PR number
/sonarqube 283 --severity=BLOCKER,CRITICAL
/sonarqube 283 --types=BUG,VULNERABILITY
/sonarqube 283 --files=src/auth/*
```

**What it does**

1. Fetches coverage metrics (`coverage`, `new_coverage`, `branch_coverage`, …)
2. Fetches all open issues for the PR (paginated, up to 500/page)
3. Analyzes coverage gaps against the 80% threshold
4. Groups issues by severity, type, file, and rule
5. Writes `sonarqube-report.md` to the repo root
6. Sends the report to the agent as a user message for follow-up action

---

### `/pr-quality`

The combined command. Checks that CI is finished, then fetches both GitHub
unresolved review threads and SonarCloud data in parallel, and sends a
structured prompt to the agent to triage, resolve, and plan.

**Prerequisites**

| Requirement | How to set up |
|-------------|---------------|
| `gh` CLI | `gh auth login` |
| `SONARQUBE_TOKEN` env var | Same as `/sonarqube` above |
| SonarCloud project config | Same as `/sonarqube` above |

**Usage**

```
/pr-quality          # auto-detect PR from current branch
/pr-quality 283      # explicit PR number
```

**What it does**

1. **CI guard** — calls `gh pr view <PR> --json statusCheckRollup`. If any
   check is still `QUEUED` or `IN_PROGRESS`, shows a warning with the pending
   check names and exits. `SKIPPED` checks are ignored.
2. **Parallel fetch** — GitHub GraphQL (unresolved review threads) and
   SonarCloud (coverage + issues) are fetched concurrently.
3. **Agent prompt** — sends a structured message with three tasks:

   | Task | What the agent does |
   |------|---------------------|
   | **A — Triage comments** | Reads each referenced file, classifies threads as VALID or INVALID, auto-resolves INVALID ones via `gh api graphql` mutation |
   | **B — SonarCloud issues** | Cross-references VALID comment files with SonarCloud issues, addresses remaining issues in severity order (BLOCKER → CRITICAL → MAJOR) |
   | **C — Action plan** | Writes `pr-quality-plan.md` to the repo root with checkbox lists for review comments, SonarCloud issues, and coverage gaps |

**Output: `pr-quality-plan.md`**

```markdown
# PR Quality Plan — PR #283

## Review Comments (VALID)
- [ ] src/auth/token.ts:42 — validate expiry before signing (@reviewer)

## SonarCloud Issues
- [ ] CRITICAL src/auth/token.ts:38 — typescript:S4036: JWT secret hardcoded

## Coverage Gaps
- Overall: 71% (gap: 9% to 80% threshold)
- New code: 65% (gap: 15% to 80% threshold)
```

---

### Shared utilities

`extensions/shared/sonarqube-utils.ts` contains all types and helpers used
by both extensions:

- `sonarFetch` — authenticated SonarCloud API call
- `analyzeCoverage` / `analyzeIssues` — data analysis
- `detectSonarConfig` — reads `sonar-project.properties` or env vars
- `detectPrNumber` — `gh pr view` auto-detection
- `fetchAllIssues` — paginated issue fetch
- `localExec` — `node:child_process` wrapper (replaces `ctx.exec` which does not exist)

## Migrating

Move skills/commands/themes one by one into the appropriate directory. Test with `/reload` after each move.
