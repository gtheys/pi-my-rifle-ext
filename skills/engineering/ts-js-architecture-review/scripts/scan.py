#!/usr/bin/env python3
"""Baseline scan for a mixed TypeScript/JavaScript repo.

Usage: python scan.py <repo-root> [--json]

Reports language mix, tsconfig strictness, type escape hatches, barrel files,
CJS/ESM mix, module-level fan-in/fan-out hotspots, and local import cycles.
Pure standard library; no installs needed. It is a heuristic, so treat the
output as a starting point and verify findings by reading the code.
"""

import json
import os
import re
import sys
from collections import defaultdict

IGNORE_DIRS = {
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "coverage",
    ".turbo",
    ".cache",
    ".svelte-kit",
    ".output",
    "vendor",
    ".yarn",
    ".pnpm-store",
}
TS_EXT = {".ts", ".tsx", ".mts", ".cts"}
JS_EXT = {".js", ".jsx", ".mjs", ".cjs"}
ALL_EXT = TS_EXT | JS_EXT
RESOLVE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

IMPORT_RE = re.compile(
    r"""(?:import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]"""
)
TYPE_ONLY_RE = re.compile(r"""^\s*(?:import|export)\s+type\b""")

PATTERNS = {
    "explicit_any": re.compile(r":\s*any\b|<any>|\bas any\b|Array<any>|any\[\]"),
    "as_unknown_as": re.compile(r"\bas unknown as\b"),
    "non_null_assert": re.compile(r"[\w\)\]]!(?:\.|\[|\)|;|,)"),
    "ts_ignore": re.compile(r"@ts-ignore"),
    "ts_expect_error": re.compile(r"@ts-expect-error"),
    "ts_nocheck": re.compile(r"@ts-nocheck"),
    "eslint_disable": re.compile(r"eslint-disable"),
}


def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]
        for f in filenames:
            yield os.path.join(dirpath, f)


def read(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            return fh.read()
    except OSError:
        return ""


def strip_json_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"(^|[^:\"'])//.*$", r"\1", text, flags=re.M)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    return text


def load_tsconfig(path):
    try:
        return json.loads(strip_json_comments(read(path)))
    except Exception:
        return None


def resolve(spec, from_file, root, files):
    """Resolve a relative import to a file in the repo, or None."""
    if not spec.startswith("."):
        return None
    base = os.path.normpath(os.path.join(os.path.dirname(from_file), spec))
    # Node ESM style: './x.js' may point at './x.ts'
    stem, ext = os.path.splitext(base)
    candidates = [base]
    if ext in {".js", ".jsx", ".mjs", ".cjs"}:
        candidates += [stem + e for e in RESOLVE_EXT]
    candidates += [base + e for e in RESOLVE_EXT]
    candidates += [os.path.join(base, "index" + e) for e in RESOLVE_EXT]
    for c in candidates:
        if c in files:
            return c
    return None


