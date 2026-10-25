# Detailed Checklists

Load this when reviewing a large repo or when the user wants depth. Each section is independent.

## Contents
1. tsconfig and compiler settings
2. Import graph and cycles
3. Public API and package boundaries
4. Type design
5. Runtime validation and trust boundaries
6. Module system (ESM/CJS)
7. Migration health
8. Tooling that enforces architecture
9. Useful commands

---

## 1. tsconfig and compiler settings

- `strict: true` at the root that new code inherits. If not, is there a plan?
- Extra safety worth enabling: `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables` (part of strict), `exactOptionalPropertyTypes` (judgment call).
- `allowJs` without `checkJs` means JS is compiled but not checked: it contributes `any`-ish types to TS consumers. Prefer `checkJs` per folder or `// @ts-check` per file during migration.
- `skipLibCheck: true` is common and acceptable, but note it hides broken `.d.ts` in your own typings if they live in the project.
- `isolatedModules` / `verbatimModuleSyntax`: required for most bundlers and transpilers (esbuild, swc, Babel, Vite). Check `import type` is used for type-only imports.
- Project references (`composite`, `references`) in monorepos: are packages built in dependency order, and do they actually enforce boundaries?
- Path aliases (`paths`): are they mirrored in the bundler, test runner, and runtime resolver? Mismatches cause "works in tsc, fails at runtime".
- Multiple tsconfigs (app, node, test, build): does each include only what it should? Test files leaking into production builds, or the reverse.

## 2. Import graph and cycles

- Any cycle in core/domain code is High or Critical. Cycles between feature folders are Medium to High. Type-only cycles (`import type`) are far less harmful at runtime but still signal tangled ownership.
- Deep relative imports (`../../../`) usually mean a missing package or alias boundary.
- Imports that cross layer direction (domain → UI, domain → framework, lib → app).
- Files with very high fan-in (imported by most of the repo) are stability risks: changes ripple everywhere. Are they stable abstractions or accidental hubs (`utils.ts`, `constants.ts`, `types.ts`)?
- Files with very high fan-out (import 15+ modules) are probably doing orchestration and too much else.
- Test files importing internals of source files rather than public API.

## 3. Public API and package boundaries

- Each package/feature has a single entry (`index.ts` or `exports` map) that defines what is public.
- `package.json` `exports` present and correct (types, import, require conditions) for published or shared packages.
- Internal helpers not re-exported.
- Barrel rules: barrels at package edges are fine; barrels inside a package that everything imports from cause cycles and slow tooling.
- `export *` hides what is public and can leak names accidentally. Prefer explicit named re-exports at API boundaries.
- Default exports vs named: mixed use hurts refactoring and ESM/CJS interop; check for consistency.
- Side-effect imports (`import './setup'`) and import-time work (opening connections, reading env) should be rare and explicit.

## 4. Type design

- Types describe domain concepts, not just shapes copied from the database or API.
- Discriminated unions for states instead of optional-field bags (`{loading?: boolean; error?: ...; data?: ...}`).
- Branded/opaque types for IDs where mix-ups are plausible and costly.
- Avoid exporting giant inferred types (`ReturnType<typeof bigFn>`) as public API; define them explicitly.
- Generic constraints are meaningful; no `<T = any>` defaults at boundaries.
- `enum` vs union of string literals: be consistent; `const enum` and `isolatedModules` do not mix well.
- Duplicate type definitions of the same entity across packages (front end, back end, shared) drift apart.
- `Record<string, any>`, `object`, `Function`, `{}` as types are placeholders for real contracts.

## 5. Runtime validation and trust boundaries

Check each: request bodies/params/headers, env vars, `JSON.parse`, database rows when not typed by the ORM, `localStorage`/cookies, `postMessage`, webhooks, file uploads, third-party API responses, feature-flag payloads, data read from untyped JS modules.

- Is there a schema, and is the TS type derived from it (or vice versa) so they cannot drift?
- Is validation at the edge, with the interior trusting validated types?
- Are errors from validation mapped to a consistent response/error shape?
- Is config loaded and validated once at startup, then injected, rather than `process.env.X` scattered through the code?
- Security-relevant: authorization checks colocated with trust boundary, not left to each handler to remember; untrusted input never reaches `eval`, `new Function`, dynamic `require`/`import`, shell, or SQL string building.

## 6. Module system (ESM/CJS)

- `"type": "module"` or not; extensions in imports (`.js` needed in Node ESM even for `.ts` sources with `moduleResolution: node16/nodenext`).
- `module` / `moduleResolution` consistent with the actual runtime and bundler (`bundler` vs `nodenext`).
- `require` inside ESM files or `import` of CJS-only packages with default-export interop issues (`esModuleInterop`, `allowSyntheticDefaultImports`).
- Dual-package hazards for libraries publishing both formats.
- Top-level `await` only where the target supports it.
- Test runner (Jest/Vitest/node:test) config matches the module system; Jest + ESM is a frequent pain point.

## 7. Migration health

- Ratio and trend of `.ts/.tsx` vs `.js/.jsx` (check git history if available: is JS shrinking?).
- Are there files that are TS in name but full of `any` (migration in name only)?
- Is there a documented order and ownership for migration, or is it ad hoc?
- Ratchet: CI check that counts `any`, `@ts-ignore`, `@ts-nocheck`, or untyped files and fails on increase.
- Shims/adapters between legacy JS and new TS: tracked and temporary, or growing?
- Duplicate implementations (old JS util and new TS util both used).

## 8. Tooling that enforces architecture

Recommend only what fits the repo size and team habits.

| Need | Tools |
|---|---|
| Import cycles | `madge --circular`, `dpdm`, `eslint-plugin-import` (`import/no-cycle`), `dependency-cruiser` |
| Layer/boundary rules | `dependency-cruiser`, `eslint-plugin-boundaries`, `no-restricted-imports`, Nx module boundaries, `@typescript-eslint` rules |
| Dead code / unused exports | `knip`, `ts-prune` (unmaintained; prefer knip), `depcheck` |
| Type coverage | `type-coverage`, `typescript-eslint` `no-explicit-any`, `ban-ts-comment` |
| Dependency hygiene | `npm ls`, `pnpm why`, `npm audit`, `syncpack` for version drift in monorepos |
| Bundle impact | `source-map-explorer`, `vite-bundle-visualizer`, `webpack-bundle-analyzer` |

## 9. Useful commands

```bash
# Language mix
git ls-files '*.ts' '*.tsx' | wc -l; git ls-files '*.js' '*.jsx' '*.mjs' '*.cjs' | wc -l

# Escape hatches
grep -rEn --include='*.ts' --include='*.tsx' '@ts-(ignore|nocheck)' src | wc -l
grep -rEn --include='*.ts' --include='*.tsx' ':\s*any\b|as any\b|as unknown as' src | wc -l

# Cycles
npx madge --circular --extensions ts,tsx,js,jsx src
npx dpdm --no-warning --no-tree src/index.ts

# Unused files/exports/deps
npx knip

# Type check including JS
npx tsc --noEmit -p tsconfig.json
```
