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

## Style and code conventions

- TypeScript is strict (`tsconfig.json`) and ESM (`type: module`). Keep explicit `.ts` suffixes on local imports.
- Formatting and linting via **Biome** (`biome.json`). Run `bun run format` / `bun run lint`. Do not hand-format large blocks.
- No ternary expressions in TypeScript — prefer clear `if` / `else` assignments.
- Avoid `any`, `@ts-ignore`, and unchecked prototype assumptions. Use narrow structural types for Pi internals.
- Conventional Commit subjects: `fix(pi-tree): ...`, `feat(pi-mention-skill): ...`.

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
- Keep README install snippets and the root package table in sync when adding/removing packages.