def find_cycles(graph, limit=15):
    """Tarjan SCC; report strongly connected components of size > 1."""
    index, low, on, stack, sccs = {}, {}, set(), [], []
    counter = [0]
    sys.setrecursionlimit(max(10000, len(graph) * 2))

    def strong(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on.add(v)
        for w in graph.get(v, ()):
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop()
                on.discard(w)
                comp.append(w)
                if w == v:
                    break
            if len(comp) > 1 or v in graph.get(v, ()):
                sccs.append(comp)

    for v in list(graph):
        if v not in index:
            strong(v)
    sccs.sort(key=len, reverse=True)
    return sccs[:limit]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    if not args:
        print(__doc__)
        sys.exit(1)
    root = os.path.abspath(args[0])
    if not os.path.isdir(root):
        print(f"Not a directory: {root}")
        sys.exit(1)

    files = [
        p
        for p in walk(root)
        if os.path.splitext(p)[1] in ALL_EXT and not p.endswith(".d.ts")
    ]
    fileset = set(files)
    rel = lambda p: os.path.relpath(p, root)

    ts_files = [f for f in files if os.path.splitext(f)[1] in TS_EXT]
    js_files = [f for f in files if os.path.splitext(f)[1] in JS_EXT]
    dts_count = sum(1 for p in walk(root) if p.endswith(".d.ts"))

    counts = defaultdict(int)
    per_file_escapes = {}
    cjs_files, esm_files, ts_nocheck_files = [], [], []
    graph = defaultdict(set)
    type_only_edges = set()
    fan_in = defaultdict(int)
    barrels = []
    deep_imports = []
    loc = {}

    ts_set = set(ts_files)
    for f in files:
        text = read(f)
        loc[f] = text.count("\n") + 1
        is_ts = f in ts_set
        if is_ts:
            n = 0
            for key, rx in PATTERNS.items():
                c = len(rx.findall(text))
                counts[key] += c
                if key in {"explicit_any", "as_unknown_as", "ts_ignore", "ts_nocheck"}:
                    n += c
            if n:
                per_file_escapes[f] = n
            if "@ts-nocheck" in text:
                ts_nocheck_files.append(f)
        if re.search(r"\brequire\(|module\.exports|\bexports\.\w+\s*=", text):
            cjs_files.append(f)
        if re.search(r"^\s*(import|export)\s", text, re.M):
            esm_files.append(f)

        name = os.path.basename(f)
        if re.match(r"index\.(ts|tsx|js|jsx|mjs|cjs)$", name):
            reexports = len(
                re.findall(
                    r"^\s*export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from", text, re.M
                )
            )
            if reexports >= 3:
                barrels.append((f, reexports))

        for line in text.splitlines():
            m = IMPORT_RE.search(line)
            if not m:
                continue
            spec = m.group(1)
            if spec.startswith("../../../"):
                deep_imports.append((f, spec))
            target = resolve(spec, f, root, fileset)
            if target and target != f:
                graph[f].add(target)
                fan_in[target] += 1
                if TYPE_ONLY_RE.match(line):
                    type_only_edges.add((f, target))

    # Make sure all nodes exist in graph
    for f in files:
        graph.setdefault(f, set())

    # tsconfig analysis
    tsconfigs = [
        p for p in walk(root) if re.match(r"tsconfig.*\.json$", os.path.basename(p))
    ]
    ts_report = []
    for p in sorted(tsconfigs)[:25]:
        cfg = load_tsconfig(p)
        if cfg is None:
            ts_report.append({"file": rel(p), "error": "could not parse"})
            continue
        co = cfg.get("compilerOptions", {}) or {}
        keys = [
            "strict",
            "noImplicitAny",
            "strictNullChecks",
            "noUncheckedIndexedAccess",
            "allowJs",
            "checkJs",
            "skipLibCheck",
            "isolatedModules",
            "verbatimModuleSyntax",
            "module",
            "moduleResolution",
            "target",
            "composite",
            "esModuleInterop",
        ]
        ts_report.append(
            {
                "file": rel(p),
                "extends": cfg.get("extends"),
                "options": {k: co[k] for k in keys if k in co},
                "has_references": bool(cfg.get("references")),
            }
        )

    # package.json facts
    pkg_facts = []
    for p in walk(root):
        if os.path.basename(p) == "package.json":
            try:
                d = json.loads(read(p))
            except Exception:
                continue
            pkg_facts.append(
                {
                    "file": rel(p),
                    "name": d.get("name"),
                    "type": d.get("type"),
                    "has_exports": "exports" in d,
                    "deps": len(d.get("dependencies", {})),
                    "devDeps": len(d.get("devDependencies", {})),
                }
            )

    cycles = find_cycles(graph)
    tooling = {
        "madge": any(
            "madge" in read(p)
            for p in walk(root)
            if os.path.basename(p) == "package.json"
        ),
        "dependency-cruiser": any(
            os.path.basename(p).startswith(".dependency-cruiser") for p in walk(root)
        ),
        "knip": any(
            "knip" in read(p)
            for p in walk(root)
            if os.path.basename(p) == "package.json"
        ),
    }

    top_fan_in = sorted(fan_in.items(), key=lambda kv: kv[1], reverse=True)[:10]
    top_fan_out = sorted(
        ((f, len(t)) for f, t in graph.items()), key=lambda kv: kv[1], reverse=True
    )[:10]
    biggest = sorted(loc.items(), key=lambda kv: kv[1], reverse=True)[:10]
    worst_escape = sorted(per_file_escapes.items(), key=lambda kv: kv[1], reverse=True)[
        :10
    ]

    result = {
        "root": root,
        "files": {"ts": len(ts_files), "js": len(js_files), "d_ts": dts_count},
        "escape_hatches": dict(counts),
        "ts_nocheck_files": [rel(f) for f in ts_nocheck_files][:20],
        "escape_hotspots": [(rel(f), n) for f, n in worst_escape],
        "cjs_files": len(cjs_files),
        "esm_files": len(esm_files),
        "mixed_cjs_esm_files": len(set(cjs_files) & set(esm_files)),
        "barrels": [(rel(f), n) for f, n in sorted(barrels, key=lambda x: -x[1])[:15]],
        "deep_relative_imports": len(deep_imports),
        "deep_import_examples": [(rel(f), s) for f, s in deep_imports[:8]],
        "tsconfigs": ts_report,
        "packages": pkg_facts[:25],
        "fan_in_top": [(rel(f), n) for f, n in top_fan_in],
        "fan_out_top": [(rel(f), n) for f, n in top_fan_out],
        "largest_files_loc": [(rel(f), n) for f, n in biggest],
        "cycles": [
            {
                "size": len(c),
                "files": [rel(x) for x in sorted(c)[:8]],
                "type_only": all(
                    (a, b) in type_only_edges for a in c for b in graph[a] if b in c
                ),
            }
            for c in cycles
        ],
        "architecture_tooling_detected": tooling,
    }

    if as_json:
        print(json.dumps(result, indent=2))
        return

    total = max(1, len(files))
    print(f"# Scan: {root}\n")
    print(
        f"Files: {len(ts_files)} TS/TSX, {len(js_files)} JS/JSX ({100 * len(ts_files) // total}% TS), {dts_count} .d.ts"
    )
    print("\n## Type escape hatches (TS files)")
    for k, v in counts.items():
        print(f"  {k}: {v}")
    if ts_nocheck_files:
        print(
            "  @ts-nocheck files: " + ", ".join(rel(f) for f in ts_nocheck_files[:10])
        )
    if worst_escape:
        print("  hotspots:")
        for f, n in worst_escape[:8]:
            print(f"    {rel(f)}: {n}")
    print("\n## tsconfig")
    if not ts_report:
        print("  none found")
    for t in ts_report:
        print(
            f"  {t['file']}  extends={t.get('extends')}  refs={t.get('has_references')}"
        )
        print(f"    {t.get('options', t.get('error'))}")
    print("\n## Module system")
    print(f"  files using require/module.exports: {len(cjs_files)}")
    print(f"  files using import/export: {len(esm_files)}")
    print(f"  files mixing both: {len(set(cjs_files) & set(esm_files))}")
    for p in pkg_facts[:10]:
        print(
            f"  {p['file']}: type={p['type']} exports={p['has_exports']} deps={p['deps']} dev={p['devDeps']}"
        )
    print("\n## Barrels (index files with 3+ re-exports)")
    for f, n in sorted(barrels, key=lambda x: -x[1])[:10]:
        print(f"  {rel(f)}: {n} re-exports")
    if not barrels:
        print("  none")
    print(f"\n## Deep relative imports (../../../): {len(deep_imports)}")
    for f, s in deep_imports[:6]:
        print(f"  {rel(f)} -> {s}")
    print("\n## Import cycles (relative imports only; aliases not resolved)")
    if not cycles:
        print("  none detected")
    for c in cycles[:10]:
        names = ", ".join(rel(x) for x in sorted(c)[:6])
        more = f" (+{len(c) - 6} more)" if len(c) > 6 else ""
        print(f"  cycle of {len(c)}: {names}{more}")
    print("\n## Fan-in (most imported)")
    for f, n in top_fan_in:
        print(f"  {n:4d}  {rel(f)}")
    print("\n## Fan-out (most imports)")
    for f, n in top_fan_out[:8]:
        print(f"  {n:4d}  {rel(f)}")
    print("\n## Largest files (LOC)")
    for f, n in biggest[:8]:
        print(f"  {n:5d}  {rel(f)}")
    print("\n## Architecture tooling detected")
    for k, v in tooling.items():
        print(f"  {k}: {'yes' if v else 'no'}")
    print(
        "\nNote: heuristic scan. Path aliases, dynamic imports and generated code are not fully resolved."
    )


if __name__ == "__main__":
    main()
