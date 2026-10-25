---
name: ts-js-architecture-review
description: Architecture and code-structure review for TypeScript codebases that are mixed with JavaScript (allowJs, JSDoc-typed JS, partial migrations, Node/React/monorepo stacks). Use whenever the user asks to review architecture, module boundaries, dependency direction, circular imports, coupling/cohesion, layering, type-safety at the JS/TS seam, migration progress, barrel files, ESM/CJS issues, or design decisions before implementation in a TS/JS repo. Trigger even if they only say "review this codebase", "is this structure ok", "audit our TS/JS code", or "where are the weak spots", as long as the code is TypeScript and/or JavaScript.
---

# TypeScript + JavaScript Architecture Review

Structured review for repos where TypeScript and JavaScript coexist. The mixed state is the main thing to review: most real defects in these codebases live at the seam where typed code trusts untyped code, and in the dependency tangles that accumulate during gradual migration.

Review the structure first, style second. Linting nitpicks, formatting, and naming taste are out of scope unless they hide a structural problem.

## Workflow

1. **Scope.** Confirm what is under review (whole repo, a package, a folder, a diff). If the user gave none, review the whole repo but say so.
2. **Prepare CodeGraph if available.** Run `bash scripts/codegraph_prep.sh <repo-root>`. If it ends in `CODEGRAPH=ready`, the index has just been synced and you use it for the structure, dependency, and impact steps below (see "Using CodeGraph"). Otherwise follow the fallback in that section.
3. **Run the scan.** Execute `scripts/scan.py <repo-root>` for an objective baseline (language mix, strictness flags, type escape hatches, barrel files, import cycles if tooling is available). Read its output before forming opinions. If the script cannot run, do the same checks by hand with grep.
4. **Map the structure.** Identify packages/layers/feature folders, entry points (`main`, `exports`, route files, `index.*`), and the runtime targets (browser, Node, edge, tests). If the repo is too large to explore yourself, or a question needs deeper digging than the scan and graph answer, delegate it to the `scout` subagent (see "Delegating exploration to scout").
5. **Trace dependencies.** Who imports whom, in which direction, and where the cycles are. Sample the largest and most-imported files rather than reading everything.
6. **Inspect the JS/TS seam** using the section below. This is where this skill adds the most value.
7. **Apply the checklists** (see below; read `references/checklists.md` for the detailed items when the repo is large or the user wants depth).
8. **Report** using the output template. Prioritize by impact and effort; do not dump every observation.

Read the code before judging it. Findings must cite specific files, and where possible lines or imports, so the user can verify them.

## Using CodeGraph

CodeGraph is a local semantic code graph (symbols, call graph, import and reference edges, impact radius) that agents query instead of grepping. When it is available it is faster and more accurate than text search for architecture questions, so prefer it.

**Detect and sync.** `scripts/codegraph_prep.sh` checks for the CLI and a `.codegraph/` index, then runs `codegraph sync` (incremental, safe) so findings reflect the current working tree. Always sync before querying: a stale index gives confident wrong answers. Act on the final `CODEGRAPH=` line:

- `ready`: use CodeGraph as described below.
- `sync-failed`: say the index may be stale, and verify any graph-derived claim by reading the file.
- `no-index`: tell the user CodeGraph is installed but not initialized for this repo and offer `codegraph init -i`. Do not run it unasked, because it creates `.codegraph/` in their repo. Continue with the fallback meanwhile.
- `missing`: continue with `scripts/scan.py` and grep. Do not mention CodeGraph again unless the user asks, and do not try to install it.

