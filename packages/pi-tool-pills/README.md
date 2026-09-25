# pi-tool-pills

Pi extension that replaces plain tool-call output with compact visual renderers:

- **`ls`, `read`, `find`, `grep`, `bash`** — coloured pill label + collapsed output.
- **`ls`, `find`** — Nerd Font file icons (`ls` renders as a tree).
- **`find`, `grep`** — accelerated by [@ff-labs/fff-node](https://www.npmjs.com/package/@ff-labs/fff-node) (frecency-aware index of the session cwd); falls back to the built-in SDK tools when unavailable.
- **`write`, `edit`** — Shiki-powered syntax-highlighted diffs (inline before/after view).

No configuration required. The renderers activate automatically once the extension is loaded.
Set `PI_TOOL_PILLS_ICONS=off` to disable Nerd Font icons.
