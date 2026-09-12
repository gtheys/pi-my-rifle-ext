# pi-aven-context

Pi extension that injects live [aven](https://aven.cli) workspace state as session-start context.

At each new session start it runs `aven prime` from the session's working directory (aven infers the workspace and project from its cwd routes) and appends the live portion — local conventions, open issues, active/ready/blocked breakdown — as a hidden custom message that participates in LLM context.

The static CLI primer head is stripped: that reference is already available via the aven skill, so injecting it every session would burn tokens for nothing.

## Behavior

- **Non-fatal** — a missing or slow `aven` binary silently skips injection; startup never breaks.
- **Idempotent** — sessions resumed/forked/reloaded skip injection if an aven-context entry already exists in the branch, so context is never duplicated.

## Usage

Load the repo package per the [quickstart](../../openwiki/quickstart.md); the extension registers itself, no commands or config.
