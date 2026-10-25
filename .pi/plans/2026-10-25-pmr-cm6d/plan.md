# Plan: PMR-CM6D — mock-herdr for lifecycle itests, real skip gates, cleanup guard

Epic: PMR-CM6D (aven, project pi-my-rifle-ext, label: plan)
Research: /home/geert/Code/salaryhero/llm-notes/pi-my-rifle-ext/notes/research/2026-10-25-pmr-cm6d.md
Rescoped 2026-10-25: original defect 1 (ambient-repo commits) is explained and
fixed by PMR-S6W3 (9245877); defect 2 (red in non-herdr contexts) is stale —
itests are excluded from `bun run check` and no-op outside herdr.

## Tree

- PMR-CM6D (epic)
  - PMR-X8MS — Build mock-herdr PATH shim fixture
  - PMR-RNW2 — Migrate herdr-verbs and mux-surface itests to mock herdr (blocked by PMR-X8MS)
  - PMR-9RP0 — Real skip gates and herdr worktree cleanup-collision guard (blocked by PMR-RNW2)

## Execution order

Strictly sequential, dep-linked: PMR-X8MS → PMR-RNW2 → PMR-9RP0.
(9RP0's skip gates must not fight RNW2's mock-mode gates in the same files.)

## Per-child intent

### PMR-X8MS — Build mock-herdr PATH shim fixture

New fixture `packages/pi-interactive-subagents/test/mock-herdr.ts` that
materializes a fake `herdr` binary into a mkdtemp bin dir. Precedents:
`test/herdr-stderr.test.ts:16-35` (fake herdr on PATH),
`pi-flow/test/aven-workspace-cwd.test.ts` (fake aven on PATH). Single seam:
`runHerdr` = `execFileSync('herdr', args)` at
`pi-extension/subagents/herdr.ts:60` — PATH shim only, zero production-code
changes.

Contract (full detail in the research artifact):

- Raw-text verbs: `--version`; `status --json` (version ≥ 0.9.1);
  `pane send-text|send-keys|run|read|close`; `tab close`; `workspace focus`;
  `tab focus`; `agent focus`; `agent read --format text`.
- Envelope verbs (`{id,result}` / `{error:{code,message}}`): `pane list`;
  `pane get` (missing → exit 1 + error envelope — `herdrPaneAlive` keys off
  exit 1); `pane layout --pane`; `pane wait-output --regex --timeout`;
  `tab create/list`; `agent start/list/get`.
- Stateful across processes: each `execFileSync` is a fresh shim process, so
  pane/tab/agent registries persist in a state file inside the shim dir.
  A pane = a log file + a `bash -c` child for `pane run`/`send-text`;
  `wait-output` polls the log for the regex until timeout.

Acceptance criteria: every verb above with correct envelope/exit semantics;
unit tests for the shim (state persistence, wait-output match + timeout,
agent registry); `node --test` green in the package.

### PMR-RNW2 — Migrate herdr-verbs and mux-surface itests to mock herdr

Blocked by PMR-X8MS. Gate logic per suite: `HERDR_PANE_ID` set → real herdr,
exactly as today (no behavior change inside a live herdr session); unset →
prepend the shim bin dir to PATH in `before` (save/restore in `after`) and
run the whole suite against the mock.

Files: `test/integration/herdr-verbs.itest.ts` (4 tests),
`test/integration/mux-surface.itest.ts` (9 tests).

Fidelity watchlist: `waitShellReady` (spawn.ts:151-180, tests pass 15s);
server-side `pane wait-output` regex semantics; `herdrPaneAlive` exit-1
contract; `agent list/get` shapes the suites assert on. No test may spawn a
real pi/LLM session in mock mode.

Acceptance criteria: both suites green with `HERDR_PANE_ID` unset
(`node --test --test-concurrency=1 --test-force-exit` on both files); both
still pass (or correctly gate) with real herdr; unit suite unaffected.

### PMR-9RP0 — Real skip gates and cleanup-collision guard

Blocked by PMR-RNW2 (same files' gates). Two nits:

1. The 5 warn-only itest files (worktree, subagent-lifecycle, mux-surface,
   herdr-verbs, assignments) get describe-level
   `{ skip: !isHerdrIntegrationAvailable() }` — except herdr-verbs and
   mux-surface, which run in mock mode instead of skipping.
2. `test/test.ts:4461` and `:4498` `rmSync(~/.herdr/worktrees/<basename(repo)>)`
   can delete a real same-named repo's worktree dir. Only remove paths the
   test itself created (track created paths, or verify the dir belongs to
   the fixture temp repo before removing). Prove a same-basename real repo
   dir survives.

Acceptance criteria: herdr-less run reports skipped (not passed) for gated
suites; cleanup provably touches only fixture-owned dirs; `node --test`
green.

## Out of scope

- Fake `pi` shim for the real-LLM suites (subagent-lifecycle, assignments,
  worktree itests) — separate, larger ticket if ever wanted.
- Production-code changes — the seam is PATH; none expected.
- `owner-inbox` and `peers` itests — file-based, already herdr-free.

## Risks

- Mock fidelity drift: the shim hand-reimplements herdr's CLI contract
  (envelopes, exit codes, `pane get` exit-1). Mitigate: implement only the
  verbs the two suites use; version-pinned `status --json`; unit-test the
  shim itself.
- Opt-in must never shadow a real herdr session: shim only when
  `HERDR_PANE_ID` is unset, PATH restored in `after`.
- `wait-output` semantics (server-side regex wait vs mock log polling) must
  match closely enough for `waitShellReady` and screen polling.
