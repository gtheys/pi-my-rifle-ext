# Architecture Overview

## What this repo is not

There's no server, no build, no runtime entrypoint you execute. This is a **package
of extensions for the pi coding agent**. pi discovers it via the `pi` block in the
root `package.json` and loads each listed module directly with Bun/Node's ESM loader.

```json
"pi": {
  "extensions": [ "./packages/pi-bootstrap/index.ts", "./packages/pi-context/context.ts", ... ],
  "skills": ["./skills"],
  "prompts": ["./prompts"],
  "themes": ["./themes"]
}
```
Source: `package.json:16`

## The extension model

Every extension file exports a default function `(pi: ExtensionAPI) => void`. Inside
that function it registers three kinds of things against the injected `pi` object:

| Registration | Purpose | Example |
|---|---|---|
| `pi.on(eventName, handler)` | React to lifecycle events (`session_start`, `agent_start`, `agent_end`, `session_shutdown`) | `pi-bootstrap` symlinks AGENTS.md on `session_start` |
| `pi.registerTool({...})` | Expose a typed tool the LLM can call mid-conversation | `pi-sem`'s `sem_diff`, `sem_impact`, etc. |
| `pi.registerCommand('name', {...})` | Expose a `/name` slash command a human types | `/review`, `/plan`, `/implement`, `/notify` |

Tool schemas are defined with `typebox`'s `Type.*` builders (or `@sinclair/typebox`
directly in older packages) so the harness can validate LLM tool-call arguments
before your handler runs. See `packages/pi-planning/plan-tools/index.ts:86` for a
representative tool registration.

## Workspace layout and dependency direction

```
packages/
├── pi-bootstrap/        no deps — pure side effect on session_start
├── pi-context/           /context command, standalone
├── pi-desktop-notify/    /notify command, standalone
├── pi-fastcontext/       fast_context_search tool + /fastcontext, standalone
├── pi-tool-pills/        wraps ls/read/find/grep/bash/write/edit tool RENDERING only
├── pi-test-runner/       run_tests tool, spawns a detached subagent
├── pi-sem/               sem_* tools, wraps the external `sem` CLI (@ataraxy-labs/sem)
├── pi-planning/
│   ├── shared/tw-utils.ts     ← shared by both siblings below
│   ├── plan-tools/            tw_* tools for spec creation (create-plan skill)
│   └── implement-plan/        tw_* tools for phased execution (implement-plan skill)
└── pi-review/
    ├── shared/sonarqube-utils.ts  ← shared by sonarqube.ts and pr-quality
    ├── review/review.ts           /review command
    ├── sonarqube/sonarqube.ts     /sonarqube command
    └── pr-quality/index.ts        /pr-quality + /pr-watch commands
```

Two packages internally share code across sibling extensions rather than being split
into more packages — this is deliberate (see `README.md`: "Shared helpers are
co-located with their only consumer"). Don't extract a new package for a helper used
by exactly one other file; keep them next to each other like `pi-planning/shared` and
`pi-review/shared` do.

## Extensions never call each other directly

Nothing in `packages/*` imports another top-level package's `index.ts`. Coordination
happens through:
- **taskwarrior** as external state (`plan-tools` writes tasks, `implement-plan` reads
  them) — see `workflows/planning-and-implementation.md`.
- **git/gh CLI** as external state (`pi-review`'s three commands all shell out to `gh`
  and `git`).
- **pi's own event bus** (`session_start`, `agent_end`) for cross-cutting concerns like
  desktop notifications and AGENTS.md bootstrapping.

This keeps every package independently loadable/testable and avoids a shared
"core" package that everything depends on (YAGNI — there's no such core today).

## External processes each extension shells out to

| Package | External binary/API | Why |
|---|---|---|
| `pi-bootstrap` | none (fs only) | symlink AGENTS.md |
| `pi-planning` (both) | `task` (taskwarrior CLI) | ticket/spec/phase/subtask state lives in taskwarrior, not in this repo |
| `pi-sem` | `sem` CLI (`@ataraxy-labs/sem`, optional dep) | entity-aware git diff/impact/context/blame |
| `pi-review/review` | `git`, `gh` | checkout PRs, diff branches/commits |
| `pi-review/sonarqube` | SonarCloud REST API (`sonarFetch`) | coverage + issues |
| `pi-review/pr-quality` | `gh api graphql`, SonarCloud API | unresolved review threads + Sonar issues in one pass |
| `pi-fastcontext` | local FastContext server (llama.cpp, `127.0.0.1:8772`) | fast semantic code search without a full agent turn |
| `pi-test-runner` | spawns a **detached pi subagent** process with its own session file | isolate test runs so they don't block the main conversation |
| `pi-desktop-notify` | `notify-send` | desktop notification on idle-after-work |

## Next

- [Extension reference](extensions.md) for a deep dive per package.
- [Planning workflow](../workflows/planning-and-implementation.md) for the taskwarrior
  data model shared by `plan-tools` and `implement-plan`.