**Use it through MCP tools if connected** (`codegraph_search`, `codegraph_context`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_node`, `codegraph_files`, `codegraph_status`), otherwise through the CLI (`codegraph query <symbol>`, `codegraph context "<task>"`, `codegraph status`). Tool names can differ by version, so list what is actually available rather than assuming.

**Where it helps this review:**

| Review question | CodeGraph use |
| --- | --- |
| What are the modules and entry points? | `files` / `context` on the repo's main flows; route nodes for Express and Nest handlers |
| Who depends on this module? Is it a hub? | `callers` on its main exported symbols; compare with scan.py fan-in |
| Does domain code reach into UI or infra? | `callees` from domain symbols; look for edges crossing layers |
| What breaks if we change or split this God module? | `impact` on its key symbols, and cite the radius in the finding |
| Is this export dead or truly public? | `callers` returning nothing outside its own package |
| Which JS callers use this typed API unsafely? | `callers` filtered to `.js` files, then read the call sites |

**Rules for using graph results:**

- Use `impact` to size findings. "Changing `UserService` affects 41 symbols across 3 packages" is a stronger finding than "UserService is big".
- Cross-check cycles. Compare graph edges with `scan.py` cycles. They can disagree (the scan ignores path aliases, the graph may not resolve dynamic imports). Disagreements are worth a line in the report, not a silent pick.
- The graph shows structure, not intent or types. It cannot see `any` leakage, strictness flags, or runtime validation, so still run the JS/TS seam checks from `scan.py` and by reading code.
- If a response warns that a file has pending changes, read that file directly instead of trusting the graph for it.
- Note in the report's Scope line whether CodeGraph was used and when it was synced, so the reader knows how the structure data was obtained.

## Delegating exploration to scout

When you need more detail about the codebase than `scan.py` and CodeGraph give you (unfamiliar packages, a suspicious module you must understand end to end, many independent areas to survey), delegate the digging to the subagent named `scout` instead of reading everything in your own context. This keeps the main review focused on judgment while scout does the legwork.

**Check it exists first.** Use `scout` only if a subagent with that name is available in this session. If it is not, explore directly yourself, sampling the largest and most-imported files, and carry on without mentioning scout.

**Delegate questions, not "go look around".** Each scout task should be a narrow, answerable question with a defined scope. Good examples:

- "In `packages/billing`, list every module that imports from `packages/ui` or `react`, with file and import line."
- "Summarize what `src/services/order.ts` is responsible for, its exports, and everything it imports, in under 150 words."
- "Find all places where `process.env` is read outside `src/config/`."
- "Which `.js` files are imported by `.ts` files in `apps/web`, and how is each typed (JSDoc, `.d.ts`, or untyped)?"

**Brief it properly.** Every scout task should include:

1. The exact question and the directory scope.
2. Read-only instructions: scout explores and reports, it does not edit files, run migrations, install packages, or run `codegraph init`.
3. A pointer to the best tools: if the prep script reported `CODEGRAPH=ready`, tell scout to use CodeGraph (callers, callees, impact, search) before grepping; mention `scan.py` output if relevant.
4. The return format: a compact list of findings, each with a file path (and line when possible), plus a one-line "could not determine" for anything it could not verify. Ask for facts and evidence, not opinions or severity ratings; judging is your job.

**Parallelize independent areas.** For a monorepo or several unrelated questions, launch one scout per package or question at the same time rather than one long serial sweep. Do not send overlapping scopes.

**Treat scout output as evidence to check, not as truth.** Spot-check the claims that your biggest findings rest on by opening the cited file. If a scout report is vague, lacks file references, or contradicts the scan or the graph, re-ask a narrower question or verify yourself. Never put an unverified scout claim in the report as a Critical or High finding.

**Do not use scout for** things already answered by `scan.py` or CodeGraph, for reading a single small file, or for the final analysis and recommendations.

**Record it.** In the report's Tooling line, note that scout was used and for which areas, and in "Scope" list any area that was surveyed only through scout summaries rather than read directly.

## The JS/TS seam (highest-value checks)

**Typing coverage of the boundary.** For every JS module imported by TS, how does TS see it? Options, best to worst: JSDoc with `checkJs`, a sibling `.d.ts`, inferred types from JS, implicit `any` (via `allowJs` without checking), or `declare module '*'` wildcards. The last two silently erase type safety for every consumer.

**Strictness is per-project, not per-file.** Check `tsconfig*.json` (including `extends` chains and per-package configs) for `strict`, `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `allowJs`, `checkJs`, `skipLibCheck`, `isolatedModules`, `verbatimModuleSyntax`. Flag a loose root config that new code inherits, and a strict config that excludes the legacy folders where the bugs are.

**Escape hatches.** Count and locate `any`, `as unknown as`, `as any`, non-null `!`, `// @ts-ignore`, `// @ts-expect-error`, `// @ts-nocheck`. A handful with comments is normal. Clusters in one module mean that module's contract is wrong. `@ts-ignore` is worse than `@ts-expect-error` because it never goes stale.

**Runtime vs compile-time truth.** Types vanish at runtime. At every trust boundary (HTTP input, env vars, `JSON.parse`, `localStorage`, message queues, third-party responses, untyped JS callers) there should be runtime validation (zod, valibot, io-ts, ajv, or equivalent) feeding the types, not a cast. A cast at a boundary is a finding.

**Module system consistency.** Mixed ESM/CJS (`require` alongside `import`, `"type"` in package.json, `.cjs/.mjs/.cts/.mts`, `module`/`moduleResolution` settings) causes interop bugs, default-export shape surprises, and tooling split-brain. Check that the build, test runner, and runtime agree.

**Migration state.** Is the migration direction clear? Healthy signs: new code is TS, legacy JS shrinks, a ratchet exists (CI fails if escape-hatch count or untyped files grow). Unhealthy signs: new `.js` files still appear, JS and TS duplicate the same domain logic, or a "temporary" shim layer is now load-bearing.

## Architecture checklists (summary)

Apply the ones that fit the stack. Full item lists are in `references/checklists.md`.

- **Module boundaries:** one responsibility per module, small public surface, no God modules or `utils` dumping grounds, names match behavior.
- **Dependency direction:** dependencies point inward/downward; domain logic does not import UI, framework, ORM, or HTTP clients; no import cycles; no deep imports into another package's internals (`../../other/src/x`).
- **Barrel files (`index.ts`):** useful as a package's public API, harmful as an internal convenience layer. They create cycles, defeat tree-shaking, and slow type-checking and tests. Flag barrels that re-export a whole folder and are imported from inside that same folder.
- **Package/monorepo structure:** explicit `exports`, enforced boundaries (project references, dependency-cruiser, ESLint boundaries/`no-restricted-imports`, Nx/Turborepo tags), no phantom dependencies relying on hoisting.
- **State and side effects:** module-level mutable singletons, import-time side effects, and shared globals are common coupling. Check initialization order and testability.
- **Error handling:** one consistent strategy (thrown typed errors vs result types), no swallowed promise rejections, no `catch (e)` treated as `Error` without narrowing.
- **Async design:** unawaited promises, mixed callback/promise APIs left from JS code, unbounded concurrency, missing cancellation/timeouts at I/O edges.
- **Public API stability:** exported types that leak implementation details (inferred return types of internal functions, ORM entity types exposed to UI).
- **Testing seams:** can the core logic run without the framework, network, or DB? Heavy mocking of module internals signals poor boundaries.
- **Dependencies:** duplicated or overlapping libraries, unmaintained packages in core paths, heavy packages imported for one function, dev/prod dependency mix-ups.

### Stack add-ons (apply only if present)

- **React / Next / Vue:** state colocation, prop drilling past 3 levels, components with "and" in their description, server/client boundary leaks (`"use client"`, server-only imports in client bundles), data fetching scattered across components, custom hooks that do more than one thing.
- **Node / Express / Fastify / Nest:** layering of route → service → repository, business logic inside handlers, request objects leaking into the domain, DI approach consistent, config read from `process.env` in many places instead of one validated module.
- **Full-stack shared code:** shared types package that is really shared runtime code, accidental imports of server code into the browser bundle, duplicated DTOs hand-synced between front and back end (candidate for generated or shared schema).

## Coupling and cohesion quick reference

| Coupling type | Typical TS/JS form | Severity |
| --- | --- | --- |
| Content | Reaching into another module's private files or mutating its exports | Critical |
| Common | Shared mutable module state, globals, singletons | High |
| Control | Boolean/mode flags that switch behavior in another module | Medium |
| Stamp | Passing large objects when two fields are needed | Low-Medium |
| Data | Passing only needed values | Acceptable |
| Message | Events, queues, typed message contracts | Best |

Cohesion: prefer modules where everything serves one task (functional) over grouping by kind (`utils`, `helpers`, `types`, `constants` folders), which is logical or coincidental cohesion and the most common smell in grown TS/JS repos.

## Severity scale

- **Critical:** causes or hides production defects now, or blocks safe change (cycles in core, boundary casts on untrusted input, security-relevant trust-boundary leaks).
- **High:** will compound quickly (loose root tsconfig inherited by new code, God modules, duplicated domain logic across JS/TS).
- **Medium:** friction and drag (barrel misuse, inconsistent module system, scattered config).
- **Low:** worth noting, fix opportunistically.

Do not inflate severity. If a finding is a judgment call, say so and give the trade-off.

## Output template

Use this structure for the final review. Keep it tight; omit empty sections rather than padding.

```
## Architecture Review: [Project / Package]

**Date:** YYYY-MM-DD
**Scope:** [what was reviewed, what was not]
**Tooling:** [scan.py; CodeGraph synced <time> / not available; scout used for <areas> / not used; tsc/madge if run]
**Stack:** [TS version, runtime(s), framework(s), build/test tooling, TS:JS file ratio]

### Summary
[2-3 sentences: overall health, the single most important risk]

### Structure Map
[Packages/layers/modules, responsibilities, entry points, key relationships]

### JS/TS Seam
[Typing coverage at the boundary, strictness flags, escape-hatch hotspots, module-system state, migration direction]

### Findings
| # | Severity | Area | Finding (with file refs) | Recommendation | Effort |
|---|---|---|---|---|---|

### Dependency Notes
[Direction of flow, cycles found (list them), boundary violations]

### What's Working Well
[Specific strengths worth preserving]

### Recommended Order of Work
1. [Highest impact per effort first, concrete enough to turn into a ticket]

### Tech Debt to Track
[Items worth adding to a debt list, with a suggested ratchet or CI check where applicable]
```

## Principles for good reviews

- Evidence over opinion: every finding points at code.
- Recommend the smallest change that fixes the structural problem. Prefer incremental paths (enable `checkJs` per folder, add a lint boundary rule, add one validation layer) over rewrites.
- Suggest enforcement, not just fixes. A rule in CI (cycle check, boundary lint, escape-hatch ratchet) keeps the improvement from eroding.
- Separate "wrong" from "different from what I'd do". Respect conventions already consistently applied in the repo.
- If scope is large, state what you sampled so the user knows the coverage.
- If you cannot run tooling (no shell, no dependencies installed), say what you inferred from reading versus what you measured.
