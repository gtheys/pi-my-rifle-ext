# Plan: PMR-WSTK — spec-publish root mismatch + open-in-pane apostrophe quoting

Epic: PMR-WSTK (aven, project pi-my-rifle-ext)
Research: /home/geert/Code/salaryhero/llm-notes/pi-my-rifle-ext/notes/research/2026-10-25-pmr-wstk.md
Origin: PMR-MR36 review round 1 (P2 findings)

## Tree

- PMR-WSTK (epic, label: plan)
  - PMR-7FEP — Derive spec-publish root from planPath prefix
  - PMR-0710 — Fix apostrophe shell-quoting in both open-in-pane copies

## Execution order

Children are independent (disjoint files, disjoint test suites). No dependency
links encoded. Either order lands; suggested: PMR-7FEP first (larger change,
reworks an existing test file), PMR-0710 second.

## Per-child intent

### PMR-7FEP — Derive spec-publish root from planPath prefix

Bug: `/spec-publish` derives `mode` from the repo toplevel
(`modeForToplevel`, packages/pi-flow/index.ts:1377) and `resolvePublishRoot`
(packages/pi-flow/spec-review/publish.ts:26) picks `LLM_NOTES_ROOT` for work
mode. Local (non-Jira) plans live under `PERSONAL_FEATURES/<repo>/` or
`<toplevel>/.pi/plans/` in ANY mode (plan/paths.ts:10-22 is
mode-independent), so the publish worker `git add`s a file outside its root.

Fix:

1. `resolvePublishRoot`: derive the root from the planPath prefix. Match
   `LLM_NOTES_ROOT/<repo>/` and `PERSONAL_FEATURES/<repo>/` on the full
   `<root>/<repo>/` boundary (bare startsWith on the root alone mis-matches
   sibling repos with prefix-colliding names). Keep the existing
   trailing-slash normalization.
2. Keep the toplevel fallback for plans under `.pi/plans` and the error when
   neither env var is set and no toplevel exists.
3. `mode` likely drops from the signature — check the ripple at
   index.ts:1377-1383 (`modeForToplevel` stays; it is also used at
   index.ts:396 for phase routing).
4. Tests: rework all six mode-keyed cases in
   test/spec-review-publish.test.ts:53+. Add: work-mode + PERSONAL_FEATURES
   planPath (the reported bug), planPath under `.pi/plans` → toplevel.
5. Docs: document the local-plan publish root in docs/aven-feature-flow.md
   (~line 115 covers only the Jira-spec side).

### PMR-0710 — Fix apostrophe shell-quoting in both open-in-pane copies

Bug: `` `${command} '${absFile}'` `` is typed into a herdr pane whose shell
parses it; a `'` in the path breaks the command. herdr `send-text`/`run` both
type literally — quoting is the caller's responsibility.

Fix:

1. BOTH copies (deliberate duplication; pi-planning is source of truth per
   AIDEV-NOTE):
   - packages/pi-planning/plan-tools/open-in-pane.ts:63
   - packages/pi-flow/spec-review/open-in-pane.ts:63
2. Inline `absFile.replace(/'/g, "'\\''")` (same one-liner as `shellEscape`
   in pi-interactive-subagents surface.ts:149-151; cross-package imports are
   forbidden, so duplicate). Also quote the `nvim ${absFile}` fallback text
   in the catch branch.
3. Keep the two copies byte-in-sync apart from the existing header/export
   differences.
4. Regression test: fake `pi` with a recording `exec`, assert argv[3] of the
   `send-text` call equals the fully quoted string
   (`nvim '/tmp/it'\''s.md'`). The `existsSync` guard needs a real or stubbed
   file. pi-planning's minimal test file: packages/pi-planning/test/test.ts.

## Out of scope

- Migrating pi-planning plan functionality into pi-flow — tracked separately
  as PMR-ZH85.
- Hardening the self-generated `bash ${scriptPath}` send-text sites in
  pi-interactive-subagents (herdr.ts:208, surface.ts:123) — low risk, optional.

## Risks

- All six existing resolvePublishRoot tests encode the old mode-keyed
  semantics — re-audit each, don't just append.
- Prefix matching must respect the `<root>/<repo>/` boundary (see above).
- The two open-in-pane copies must stay in sync (AIDEV-NOTE obligation).
