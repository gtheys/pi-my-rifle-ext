# Quickstart

`pi-my-rifle-ext` is a personal **pi coding-agent package**: a bun workspace monorepo
of extensions, skills, prompt templates, and a theme that plug into
[pi](https://github.com/earendil-works/pi-coding-agent) (the CLI coding agent this repo
is built for). It is not a standalone app — there's nothing to "run"; you load it into
pi's `settings.json` and its extensions/skills become available inside pi sessions.

Source: `package.json:1`, `README.md:1`

## Install / load it

```json
// ~/.pi/agent/settings.json (or wherever pi reads packages from)
{
  "packages": ["/home/geert/Code/personal/pi-my-rifle-ext"]
}
```

Companion packages (token compression, commit-message compaction, ponytail persona,
intercom) are **installed separately**, not vendored here — see `README.md` "Usage"
section for the `pi install` commands.

## Local dev setup

```bash
mise install     # pin bun via mise.toml
mise run setup   # bun install + lefthook hooks

mise run format      # biome format + safe fixes
mise run lint        # biome check
mise run typecheck   # tsc --noEmit over packages/**
mise run test        # workspace tests (node --test)
mise run check       # lint && typecheck && test
```

Git hooks (`lefthook.yml:1`): pre-commit runs biome on staged `packages/**` files;
pre-push runs the full `check` pipeline. There is no build step — extensions are
loaded as TypeScript source directly by pi's runtime.

## Repo layout

```
pi-my-rifle-ext/
├── packages/       # bun workspace packages — one per pi extension group
├── skills/         # SKILL.md-driven agent skills (engineering/productivity/tools)
├── prompts/        # slash-command prompt templates
├── themes/         # theme JSON (tokyo-night)
├── agents/AGENTS.md  # symlinked to ~/.pi/agent/AGENTS.md by pi-bootstrap on startup
├── mise.toml, biome.json, lefthook.yml, tsconfig.json
```

Each `packages/*` directory is its own workspace member with a `package.json`
declaring `pi.extensions` (paths registered with pi) and `peerDependencies` on
pi's own packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, etc.)
— never bundled, always resolved from the host pi install.

## Where to go next

- [Architecture overview](architecture/overview.md) — how pi loads these extensions,
  the tool/command/event model, shared conventions (AIDEV-NOTE, ponytail comments).
- [Extension reference](architecture/extensions.md) — what each package under
  `packages/` does, its tools/commands, and key implementation notes.
- [Planning & implementation workflow](workflows/planning-and-implementation.md) —
  how Jira → taskwarrior → spec → phased implementation works end to end.
- [Code review workflow](workflows/code-review.md) — `/review`, `/sonarqube`,
  `/pr-quality`, `/pr-watch`.
- [Skills & prompts](domain/skills-and-prompts.md) — inventory of `SKILL.md` files and
  when the agent should use them.
- [Glossary](domain/glossary.md) — project-specific terms (phase, subtask, work_state,
  spec annotation format, etc).

## Conventions to know before touching code

- **`AIDEV-NOTE:` / `AIDEV-TODO:` / `AIDEV-QUESTION:`** comments mark non-trivial,
  confusing, or important code for both humans and agents. Grep for them before
  editing a file (`agents/AGENTS.md:1`). Never delete them without explicit instruction.
- **`ponytail:`** comments mark a deliberate simplification with a named ceiling
  (e.g. "global lock, per-account locks if throughput matters") — this repo is
  written in a YAGNI/lazy-first style; see `packages/pi-planning/plan-tools/index.ts:34`
  for an example.
- Root `tsconfig.json` typechecks all of `packages/**`; `biome.json` scopes lint/format
  to `packages/**` only (skills/prompts/themes are plain markdown/JSON, not linted).
- No test framework beyond Node's built-in `node --test` — see `pi-review` and
  `pi-sem` `package.json` `"test": "node --test"` scripts.
