---
name: debug
description: "Structured debugging session: redact secrets, build a tight red-capable feedback loop, reproduce and minimise, rank hypotheses, instrument, fix with a regression test, and clean up. Use when something is broken, unexpected, throwing, failing, or slow. Trigger on 'debug', 'diagnose', 'something's broken', 'help me debug', 'what's wrong', 'investigate issue', invocation as /engineering:debug JIRA-ID SH, or 'debug <aven-ref>' for a bug ticket in aven (e.g. debug PMR-7KQ9). Accepts an optional Jira ID or aven ref to bootstrap ticket context (Jira also gets a branch), and an optional SH flag that additionally loads project-specific database and pod-log investigation commands — omit SH for a generic session with no infra assumptions."
---

# Debug Session

Investigate methodically until you have a true root cause, not a guess. Default to **investigate-only**: build evidence, form a root-cause hypothesis, and present a recommended fix without applying it. Only move into Phase 5 (apply the fix) if the user explicitly asks you to proceed with it.

If the project has a `CONTEXT.md`, read it first for a mental model of the relevant modules, and check ADRs in the area you're touching.

## Redact

This skill has you show commands, outputs, and captured artifacts. **Redact every secret first**: write `<REDACTED>` in its place. Build loops against env vars so the credential stays in the environment rather than in what you show. Captured artifacts carry auth headers — quote only the lines that carry the signal.

If the redacted output isn't enough to diagnose the bug, say so and ask the user.

## Arguments

`$ARGUMENTS` is optional: `<JIRA-ID | AVEN-REF> [SH]`

- **`<AVEN-REF>`** (e.g. `PMR-7KQ9`) — a local aven bug ticket. Bootstraps
  ticket context from aven; status/notes track the session. See Step 0a.
- **`<JIRA-ID>`** (e.g. `IMP-7070`, `DP-92`, `ENG-1234`) — bootstraps ticket
  context and a working branch. See Step 0b.
- **`SH`** — loads `references/sh-environment.md`, which has this project's specific database connection, minikube pod-naming, and cluster-state commands. Only load it when this flag is present — it's project-specific infra detail, not something every debugging session needs. Without it, investigate generically (whatever logs/DB/repro tooling the user has on hand) and ask the user for access if you need something you don't have.

Ref detection: try `aven show <arg> --json` first — if it resolves, it's an
aven ticket. On `unknown-ref`, treat the arg as a Jira ID.

## Step 0a: Aven Bootstrap (when an aven ref resolves)

No plan gate, no branch automation — bug tickets skip the feature lifecycle.

```bash
aven show <REF> --json        # title + description = the bug report
aven edit <REF> --status active
```

Present the ticket summary and ask what broke (same questions as below).
During the session, leave durable findings on the ticket — repro command,
ranked hypotheses, root cause — so a later session can resume:

```bash
aven note <REF> --stdin <<'EOF'
Loop: <the red-capable command>
Hypotheses: <ranked list>
Root cause: <finding + evidence>
EOF
```

Closing (after Phase 5/6 fix, or investigate-only handoff):

```bash
# Fixed: record root cause + commit, close
aven note <REF> --stdin <<'EOF'
Root cause: <...>. Fix commit <hash>. Regression test: <name>.
EOF
aven edit <REF> --status done

# Investigate-only: findings note (above), status stays active
# Root cause reveals a design flaw / big fix → route to feature-plan-aven
```

## Step 0b: Jira Bootstrap (when a JIRA-ID is given)

**Fetch the ticket:**

```bash
task jiraid:$JIRA_ID +jira export
```

Parse JSON. Key fields: `jirasummary`, `jiradescription` (full description, AC, specs), `jirastatus`, `jiraurl`, `jiraissuetype`.

If no task is found:

```
No taskwarrior task found for "$JIRA_ID". Make sure bugwarrior has synced.
Run `bugwarrior pull` to sync, or describe the issue manually.
```

**Create or switch to the ticket's branch:**

```bash
# Check for an existing branch first
git branch --list "*$JIRA_ID*"
```

If none found, call the `jira_create_branch` tool (ships with the `pi-planning` package — shared with the implement-plan skill instead of a per-skill copy):

```
jira_create_branch({ jira_id: "$JIRA_ID", cwd: "<repo root>" })
```

