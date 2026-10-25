# Plan: PMR-5D1B — expose sonarqube, pr-quality, and review as agent-callable tools

Date: 2026-10-25
Mode: personal
Epic: PMR-5D1B
Research: /home/geert/Code/salaryhero/llm-notes/pi-my-rifle-ext/notes/research/2026-10-25-pmr-5d1b.md

## Decision summary

- Tools registered inside pi-review via `pi.registerTool()`, next to the existing
  slash commands. Command and tool share one extracted core per command. No code
  duplicated into pi-flow.
- Review tool delivery: **fire-and-steer** (Option A, user decision 2026-10-25).
  The tool spawns the subagents and returns "spawned" immediately. Findings
  arrive later as the existing `review_result` / `ocr_result` steer messages.
- House tool conventions apply: one register* fn per file, TypeBox params,
  `execute(_id, params, signal, onUpdate, ctx)`, errors as `isError: true`
  results, structured data in `details`.

## Tree

- PMR-5D1B (epic, plan label)
  - PMR-F9NY — feat(pi-review): expose sonarqube as agent-callable tool
  - PMR-VB2H — feat(pi-review): expose pr-quality as agent-callable tool
  - PMR-B3TD — feat(pi-review): expose review as agent-callable tool (fire-and-steer)

## Execution order

1. PMR-F9NY (sonarqube) — near-pure pipeline, lowest risk. Establishes the
   tool-registration pattern for the package.
2. PMR-VB2H (pr-quality) — same shape, reuses the pattern.
3. PMR-B3TD (review) — last: depends on both above (dep links encoded:
   `aven dep add PMR-B3TD PMR-F9NY`, `aven dep add PMR-B3TD PMR-VB2H`).
   Carries the subagent-context risk.

## Per-child intent

### PMR-F9NY — sonarqube tool

- Extract the handler pipeline from `packages/pi-review/sonarqube/sonarqube.ts`
  (steps: token guard -> detect config/PR -> fetch coverage/issues/duplications
  -> generateReport) into `runSonarAnalysis({cwd, prNumber?, filter?, signal})`.
- Register `sonarqube` tool: returns report text in `content`, structured
  analysis in `details`. The `sonarqube-report.md` file write becomes optional.
- `/sonarqube` command keeps its behavior, now calling the shared core.
- Tests: node:test against the extracted core; PATH shims for `gh`.

### PMR-VB2H — pr-quality tool

- Extract `gatherPrQualityData({prNumber, cwd, signal})` from
  `packages/pi-review/pr-quality/index.ts`; reuse `buildAgentPrompt` (:232).
- Register `pr_quality` tool: returns triage prompt/data. CI-pending guard
  becomes an `isError: true` result instead of notify-and-return.
- `/pr-quality` command keeps its behavior over the shared core.
- Tests: node:test, PATH shims for `gh`.

### PMR-B3TD — review tool (fire-and-steer)

- Extract prompt construction from `executeReview`
  (`packages/pi-review/review/review.ts:1519`) into
  `buildFullReviewPrompt(pi, target, cwd)` (rubric + target prompt + sem
  guidance + REVIEW_GUIDELINES.md).
- Register `review` tool with a required TypeBox target union:
  uncommitted / branch / commit / pr / folder / custom. No interactive
  selector in tool context — the target is a required param.
- Tool path = subagent spawn only: `startSubagentReview` + `startOcrReview`
  (ocr only when on PATH). Requires `isMuxAvailable()`; without a mux return a
  clean `isError` result (the legacy navigateTree path is meaningless from a
  tool).
- Immediate result: "spawned" + hint + whether the ocr scout also started.
  Results keep arriving as `review_result` / `ocr_result` steer messages.
- PR target: `handlePrCheckout` worktree refcount (`pending: 2`) must be set
  BEFORE spawning both jobs, same as the command does.
- **Risk to verify first:** `launchSubagent` / `startOcrReview` take
  `ExtensionCommandContext` today; tool `execute` receives a different ctx type.
  Verify compatibility or adapt the signature before building the tool.
- Tests: node:test; mock ExtensionAPI capture for registration; PATH shim for
  `ocr`.

## Out of scope

- pi-flow prompt text changes ("Run /review" -> tool call): PMR-69V8 (blocked
  by this epic).
- Retiring the `blockers_count` prompt contract in pi-flow
  `validate/review-gate.ts`: needs a structured-verdict tool (Option B), not
  this epic.
- `/end-review` and `/pr-watch`: stay commands (session/TUI-bound).

## Acceptance criteria (epic)

- Agent in a pi-flow validate phase can start the review without any human
  typing a slash command.
- Commands and tools share one implementation; no logic duplication.
- Each extracted core has node:test coverage per house style.
