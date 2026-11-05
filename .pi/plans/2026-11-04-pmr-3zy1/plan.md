# PMR-3ZY1 — human code-review gate before push-main in personal mode

## Problem

In pi-flow personal mode nothing human gates the push to main. The validate
prompt (`packages/pi-flow/validate/prompt.ts`, `buildReviewGateSection`
personal branch) ends with `flow_land route=push-main` + "push straight to
main". `flow_land` (`packages/pi-flow/tools/land.ts`) only re-checks the
`review-passed` label, then sets `landingState.authorized` and the bash
interceptor (`flow/land-gate.ts` + the `tool_call` handler in `index.ts`)
lets the push through. A fully automated run lands on main with no human
ever seeing the diff.

## Decisions (confirmed with human)

1. **The human code-review gate is the ONLY review-gate change in personal
   mode.** The ocr scout (`startOcrReview` in `review/review.ts` — the
   second-opinion scout that accompanies the reviewer subagent) is REMOVED
   from personal-mode FLOW reviews: skip when `getActiveFlowRef() !== null
   && resolveMode(cwd) === 'personal'`. A manual `/review` in a personal
   repo (no active flow) KEEPS the ocr scout. Work mode untouched.
2. **Viewer is tuicr, NOT herdr-gitview.** (`tuicr` v0.27.0 on PATH at
   `/usr/bin/tuicr`.) Branch scope is native (`-r <revset>`), findings
   persist (`tuicr review list/add/comments`) and are machine-readable. The
   ticket description's gitview research (GITVIEW_REPO, toggle-tab, plugin
   config `default_scope`) is superseded.
3. **Tool-enforced gate (option A).** The `code_review` AGENT TOOL opens
   tuicr, then asks pass/fail itself via
   `ctx.executeTool('ask_user_question', ...)`, and records the pass in
   extension-owned `LandingState.humanReviewPassed`. `flow_land
   route=push-main` refuses without it. The model cannot fabricate the pass.
