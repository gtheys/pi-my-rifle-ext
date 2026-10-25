---
name: ts-js-refactoring-advisor
description: Plan and carry out safe refactors in TypeScript codebases mixed with JavaScript (allowJs, JSDoc, partial migrations, Node/React/monorepo stacks). Use whenever the user mentions refactoring, cleanup, code smells, duplication, splitting a large file or module, extracting a service or hook, renaming or moving things, API or signature changes, removing barrel files or `any`, converting JS to TS, ESM/CJS migration, replacing a library, or "restructure / tidy / modernize this code", even if they never say "refactor". Emphasizes small behavior-preserving steps, impact analysis before touching code, and running the repo's own typecheck/lint/tests after every step.
---

# TypeScript + JavaScript Refactoring Advisor

Detect smells, size the risk, and produce (or execute) a refactoring plan where the code builds and passes tests after every step. A refactor changes structure, never behavior. If behavior must change, that is a separate step with its own tests.

The mixed TS/JS state makes refactoring riskier than it looks: `tsc` cannot vouch for JS files, and many references (string keys, DI tokens, route paths, dynamic imports, `require`) are invisible to rename tooling and type checking. Plan for what the compiler cannot see.

## Workflow

1. **Scope and intent.** Confirm the target (file, module, package, or smell) and whether the user wants a plan only or wants you to carry it out. If they gave a goal like "split this god component", restate what "done" looks like before touching anything.
2. **Prepare CodeGraph if available.** Run `bash scripts/codegraph_prep.sh <repo-root>`. If it ends in `CODEGRAPH=ready`, the index was just synced; use it for impact and call-site discovery (see "Using CodeGraph"). Otherwise follow the fallback in that section.
3. **Learn how this repo verifies.** Run `python scripts/detect_checks.py <repo-root>` to get the package manager, the typecheck/lint/test/build commands, monorepo hints, and whether `tsc` covers JS. Use those exact commands for every verification step below rather than guessing.
4. **Record a baseline.** Run the detected checks once before any change and note what already fails. Pre-existing failures must not be blamed on, or hidden by, the refactor. If the working tree is dirty, say so and ask the user to commit or stash first.
5. **Find and rank the smells.** For a broad "clean this up" request, run `python scripts/scan.py <repo-root>` for hotspots (escape hatches, cycles, barrels, high fan-in/out, largest files). For a specific target, read it. Use `scout` for deeper exploration when needed (see "Delegating exploration to scout"). Match findings to `references/smells-and-recipes.md`.
6. **Size the blast radius.** Use CodeGraph `impact` / `callers` when ready, otherwise grep, plus the dynamic-reference hunt below. Decide the risk level from the real call-site count and from how much of it is untyped JS.
7. **Check coverage.** If the affected behavior has no tests, the first plan step is characterization tests. Do not skip this for JS files.
8. **Plan.** Produce the plan using the template below. Keep every step independently verifiable and revertible.
9. **Execute (only if asked).** Follow the safety protocol, verifying after each step, and stop at the first unexplained failure.

Read the code before recommending. A plan names real files and real call sites, not generic advice.

## Using CodeGraph

CodeGraph is a local semantic code graph (symbols, call graph, references, impact radius). For refactoring it answers "what depends on this?" far more reliably than grep.

**Detect and sync.** `scripts/codegraph_prep.sh` checks for the CLI and a `.codegraph/` index, then runs `codegraph sync` (incremental, safe). Sync before querying, and again after every executed step, because a stale index misses call sites you just moved. Act on the final `CODEGRAPH=` line:

- `ready`: use CodeGraph as described below.
- `sync-failed`: say the index may be stale and confirm any call-site list by grep before relying on it.
- `no-index`: tell the user CodeGraph is installed but not initialized for this repo and offer `codegraph init -i`. Do not run it unasked, since it creates `.codegraph/` in their repo. Continue with grep meanwhile.
- `missing`: continue with grep, `scan.py`, and the TypeScript compiler. Do not mention CodeGraph again unless asked, and do not try to install it.

