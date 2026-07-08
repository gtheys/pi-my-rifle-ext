# pi-sem

Semantic Git tooling for Pi, powered by [`sem`](https://github.com/Ataraxy-Labs/sem).

The extension exposes entity-aware tools to the model instead of making it reason over raw line hunks only.

## Included tools

- `sem_diff` - entity-level diff for working tree, staged changes, commits, or ranges
- `sem_impact` - dependency / blast-radius analysis for an entity
- `sem_context` - token-budgeted semantic context for a focused entity
- `sem_log` - entity history across git commits
- `sem_entities` - structural inventory of a file
- `sem_blame` - entity-level blame for a file
- `sem_eval` - compares `sem diff` against raw `git diff` for coverage and prompt footprint

## Installation notes

This repo declares `@ataraxy-labs/sem` as an optional dependency, so `npm install` should fetch the wrapper binary automatically on supported platforms.

Fallback options:

```bash
npm install @ataraxy-labs/sem
# or
brew install sem-cli
# or
cargo install --git https://github.com/Ataraxy-Labs/sem sem-cli
```

## Evaluation workflow

Run the local benchmark helper to compare semantic diff coverage and size versus raw git diff:

```bash
npm run sem:evaluate -- --staged
npm run sem:evaluate -- --from origin/main --to HEAD
npm run sem:evaluate -- --commit HEAD
```

Useful flags:

```bash
npm run sem:evaluate -- --staged --no-impact
npm run sem:evaluate -- --from origin/main --to HEAD --file-ext .ts --file-ext .md
npm run sem:evaluate -- --format json
```

## What to look at

The evaluator reports:

- **coverage** - how many git-changed files also show up in `sem diff`
- **payload size** - bytes / lines / rough token estimate for raw `git diff` vs `sem diff --format json`
- **semantic summary** - number of entities, change types, and top changed entities
- **impact samples** - sample `sem impact --tests` lookups for a few changed entities

Important: our first local runs showed that `sem diff --format json` is **not always smaller** than raw `git diff`, especially on very large or lockfile-heavy diffs. The upside is better entity structure and impact/context workflows, not guaranteed token compression on every selection.

## Suggested Pi usage

Good prompts once the extension is loaded:

- “What changed in this branch? Use sem.”
- “Use `sem_eval` to compare semantic diff vs git diff on the current changes.”
- “What tests are affected by changes to `buildReport`? Use `sem_impact`.”
- “Give me focused context for `buildReport` with a 4000 token budget using `sem_context`."

Recommended default posture:

- prefer **`sem_context`** for one suspicious function/class
- prefer **`sem_impact`** for blast radius and test selection
- use **`sem_diff`** once for overview / counts / review framing
- keep **raw `git diff` and file reads** for exact line-level evidence

If the review extension is loaded too, `/review` now adds this semantic workflow directly into its review prompt.