If one exists, check it out:

```bash
git checkout $(git branch --list "*$JIRA_ID*" | head -1 | tr -d ' *')
```

> `jira_create_branch` sets the git-town parent to `develop` and names the branch `<prefix>/$JIRA_ID-<summary-slug>`. Pass `dry_run: true` to preview without creating. Requires the `pi-planning` package's tools to be loaded in this session.

**Present context and ask what broke:**

```
I'll help debug $JIRA_ID — $jirasummary.

Ticket status: $jirastatus
Jira: $jiraurl

Summary:
[parsed jiradescription]

What specific problem are you encountering?
- What were you trying to test/implement?
- What went wrong?
- Any error messages or unexpected behavior?
```

Wait for the user's description before proceeding to Phase 1. When invoked without a Jira ID, ask the equivalent generic questions (what were you working on, what broke, any error/stack trace, when did it last work) and wait for the answer.

## Generic Tooling: Git History

Available in every session regardless of the `SH` flag — correlating with recent changes is often the fastest way to narrow a hypothesis space:

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

## Phase 1: Build a Feedback Loop

**This is the skill.** Everything else is mechanical. If you have a **tight** pass/fail signal for the bug — one that goes red on *this* bug — you will find the cause; bisection, hypothesis-testing, and instrumentation all just consume it. If you don't have one, no amount of staring at code will save you.

Spend disproportionate effort here. **Be aggressive. Be creative. Refuse to give up.**

### Ways to construct one, in roughly this order

1. **Failing test** at whatever seam reaches the bug: unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) that drives the UI and asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real network request / payload / event log to disk; replay it through the code path in isolation.
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** If the bug is "sometimes wrong output," run 1000 random inputs and look for the failure mode.
8. **Bisection harness.** If the bug appeared between two known states (commit, dataset, version), automate "boot at state X, check, repeat" so you can `git bisect run` it.
9. **Differential loop.** Run the same input through old-version vs new-version (or two configs) and diff outputs.
10. **HITL bash script.** Last resort. If a human must click, drive *them* with `scripts/hitl-loop.template.sh` so the loop is still structured. Captured output feeds back to you.

If the `SH` flag is set, `references/sh-environment.md` has ready-made psql/kubectl commands for this stack that can shortcut steps 1–6 — check it before building a loop from scratch.

Build the right feedback loop, and the bug is 90% fixed.

### Tighten the loop

Treat the loop as a product. Once you have *a* loop, **tighten** it:

- Can I make it faster? (Cache setup, skip unrelated init, narrow the test scope.)
- Can I make the signal sharper? (Assert on the specific symptom, not "didn't crash.")
- Can I make it more deterministic? (Pin time, seed RNG, isolate filesystem, freeze network.)

A 30-second flaky loop is barely better than no loop; a 2-second deterministic one is tight — a debugging superpower.

### Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**. Loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. A 50%-flake bug is debuggable; 1% is not, so keep raising the rate until it's debuggable.

### When you genuinely cannot build a loop

Stop and say so explicitly. List what you tried. Ask the user for: (a) access to whatever environment reproduces it, (b) a redacted captured artifact (HAR file, log dump, core dump, screen recording with timestamps), or (c) permission to add temporary production instrumentation. Do **not** proceed to hypothesise without a loop.

### Completion criterion: a tight loop that goes red

Phase 1 is done when the loop is **tight** and **red-capable**: you can name **one command** (a script path, a test invocation, a curl) that you have **already run at least once** (show the invocation and its output, redacted), and that is:

- [ ] **Red-capable**: it drives the actual bug code path and asserts the **user's exact symptom**, so it can go red on this bug and green once fixed. Not "runs without erroring" — it must be able to *catch this specific bug*.
- [ ] **Deterministic**: same verdict every run (flaky bugs: a pinned, high reproduction rate, per above).
- [ ] **Fast**: seconds, not minutes.
- [ ] **Agent-runnable**: you can run it unattended; a human in the loop only via `scripts/hitl-loop.template.sh`.

If you catch yourself reading code to build a theory before this command exists, **stop: jumping straight to a hypothesis is the exact failure this skill prevents.** No red-capable command, no Phase 2.

## Phase 2: Reproduce + Minimise

Run the loop. Watch it go red as the bug appears.

Confirm:

