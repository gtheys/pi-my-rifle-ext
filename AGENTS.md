## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:
- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

---

## Project shape

- TypeScript ESM npm workspaces monorepo. Packages live under `packages/*` and expose entrypoints through each package's `pi.extensions` manifest.
- Extensions run inside Pi with user-level permissions. Treat config parsing, filesystem writes, and monkey-patches of Pi internals as high-risk changes.

## Per-package verification commands #verification

- **Scope a package's suite with `cd`, never with `-w`**:

  ```bash
  cd packages/<pkg> && bun run test     # the gate for a subtask/oneshot
  ```

  `bun run test -w <pkg>` is broken here: bun expands it to
  `bun run --workspaces --if-present test -w <pkg>`, so the `-w` leaks into every
  other workspace's test script — those fail with `error: Invalid Argument '-w'`
  (`pi-sem` exits 9), and the whole command exits 1 even when the target
  package's suite is fully green. Root `bun run test` (no `-w`) is the
  all-workspaces suite; that is the correct, slower landing-gate command.
- **From the repo root** the equivalent scoped forms are
  `bun run --filter @gtheys/<pkg> test` and `bun run --cwd packages/<pkg> test`;
  both run only that package and neither leaks flags.
- Plan/subtask acceptance criteria and flow artifacts must print the `cd` form —
  see the `feature-plan-aven` and `implement-plan-aven` skills.

## Style and code conventions

