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
| `view.html` (forked) | `b2d6ed896655196546e5f21406a6315462c0b7ce1858aa06a40694c72a487b1b` |
| `LICENSE` | `0a83841ebb1c6be2a20e69d89ffe8f63a0c82ef22c9caeeb1af7b7e3e99392cd` |

## view.html fork (PMR-57HF)

`view.html` is the **only sanctioned modification surface** in this vendor
directory (`hp.js` stays byte-identical to upstream; checksum-enforced).

- Fork base: pristine upstream `view.html` at `v0.2.2`, sha256
  `b966a68ec83e4babecb4a2d58bc6ff5f9ab58aecba57df9b60f826191ed5f595`.
- Forked sha256 (current, pinned in `test/vendor.test.ts` as
  `PINNED_VIEW_HTML_SHA256`):
  `b2d6ed896655196546e5f21406a6315462c0b7ce1858aa06a40694c72a487b1b`.
- Why: `/flow-diagram` renders a per-ticket header band (ticket ref,
  trackRef/mode, run k of N, phase durations, commits per subtask,
  unattributed commits, PR url, generated-at) above the diagram. Upstream
  has one data slot (`/*DATA*/null`); the fork adds a second slot so
  `assemble.ts` can inject the header after `renderHtml` without touching
  `hp.js`.
- Diff (all edits wrapped in `<!-- pi-flow fork: ... -->` comments so the
  upstream diff is auditable; removed wholesale on re-vendor):
  1. A second `<style>` block before `</head>` with `#flow-header` CSS.
  2. `<div id="flow-header" hidden></div>` after the `#subline` div (above
     the diagram).
  3. A `<script>` addition before `</body>`: `const FLOW_HEADER =
     /*FLOW_HEADER*/null;` slot plus a vanilla `renderFlowHeader()` that
     fills the band; absent fields are skipped, never blank rows. The slot
     literal is replaced by `assemble.ts` with `<`-escaped JSON (same
     technique as `hp.js`'s DATA slot replacement).

## Re-vendoring

1. Re-fetch the files from the desired upstream tag (same raw URLs, new tag).
2. Recompute sha256 (`shasum -a 256 hp.js view.html LICENSE`).
3. Update the checksum table above **and** the pinned constants in
   `packages/pi-flow/test/vendor.test.ts` (`PINNED_HP_JS_SHA256`, and
   `PINNED_VIEW_HTML_SHA256` after re-applying the fork below) together.
4. Re-apply the view.html fork (see the "view.html fork" section above),
   recompute the forked sha256, and update the `view.html` row +
   `PINNED_VIEW_HTML_SHA256`.
5. Run `cd packages/pi-flow && npm test` — the vendor tests must pass.

MIT License — Copyright (c) 2026 Aleksandr Furmanov. See `LICENSE` for the
full license text.