- [ ] The loop produces the failure mode the **user** described, not a different failure that happens to be nearby. Wrong bug = wrong fix.
- [ ] The failure is reproducible across multiple runs (or, for non-deterministic bugs, reproducible at a high enough rate to debug against).
- [ ] You have captured the exact symptom (error message, wrong output, slow timing) so later phases can verify the fix actually addresses it.

### Minimise

Once it's red, shrink the repro to the **smallest scenario that still goes red**. Cut inputs, callers, config, data, and steps **one at a time**, re-running the loop after each cut, and keep only what's load-bearing for the failure.

Why bother: a minimal repro shrinks the hypothesis space in Phase 3 (fewer moving parts left to suspect) and becomes the clean regression test in Phase 5.

Done when **every remaining element is load-bearing**: removing any one of them makes the loop go green.

Do not proceed until you have reproduced **and** minimised.

## Phase 3: Hypothesise

Generate **3–5 ranked hypotheses** before testing any of them. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction it makes.

> Format: "If \<X\> is the cause, then \<changing Y\> will make the bug disappear / \<changing Z\> will make it worse."

If you cannot state the prediction, the hypothesis is a vibe — discard or sharpen it.

**Show the ranked list to the user before testing.** They often have domain knowledge that re-ranks instantly ("we just deployed a change to #3"), or know hypotheses they've already ruled out. Cheap checkpoint, big time saver. Don't block on it; proceed with your ranking if the user is AFK.

## Phase 4: Instrument

Each probe must map to a specific prediction from Phase 3. **Change one variable at a time.**

Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses. If `SH` is set, `references/sh-environment.md` has the pod/namespace discovery commands for pulling those logs.
3. Never "log everything and grep."

**Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`. Cleanup at the end becomes a single grep. Untagged logs survive; tagged logs die.

**Perf branch.** For performance regressions, logs are usually wrong. Instead: establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.

If data state is in question, `references/sh-environment.md` (when `SH` is set) has the nonprod database queries for inspecting record state, migrations, and constraint violations.

## Phase 5: Fix + Regression Test

Only do this phase if the user has asked you to proceed with the fix itself — otherwise stop after Phase 4 and report findings (see Output Format).

Write the regression test **before** the fix, but only if there is a **correct seam** for it.

A correct seam is one where the test exercises the **real bug pattern** as it occurs at the call site. If the only available seam is too shallow (single-caller test when the bug needs multiple callers, unit test that can't replicate the chain that triggered the bug), a regression test there gives false confidence.

**If no correct seam exists, that itself is the finding.** Note it. The codebase architecture is preventing the bug from being locked down. Flag this for the next phase.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.

## Phase 6: Cleanup

Required before declaring done (only applies once Phase 5 has run):

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] Regression test passes (or absence of seam is documented)
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway prototypes deleted (or moved to a clearly-marked debug location)
- [ ] The hypothesis that turned out correct is stated in the commit / PR message, so the next debugger learns

## Output Format (default: investigate-only)

When stopping at Phase 4 without applying a fix, present:

```
## Debug Findings

### What I investigated:
- Feedback loop: [the exact command/script, and what it asserts]
- Logs / DB / infra: [pod name+namespace, tables/queries, or "none — generic session"]
- Git: [commits/files reviewed]

### What I found:
- [Specific finding with evidence — log line, query result, commit hash]
- [Corroborating detail]

### Root cause hypothesis:
[Concise explanation of what's wrong and why, referencing the ranked hypothesis from Phase 3 that held up]

### Recommended next steps:
1. [Specific action to fix or verify]
2. [Follow-up check]
```

## Important Guidelines

1. **Investigate by default, fix only when asked** — surface findings and a hypothesis; only apply a fix and run Phase 5–6 if the user explicitly says to proceed.
2. **Show evidence** — always quote the specific log line, query result, or git commit supporting a conclusion.
3. **A tight feedback loop beats staring at code** — don't skip Phase 1 to jump to a hypothesis, even under time pressure.
4. **Redact secrets** in everything you show, per the Redact section above.
5. **Ask before assuming scope** — if the issue could span multiple services, ask which to focus on first.
6. **Load `references/sh-environment.md` only when `SH` is passed** — it carries project-specific credentials/commands that don't belong in a generic debugging session.