- TypeScript is strict (`tsconfig.json`) and ESM (`type: module`). Keep explicit `.ts` suffixes on local imports.
- Formatting and linting via **Biome** (`biome.json`). Run `bun run format` / `bun run lint`. Do not hand-format large blocks.
- No ternary expressions in TypeScript — prefer clear `if` / `else` assignments.
- Avoid `any`, `@ts-ignore`, and unchecked prototype assumptions. Use narrow structural types for Pi internals.
- Conventional Commit subjects: `fix(pi-tree): ...`, `feat(pi-mention-skill): ...`.
- **Markdown diagrams are code.** ` ```mermaid ` fences in `docs/` render on GitHub and are
  linted by `bun run check:mermaid` (`scripts/check-mermaid.mjs`, wired into lefthook
  pre-commit for `**/*.md` and into `bun run check`). Two rules bite hardest:
  a `stateDiagram` state ID **rejects `-` and `.`**, so never use a lifecycle label
  (`review-passed`) as a state name — states are the phases and the label belongs in
  the transition text; and `<br/>` / raw `<placeholder>` are unsupported there, so
  write placeholders in words (#docs-diagrams).

## Commit discipline #mechanism-vocabulary

- **Replaced a mechanism in a commit?** Re-grep the branch's own comments and docs
  for the vocabulary of the mechanism it replaced (old names, flags, env vars,
  states) and update every stale reference the sweep finds.
- **Before writing a NEW mechanism claim into a comment or doc**, verify the
  mechanism in the code and cite the seam — the function/file that implements it
  (e.g. `packages/pi-flow/plan-tools/helpers.ts`) — rather than restating an
  upstream narrative.
- This is a **manual** checklist, not an automated grep gate: past-tense
  historical prose describing what a mechanism *used to* do stays allowed; only
  current-tense mechanism claims must match the code.

## Flow document paths #paths

Every flow document — `plan.md`, Jira specs, brainstorm research, scout findings, review artifacts, generic notes, PR descriptions — follows the env-var standard. This section is the **single source of truth** for the layout; OpenWiki and `docs/piv-flow*.md` reference it instead of restating the full shape.

- **Each resolver reads exactly one env var** — there is no cross-fallback between them:
  - `resolve_feature_path` reads `$PERSONAL_FEATURES` (personal mode) → `$PERSONAL_FEATURES/<repo>/…`.
  - `resolve_spec_path` and `resolve_notes_path` read `$LLM_NOTES_ROOT` (work mode) → `$LLM_NOTES_ROOT/<repo>/notes/…`.
- **A resolver's env var is unset:** that resolver uses the repo-local fallback (`<git-toplevel>/…`) only. A repo-local write is never taken while its own env var is set.
- **Outside a git repository all three resolvers fail fast (throw):** no relative-path fallback, and with an env root set but no derivable repo name (no origin remote, no git toplevel) no silent `<root>/unknown/` directory — the resolvers refuse instead.
- **`<repo>`** is the origin remote name (basename of `git remote get-url origin`, `.git` stripped), falling back to the `git rev-parse --show-toplevel` basename when there is no remote — so herdr worktrees don't scatter docs into per-worktree directories.
- **Paths come from the pi-flow resolver tools — never hand-rolled:**
  - `resolve_feature_path` — personal `plan.md` (and its directory, the shared artifact dir for `scout-context.md` / `review.md`).
  - `resolve_spec_path` — Jira-linked specs (`…/notes/specs/<JIRA>__<slug>.md`).
  - `resolve_notes_path` — generic notes paths; takes a `subdir` from a fixed allowlist (`""` for the notes root, `prs`, `specs`, `research`, `tickets`) and returns `$LLM_NOTES_ROOT/<repo>/notes[/<subdir>]` (or the repo-local fallback).
- **Brainstorm research** uses the same env-var standard with `notes/brainstorm/` as the fixed subdir, but its env root is mode-dependent (work → `$LLM_NOTES_ROOT`, personal → `$PERSONAL_FEATURES`; see `MODE_PROFILE[mode].artifactRootEnv`). pi-flow exposes this internally as `resolveBrainstormDir` (`packages/pi-flow/brainstorm/paths.ts`) rather than as a registered resolver tool, because the subdir is not configurable.
- **AIDEV comments near resolver tools in `packages/pi-flow/plan-tools/helpers.ts` are the inline record of these contracts** — update them together with this section.

## Extension-specific guidance

- Packages are independently installable. Avoid cross-package runtime dependencies unless the target is published and declared in the consuming package.
- Env vars for secrets, CI/session overrides, or explicit config-path overrides only — not ordinary persistent extension options.
- Prefer `getAgentDir()` from `@earendil-works/pi-coding-agent` when reading Pi agent files, so `PI_CODING_AGENT_DIR` and Pi's path resolution stay consistent.
- Prototype monkey-patches must be idempotent. Keep `Symbol.for(...)` patch markers; only set them after required prototype methods/modules are verified.
- Dynamic imports of Pi internal files must fail gracefully with a clear warning — a Pi minor release must not crash startup because an internal component moved.

## Pi Extension Config

- Only extensions with user-configurable behavior need extension-owned config. Do not put extension runtime options in Pi's core `settings.json`.
- Use JSON config only.
- Global config path: `getAgentDir()/pi-<name>/config.json`. Project override path: `ctx.cwd/CONFIG_DIR_NAME/pi-<name>/config.json`.
- Always use `getAgentDir()` and `CONFIG_DIR_NAME` from `@earendil-works/pi-coding-agent` — never hardcode `~/.pi/agent` or `.pi`.
- Parse config at the boundary: `JSON.parse` → `unknown`, validate with **TypeBox**, then pass typed config inward. Never cast `JSON.parse` output directly to a config type.
- Keep a checked-in `config.schema.json` in sync with the TypeBox schema for every extension-owned config file.
- Scaffold default global config only when missing, or provide an explicit setup command. Never overwrite existing or malformed user config.
- Create `config.schema.json` when missing; refresh it from the bundled checked-in schema when stale.
- Do not auto-create project config unless an explicit command already does that.

## README config docs

- Only include a Configuration section for packages with meaningful user-facing settings.
- Structure: (1) one sentence naming the concrete global path, (2) compact option table (Option, Type, Default, Description using dot-path keys), (3) full default-config JSON example including `$schema`.
- The JSON block must be the full default config — do not omit settings just because they equal the default.
- Do not mention project overrides, TypeBox, `getAgentDir()` / `CONFIG_DIR_NAME`, schema refresh mechanics, or overwrite policy in READMEs — keep those in `AGENTS.md` or source.

## Packaging notes

- Package manifests include `files` allowlists. Verify with `npm pack --dry-run -w <workspace>` before changing a manifest.
- The default pi-flow test suite enforces the `files` allowlist reachability gate (`packages/pi-flow/test/packaged-allowlist.test.ts`); `bun run audit:pack` remains the all-workspace release audit.
- Keep README install snippets and the root package table in sync when adding/removing packages.
