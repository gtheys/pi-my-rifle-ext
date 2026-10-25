# Smells and Recipes

Load this when matching findings to refactorings, or when planning a migration in detail.

## Contents

1. Smell tables (TS/JS core, React, Node/backend, JS/TS seam)
2. Mechanical refactorings and the tool to use
3. Recipes: split a god module, remove a cycle, remove barrels, type an untyped JS module, replace `any`
4. Migration patterns with TS/JS examples
5. Characterization tests for legacy JS

---

## 1. Smell tables

### TS/JS core

| Smell | Signs | Refactoring |
| --- | --- | --- |
| God module / `utils.ts` | Hundreds of lines, unrelated exports, imported by most of the repo | Group exports by responsibility, move each group to a named module, leave re-exports temporarily (Parallel Change) |
| Long function | Multiple levels of nesting, comments marking "sections" | Extract Function per section; keep the original as the orchestrator |
| Long parameter list / boolean flags | 4+ params, `fn(a, b, true, false)` | Introduce parameter object; replace flag with two functions or a discriminated union |
| Primitive obsession | Strings for statuses, IDs, units | String-literal unions or `as const` objects; branded types for IDs |
| Optional-field bags | `{loading?, error?, data?}` | Discriminated union (`{status:'loading'} \| {status:'ok', data}`) |
| Feature envy | Function mostly reads another module's data | Move the function next to the data |
| Shotgun surgery | One change touches many files | Consolidate the scattered logic into one module |
| Duplicated code | Copy-pasted blocks, JS and TS twins | Extract shared function; pick one canonical implementation |
| Dead code | Unused exports, unreachable branches, stale flags | Confirm with callers plus dynamic-reference hunt, then delete; use `knip` to list candidates |
| Mutable module state | `let cache = {}` at module level, singletons | Pass state in, or encapsulate in a factory/class created at the composition root |
| Swallowed errors | Empty `catch`, unhandled promises | Handle or rethrow typed errors; add `no-floating-promises` lint |
| Magic values | Repeated literals | Named constants or enums-as-unions |

### Escape hatches and typing

| Smell | Refactoring |
| --- | --- |
| `as any`, `: any` | Replace with real type, `unknown` plus narrowing, or generics |
| `as unknown as T` | Fix the source type; if data is external, validate at runtime (zod, valibot, ajv) |
| `// @ts-ignore` | Convert to `@ts-expect-error` with a reason, then fix and remove |
| Non-null `!` clusters | Narrow with guards, restructure so null cannot occur, or return early |
| `Function`, `object`, `{}` types | Real signatures and shapes |
| Hand-synced duplicate types (front and back end) | Single schema or generated types shared by both |
| Overloaded unions needing casts | Discriminated unions or function overloads |

### React / frontend

| Smell | Refactoring |
| --- | --- |
| God component (200+ lines, many concerns) | Extract subcomponents and custom hooks by concern |
| Prop drilling (3+ levels) | Composition (children/slots), context, or colocate state lower |
| `useEffect` spaghetti | One effect per concern; extract to hooks; replace derived-state effects with computed values |
| State duplication | Single source of truth; derive the rest |
| Data fetching in many components | Centralize in a data layer or query library; components receive data |
| Server/client boundary leaks (Next, RSC) | Move server-only imports out of client components; mark boundaries explicitly |
| Inline styles / ad hoc styling | Move to the project's design-system approach |
| Callback prop chains | Context or event/state layer |

### Node / backend

| Smell | Refactoring |
| --- | --- |
| Fat route handlers | Extract service layer; handler parses input, calls service, formats response |
| Business logic importing ORM/HTTP clients directly | Introduce repository/port interface; inject implementations |
| `process.env` scattered | Single validated config module |
| Callback-style legacy APIs | Wrap with `util.promisify` or convert to async/await, one module at a time |
| Inconsistent error handling | One error model (typed errors or result type) and one mapping point to responses |
| Unbounded concurrency | Limit with a pool or `p-limit`; add timeouts and cancellation |

### JS/TS seam

| Smell | Refactoring |
| --- | --- |
| TS importing untyped JS | `// @ts-check` plus JSDoc, or a `.d.ts`; convert the file when it has tests |
| `allowJs` without `checkJs` | Enable `checkJs` per folder via a nested tsconfig, fix errors incrementally |
| Mixed CJS/ESM | Choose per package; migrate leaves first; verify `exports` and `type` fields |
| JS shims that became load-bearing | Give them types and tests, then fold into the TS module |
| Barrel files used internally | Direct imports; keep barrels at package edges only |

---

## 2. Mechanical refactorings and tools

