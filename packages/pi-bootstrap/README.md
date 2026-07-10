# pi-bootstrap

Pi extension that symlinks `agents/AGENTS.md` into the Pi agent directory on startup so
the repository-level AI instructions are always active.

## Install

Add to your `package.json` `pi.extensions`:

```json
"./packages/pi-bootstrap/index.ts"
```

## Behaviour

On each Pi startup the extension checks `~/.pi/agent/AGENTS.md`:

- **Absent** — creates a symlink pointing at the repo's `agents/AGENTS.md`.
- **Already linked here** — silently skips (idempotent).
- **Linked elsewhere** — warns and leaves the existing link untouched.
- **Real file** — warns and leaves it untouched.