**Use MCP tools if connected** (`codegraph_search`, `codegraph_context`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_node`, `codegraph_files`, `codegraph_status`), otherwise the CLI (`codegraph query <symbol>`, `codegraph context "<task>"`, `codegraph status`). Tool names vary by version, so list what is actually available.

| Refactoring question | CodeGraph use |
| --- | --- |
| What breaks if I change or move this symbol? | `impact` on the symbol; cite the radius in the plan's Risk line |
| Where are all the call sites to migrate (Parallel Change)? | `callers`; turn the list into the migration checklist |
| Is this function or export dead? | `callers` with nothing outside its own file; confirm with the dynamic-reference hunt |
| What does this god module actually depend on? | `callees`, to decide where to cut |
| Which callers are untyped JS? | `callers` filtered to `.js/.jsx/.cjs/.mjs`; these need tests, not just `tsc` |
| Where do route handlers or controllers bind? | Route nodes for Express/Nest, via `callers` of the handler |

Graph results cover static structure only. They do not see string-based references, so always run the dynamic-reference hunt before calling something safe to rename, move, or delete. If a response warns about a file with pending changes, read that file directly.

## Delegating exploration to scout

When the target is large or unfamiliar, or you need facts beyond what `scan.py` and CodeGraph give, delegate the digging to the subagent named `scout` rather than reading everything in your own context.

**Check it exists first.** Use `scout` only if a subagent with that name is available in this session. If not, explore directly and carry on without mentioning it.

**Delegate narrow questions with a defined scope.** Good refactoring tasks:

- "List every call site of `formatPrice` across `apps/` and `packages/`, with file and line, and mark which are in `.js` files."
- "Find string references to `'user:created'` (event names, route paths, DI tokens, config keys) outside the file that defines it."
- "Which tests cover `src/services/order.ts`? List test files and what behaviors they assert."
- "Summarize what `Checkout.tsx` is responsible for, grouped by concern, with line ranges."

**Brief it properly.** Include: the exact question and directory scope; read-only (no edits, installs, or `codegraph init`); a pointer to CodeGraph if `CODEGRAPH=ready`; and a return format of compact findings with file paths and lines plus an explicit "could not determine" list. Ask for facts, not recommendations. Launch independent areas as parallel scouts with non-overlapping scopes.

**Verify before relying.** Spot-check the scout claims that the plan rests on (especially "no other callers" and "dead code") by opening the cited files or running a grep yourself. Never delete or rename on an unverified scout claim. Do not use scout for single small files, for results `scan.py` or CodeGraph already gave, or for writing the plan.

## The dynamic-reference hunt

Before renaming, moving, deleting, or changing the signature of anything, search for references the compiler and the graph cannot follow. Check each that applies:

- The symbol name as a string: event names, DI/provider tokens, route paths, `process.env` keys, feature flags, analytics event names, CSS class or test-id names, i18n keys, JSON/YAML config.
- Dynamic access: `obj[name]`, `require(variable)`, `import(variable)`, `Reflect`, decorators, `Object.keys` iteration over an exported object.
- Untyped callers: `.js` files, inline scripts, build or tooling configs, `package.json` `main`/`exports`/`bin`, Storybook and test files, docs and examples.
- Public surface: anything exported from a package entry point may be used by other repos or services. Treat as a breaking change and use Parallel Change.
- Generated code, code in other languages (e.g. server templates), and serialized data that stores names.

## TS/JS-specific hazards

These make a "pure" refactor change behavior. Plan for each one that applies.

- **Import order and side effects.** Reordering imports, removing a barrel, or splitting a module changes module initialization order. Modules that register things on import (polyfills, singletons, global state) can break silently.
- **Circular import fallout.** Fixing one cycle by moving code can surface `undefined` at import time in another.
- **Default vs named exports and ESM/CJS interop.** Switching export style, or converting CJS to ESM, changes what `require()` and `import x from` receive. Check every consumer, including tests and config files.
- **Emitted-code changes.** `enum` to union, `const enum`, class fields vs constructor assignment, decorators, and `useDefineForClassFields` change runtime output.
- **`this` and binding.** Converting classes to functions, or extracting methods, can break callbacks that relied on `this`.
- **Truthiness and optional chaining.** `||` to `??`, `?.` insertions, and early returns can change falsy-value handling (`0`, `''`, `false`).
- **Async semantics.** Adding or removing `await`, or changing `Promise.all` ordering, changes error handling and timing.
- **Narrowing loss.** Extracting a function can drop control-flow narrowing and push you to add casts. Fix the types instead.
- **Type-only illusions.** Types vanish at runtime. A refactor that is "type safe" can still break callers that pass data from `JSON.parse` or untyped JS.

## Refactoring safety protocol

**Before:**

1. Clean working tree and a recorded baseline (workflow steps 3 and 4).
2. Tests exist for the behavior being moved. If not, write characterization tests that pin current behavior, including odd edge cases, before changing structure. For untyped JS this is the main safety net.
3. Define the end state and how you will know it is reached.

**During:**

1. One refactoring move per step (extract, rename, move, inline, introduce parameter object). Mixed steps are hard to verify and harder to revert.
2. After each step run the detected typecheck, then lint, then tests (fast to slow). In monorepos, run affected packages first and the full suite at the end.
3. After each step sync CodeGraph if it is in use, so the next impact query is accurate.
4. Prefer tool-driven edits over hand edits: the TypeScript language service rename (via the editor or `ts-morph`), `jscodeshift` for bulk syntax changes, ESLint `--fix` for mechanical rules. Review the diff of any automated change.
5. No behavior changes. If you spot a bug mid-refactor, note it and fix it in a separate step.
6. Stop at the first unexplained failure. Revert the step, investigate, and re-plan instead of stacking fixes.

**After:**

1. Full typecheck, lint, and test suite pass, matching or improving the baseline.
2. No new `any`, `@ts-ignore`, `eslint-disable`, or non-null assertions introduced by the refactor.
3. Review the full diff for accidental behavior changes, changed exports, and removed side effects.
4. Where the repo has a build, run it, since bundlers surface problems `tsc` does not (tree-shaking, circular imports, missing extensions).

If the user has asked you to implement the plan and the repo is under git, size steps so each is one reviewable commit, and suggest the commit boundaries. Do not commit unless asked.

## Common smells (summary)

Full table with recipes is in `references/smells-and-recipes.md`. The ones that matter most in mixed TS/JS repos:

| Smell | First move |
| --- | --- |
| Escape-hatch clusters (`any`, `as unknown as`, `@ts-ignore`) | Fix the contract at the source; add runtime validation at the boundary; use `@ts-expect-error` while fixing |
| JS module that TS code depends on, untyped | Add JSDoc plus `// @ts-check`, or a `.d.ts`, then convert; characterization tests first |
| God file / god component / `utils` dumping ground | Extract by responsibility (Extract Function, then Move), behind the same exports |
| Barrel files used internally | Replace internal imports with direct paths; keep barrels only at package edges |
| Import cycles | Extract the shared piece to a lower layer, or invert with an interface; verify init order |
| Duplicated logic across JS and TS copies | Pick one canonical implementation, convert callers with Parallel Change |
| Prop drilling, effect spaghetti, state duplication (React) | Composition, context or a custom hook; derive instead of storing |
| Config read from `process.env` everywhere | One validated config module, injected |
| Mixed CJS/ESM | Choose a target per package; migrate leaf modules first |
| Fat route handlers / controllers | Extract a service layer; handler only parses and responds |

## Refactoring plan template

Use this structure for every plan. Fill in real commands from `detect_checks.py`.

```markdown
## Refactoring Plan: [Description]

**Target:** [File/module/component]
**Smell:** [What's wrong and why it matters]
**Goal:** [What "done" looks like, checkable]
**Risk:** Low / Medium / High  ([N callers, M in untyped JS, public API: yes/no])
**Effort:** S / M / L / XL
**Test coverage:** Adequate / Needs characterization tests first
**Tooling:** [CodeGraph synced <time> / not available; scout used for <areas> / not used]
**Baseline:** [what already fails before any change]

### Pre-requisites
- [ ] Clean working tree; baseline recorded
- [ ] [Characterization tests for X, if needed]

### Hidden references checked
[String/dynamic/untyped-caller hunt results, or "none found" with what was searched]

### Steps
1. **[One refactoring move]**
   - Files: [list]
   - Verification: `[typecheck]` && `[lint]` && `[tests]`
2. **[Next move]**
   - Files: [list]
   - Verification: ...

### Rollback
Revert the last step (or `git revert` the last passing commit). Each step leaves the repo green.

### Success Criteria
- [ ] Full checks pass and match or beat the baseline
- [ ] No new escape hatches
- [ ] [Specific structural improvement verified, e.g. cycle gone, file under N lines, callers migrated]

### Deferred / Tech debt
[Anything intentionally left for later, with why]
```

## Migration strategies

Choose by what is being replaced. Details and TS/JS examples are in `references/smells-and-recipes.md`.

- **Strangler fig:** build the replacement beside the legacy module, route new work to it, migrate callers gradually, delete the old one last. Best for large or risky replacements.
- **Branch by abstraction:** introduce an interface over the current implementation, move callers to it, add the new implementation behind it, flip the wiring (DI or flag), then remove the old one. Best for swapping libraries, clients, or storage.
- **Parallel change (expand, migrate, contract):** add the new signature or export alongside the old one, migrate callers one at a time, then remove the old. Best for changing widely used functions, types, or package exports. Use `@deprecated` JSDoc on the old one so editors flag remaining callers.
- **Incremental JS to TS:** convert leaf modules first (no or few dependents), add `// @ts-check` before renaming to `.ts`, keep the build green per file, and add a CI check that fails if the count of untyped files or escape hatches grows.

## Principles

- Evidence over opinion: every smell and every risk claim points at code or a count.
- Prefer many small verified steps over one big rewrite, even when the big rewrite looks cleaner.
- Be honest about what the compiler cannot check. Say which steps rely on tests alone.
- Match the repo's existing conventions unless changing them is the goal.
- If a refactor is not worth its risk, say so and recommend deferring, with the debt noted.
- State what you sampled or did not verify so the user knows the coverage.
