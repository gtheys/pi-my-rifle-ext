# Vendored: harness-profiler renderer

Provenance and checksums for the vendored harness-profiler flow-timeline
renderer used by `/flow-diagram`.

## Source

- Upstream repo: https://github.com/afurmanov/harness-profiler
- Tag: `v0.2.2` (tree `847bd8f`)
- Fetch date: 2026-11-20
- License: MIT (see `LICENSE`)

## Files & checksums (sha256)

| File      | sha256                                                            |
| --------- | ----------------------------------------------------------------- |
| `hp.js`   | `acebfb79e9a8cb6a5d5143f06b181e5ed9904509fdd872420cd7b7b4fbda1532` |
| `view.html` | `b966a68ec83e4babecb4a2d58bc6ff5f9ab58aecba57df9b60f826191ed5f595` |
| `LICENSE` | `0a83841ebb1c6be2a20e69d89ffe8f63a0c82ef22c9caeeb1af7b7e3e99392cd` |

## Re-vendoring

1. Re-fetch the files from the desired upstream tag (same raw URLs, new tag).
2. Recompute sha256 (`shasum -a 256 hp.js view.html LICENSE`).
3. Update the checksum table above **and** the pinned constant in
   `packages/pi-flow/test/vendor.test.ts` (`PINNED_HP_JS_SHA256`) together.
4. Run `cd packages/pi-flow && npm test` — the vendor test must pass.

MIT License — Copyright (c) 2026 Aleksandr Furmanov. See `LICENSE` for the
full license text.