| Move | Preferred tool | Notes |
| --- | --- | --- |
| Rename symbol / file | TS language service (editor rename, `ts-morph`) | Does not update strings, `.js` untyped callers, or configs; run the dynamic-reference hunt |
| Move file | Editor "move to file" or `ts-morph` | Re-check relative paths in JS, tests, and configs |
| Extract function/component | Editor refactor | Watch lost narrowing and captured variables |
| Bulk syntax change (e.g. `require` to `import`) | `jscodeshift` or `ts-morph` | Run on a small folder first, review the diff |
| Mechanical lint fixes | `eslint --fix`, `biome check --write` | Commit separately from structural changes |
| Remove unused exports/files/deps | `knip` | Treat output as candidates, not truth |
| Find cycles | `madge --circular`, `dpdm`, `import/no-cycle` | Compare with CodeGraph if available |

---

## 3. Recipes

### Split a god module (keeping callers working)

1. Characterize: ensure tests cover the exported behavior (or write them).
2. Create new modules for each responsibility; copy (do not delete) the code there and make the old module re-export from them. Verify.
3. Migrate callers to import from the new modules one package at a time (use `callers` from CodeGraph, or grep). Verify after each.
4. When no callers use the old paths (including strings and JS), delete the old module. Verify.
5. If the old module was a public entry, keep it as a deprecated re-export for one release.

### Break an import cycle

1. Identify the cycle and the thing each side actually needs from the other.
2. If one direction only needs types, switch it to `import type` (removes the runtime cycle).
3. Otherwise extract the shared piece to a lower-level module both depend on, or invert one dependency with an interface passed in at construction.
4. Re-run the cycle check and the test suite; check initialization order for any module with import-time side effects.

### Remove an internal barrel

1. List imports that go through the barrel from inside the same package.
2. Replace them with direct file imports (codemod or editor); verify.
3. Keep the barrel only if it defines the package's public API; make it explicit named re-exports, no `export *`.
4. Check the build and tests for init-order changes.

### Type an untyped JS module

1. Add characterization tests if none exist.
2. Add `// @ts-check` and JSDoc (`@param`, `@returns`, `@typedef`) to the exported surface; fix reported errors.
3. Alternatively write `module.d.ts` next to the file for the public surface only.
4. Rename `.js` to `.ts` once checks pass; update imports with `.js` extensions if using NodeNext.
5. Add the file to the strict tsconfig include list so it cannot regress.

### Replace `any` at a boundary

1. Find where the value enters (HTTP, `JSON.parse`, storage, env).
2. Define a schema (zod, valibot, ajv); derive the TS type from it.
3. Parse at the edge, return the typed value, delete the cast.
4. Add a test with an invalid payload to prove validation fails loudly.

---

## 4. Migration patterns with TS/JS examples

### Strangler fig (replace a legacy module)

1. Create `newBilling/` beside `legacy/billing.js`.
2. New features import `newBilling`.
3. Move callers over, one package per step, verifying each.
4. Delete `legacy/billing.js` when `callers` and string search show no users.

### Branch by abstraction (swap an implementation)

```ts
// 1. Introduce the port
export interface Mailer { send(msg: Message): Promise<void> }
// 2. Wrap the current implementation behind it
export class LegacyMailer implements Mailer { /* existing code */ }
// 3. Callers depend on Mailer; 4. add NewMailer; 5. flip wiring at the composition root (or via flag); 6. delete LegacyMailer
```

### Parallel change (expand, migrate, contract)

```ts
/** @deprecated use formatMoney({ amount, currency }) */
export function formatPrice(amount: number, currency?: string) {
  return formatMoney({ amount, currency: currency ?? 'USD' })
}
export function formatMoney(opts: { amount: number; currency: string }) { /* new */ }
```

Migrate callers (list them with `callers`), then remove `formatPrice` once there are none, including `.js` users and string references.

### Incremental JS to TS

1. Enable `allowJs`; add a separate tsconfig with `checkJs` for folders being migrated.
2. Order by dependency: leaves first, then their dependents.
3. Per file: tests, `// @ts-check`, fix errors, rename to `.ts`.
4. Ratchet: CI script counts untyped files and `any`/`@ts-ignore`; fail if either grows.

---

## 5. Characterization tests for legacy JS

Goal: pin what the code does now, not what it should do.

- Call the function with representative and edge inputs (empty, `0`, `''`, `null`, large, malformed); snapshot or assert the current outputs and thrown errors.
- Record side effects: calls to injected collaborators, files written, events emitted.
- For modules with import-time effects, add a test that imports the module and asserts the effect (registered handler, populated registry).
- Prefer the repo's existing test runner and style (see `detect_checks.py` output). Keep these tests; they are the safety net for later steps.
- If behavior looks like a bug, pin it anyway, mark it with a comment, and fix it in a separate step after the refactor.