4. **Blocking ask, not loop halt.** `ask_user_question` keeps the run in
   flight (index.ts: "blocking ask_user_question gates keep the run in
   flight"), so the gate needs NO loop.ts pause/halt machinery — same
   semantics as the existing personal human-test gate (validate prompt
   step 3, `routePersonalOutcome`). The ticket's "halt + resume via
   /code-review" wording is superseded by this stronger in-turn gate.
5. **PMR-Y6NF** (`authorized` never cleared, ref not validated) is fixed
   inside this epic — child PMR-VZEV. Close PMR-Y6NF when it lands.
6. Work mode (PR route) is untouched.

## Children and execution order

Land strictly in this order (C6AK and VZEV both edit `tools/land.ts` —
do not run their worktrees in parallel).

### 1. PMR-T8ZG — `/code-review` command + `code_review` tool

No deps. Both entry points share ONE core (the `/review` command + `review`
tool pattern, review.ts "Shared by the /review command and the
agent-callable review tool — one implementation"):

- **`/code-review <aven-ref>` command** (human entry): resolves the ref,
  sends the gate prompt to the agent via `pi.sendUserMessage` (phase-command
  pattern, `flow/phase-command.ts:105`). The prompt instructs: call the
  `code_review` tool with the ref. The tool owns everything else.
- **`code_review` tool** (agent entry — agents cannot invoke slash commands,
  the very reason flow/loop.ts exists):

  1. **Resolve the worktree** (fail loud — never open tuicr on the wrong
     tree; notify + isError result naming what failed):
     - Source 0: in-session binding `getFlowWorktree()`
       (`flow/worktree-context.ts`).
     - Source 1: latest `worktree: <path> branch: <b>` aven note — parse
       `aven show <ref> --full` note bodies (`note id=...` +
       `body<<EOF ... EOF` blocks; new pure parser next to
       `parseMetadataBlock` in `spec-review/aven-spec.ts`), take the LAST
       matching note.
     - Source 2: `herdr worktree list` (`worktree/herdr.ts worktreeList`)
       matched by repo root + expected branch (derived from the ticket
       title slug — reuse `deriveBranch` in `worktree/branch.ts`).
     - Verify the winner: path exists, is a worktree of the session repo
       (`git -C <path> rev-parse --show-toplevel` matches), branch matches
       the note/derivation. Stale note path → fall through to next source.
  2. **Open tuicr for the human** (your existing review shape: a tuicr pane
     at the review worktree):
     - `herdr tab create --cwd <worktree> --label "review <ref>" --focus`;
       parse `result.root_pane.pane_id` from its JSON response (verified on
       the installed herdr; same pattern as pi-interactive-subagents
       `subagents/spawn.ts`) — NO pane-list before/after diff.
     - `herdr pane run <pane> tuicr tui -r <base>..HEAD` (text + Enter in
       one call; the review.ts maybeOpenTuicrForPr pattern). NOTE: plain
       `send-text` does NOT submit — it needs a `send-keys return`
       follow-up (open-in-pane.ts); `pane run` avoids that two-step.
     - `<base>`: `git merge-base main HEAD` resolved in the worktree
       (three-dot equivalent = branch scope: the flow's whole change set vs
       the branch it was cut from).
     - `ctx.ui.notify` carries the exact command as the manual fallback.
     - herdr/tuicr unavailable or open fails: fail-closed — return error
       "open failed — run `<cmd>` manually, then re-call code_review". The
       re-call after a manual open proceeds to the ask.
  3. **Ask pass/fail via `ctx.executeTool('ask_user_question', ...)`** with
     exactly two options, mirroring `validate/personal.ts
     routePersonalOutcome`. BLOCKS until answered (pi 1.5.0
     docs/extensions.md "Calling Other Tools": a tool's execute() gets
     ExtensionToolContext with ctx.tools/ctx.executeTool — verified).
     - **pass**: set `landingState.humanReviewPassed = ref` (new field on
       `LandingState`, `tools/land.ts`), write aven note `human code review
       passed, <date>`, return "call flow_phase_complete(validate), then
       flow_land, then push".
     - **fail**: read findings from the persisted tuicr session —
       `tuicr review comments --session <slug> --repo <worktree>` (slug from
       `tuicr review list --repo <worktree>`, latest session); post output
       as the findings aven note. Empty session → free-text ask fallback.
       Return "findings recorded — route back to /implement <ref> (retry
       budget applies), STOP".
  4. **Dependency risk**: `ask_user_question` is NOT a pi built-in — it is
     the pi-ask-user-question EXTENSION's tool. `ctx.executeTool` only
     reaches it when that extension is installed and the tool appears in
     `ctx.tools`. Check membership first; when absent OR the nested ask
     misrenders, fall back: the tool returns after opening; the agent asks
     via its own ask_user_question; a second `code_review` call with
     `outcome: 'pass'` records the marker (agent-attested — weaker, note
     in AIDEV-).

- Tests: pure resolver fixtures (note parser, herdr-list matching, stale
  path fallthrough), exec-injected open sequence (tab create / pane run
  commands asserted verbatim), ask routing (pass → marker + note;
  fail → comments-as-note, empty → fallback), loud-failure paths. Reference
  patterns: `test/worktree.test.ts`, `test/spec-review.test.ts`
  (heredoc parsing), `test/review-tool.test.ts`.

### 2. PMR-C6AK — personal validate gate wiring + ocr scout removal

Depends on PMR-T8ZG. Three edits:

- **Validate prompt, personal branch** (`buildReviewGateSection` personal
  path + `buildDeviationGateSection` personal D5):
  - Review gate step 9 (personal) becomes: call the `code_review` tool with
    ref=<ref> — it opens tuicr on the flow worktree, waits for the human's
    pass/fail. On pass: `flow_phase_complete(phase="validate")` →
    `flow_land(route=push-main)` → push. On fail: the tool already
    recorded the findings note; route back to `/implement <ref>` (retry
    budget applies) and STOP.
  - Ordering: human test gate (steps 1–5) → agent `/review` (blockers=0,
    fixes landed) → deviation gate (0 deviations) → **human code-review
    gate** → `flow_phase_complete(validate)` + `flow_land` + push. The
    human sees the FINAL state; the label lands only after the human pass,
    so the loop cannot advance to feedback before the push.
  - Deviation gate personal D5 "continue" target is reworded: "continue to
    the human code-review gate (code_review tool)" instead of "continue to
    flow_phase_complete + flow_land". Work-mode D5 unchanged.
- **`flow_land` marker check** (`tools/land.ts`): `route=push-main` now
  also requires `state.humanReviewPassed === params.ref`; refusal reason
  names the code_review tool. `route=pr` unchanged. (The field was
  introduced in T8ZG; the CHECK lands here so behavior changes in one
  child — between T8ZG and C6AK the marker is written but unused.)
- **ocr scout skip** (`review/review.ts spawnReviewJobs`): skip the
  `startOcrReview` branch when `getActiveFlowRef() !== null &&
  resolveMode(pi, ctx.cwd) === 'personal'`. Manual `/review` without an
  active flow keeps ocr. Work mode keeps ocr.
- Acceptance: a personal-mode `/flow` run CANNOT reach `git push` without
  the code_review tool having collected a human "pass" (flow_land refuses;
  the interceptor still blocks until then). Work-mode prompt bytes
  unchanged (test asserts).
- Tests: `test/validate.test.ts` (personal prompt contains the gate step,
  work prompt unchanged), `test/deviation-prompt.test.ts` (D5 wording),
  land tool test (push-main refused without marker, pr unaffected),
  review-tool test (ocr skipped iff flow+personal; spawned otherwise).

### 3. PMR-VZEV — landing-state lifecycle fix (PMR-Y6NF)

Independent of C6AK logically; land AFTER C6AK (same file, avoid parallel
worktrees). Closes PMR-Y6NF.

- **Ref validation**: `flow_land` compares `params.ref` against
  `loop.activeRef()` (pass a getter into `registerLandTool`). Mismatch →
  refuse. `activeRef() === null` → ALLOW (hand-run `/code-review` outside a
  live flow is legitimate; the interceptor does not gate without an active
  ref either).
- **Clear `authorized` after use**: in the `index.ts` `tool_call`
  interceptor, once a landing command passes BECAUSE
  `landingState.authorized === activeRef`, clear `authorized` — one
  authorization = one landing command. Also clear `humanReviewPassed` in
  the same place.
- **Reset on new flow**: `loop.start` clears `landingState.authorized` and
  `humanReviewPassed` (stale authorization cannot leak into a later flow).
  Route the reset through the existing `setActiveRef` call site or a new
  dep — smallest change wins.
- Tests: `test/land-gate.test.ts` (mismatch refusal, null-activeRef
  allowed), interceptor test (cleared after first allowed push; second
  push re-blocked), `test/loop.test.ts` (start resets state).

## Anti-criteria (must NOT happen)

- No silent review of the wrong tree: worktree resolution failure is loud
  (notify + isError), never falls back to the session checkout.
- No push-main without the human pass marker: `flow_land route=push-main`
  refuses; the interceptor still blocks direct `git push` while a flow is
  active.
- No work-mode changes: PR-route prompt text, ocr behavior, and flow_land
  `route=pr` semantics byte-identical (tests pin this).
- No ocr scout in personal-mode FLOW reviews; manual personal /review
  keeps ocr.
- No loop.ts pause/halt machinery for this gate — the blocking ask owns
  the wait.

## Edge cases

- Session dies mid-ask: no label landed → `/flow` re-enters validate from
  the top (known re-entry cost, tracked by PMR-PKSS — out of scope here).
- Stale `worktree:` note (path gone): fall through to next source, do not
  fail until all sources are exhausted.
- Worktree exists but branch mismatches expectation: loud fail.
- tuicr/herdr missing or open fails: fail-closed error with the manual
  command; the gate ask happens only on a successful open (or a re-call
  after manual open).
- Empty tuicr session on fail: free-text findings ask (validate step-5
  pattern).

## Open notes

- `code_review` tool naming: keep the `flow_` prefix convention?
  `flow_code_review` vs `code_review` — decide at implementation; the
  command stays `/code-review`.
- The aven ticket description (gitview mechanics, halt/resume wording) and
  the child descriptions predate this refinement — propose updating them
  to match this plan when the user confirms.
