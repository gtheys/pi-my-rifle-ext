#!/usr/bin/env python3
"""Detect how to verify a TS/JS repo after each refactoring step.

Usage: python detect_checks.py <repo-root> [--json]

Finds the package manager, the typecheck / lint / test / build commands, the
test framework, and whether the repo has untyped JS that tsc will not catch.
It only reads files; it never runs anything. Run the printed commands yourself,
first to record a baseline, then after every refactoring step.
"""

import json
import os
import re
import sys

IGNORE = {"node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo", "out"}

LOCKFILES = [
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("bun.lockb", "bun"),
    ("bun.lock", "bun"),
    ("package-lock.json", "npm"),
    ("npm-shrinkwrap.json", "npm"),
]

SCRIPT_GROUPS = {
    "typecheck": re.compile(
        r"^(typecheck|type-check|check-types|types|tsc|check:types|lint:types)$"
    ),
    "lint": re.compile(r"^(lint|lint:ts|lint:js|eslint|biome|check:lint|lint:check)$"),
    "test": re.compile(r"^(test|test:unit|test:ci|tests|vitest|jest|unit)$"),
    "build": re.compile(r"^(build|compile|build:ci)$"),
    "format": re.compile(r"^(format:check|fmt:check|prettier:check|check:format)$"),
}

TEST_FRAMEWORKS = [
    "vitest",
    "jest",
    "mocha",
    "ava",
    "tap",
    "uvu",
    "playwright",
    "@playwright/test",
    "cypress",
    "@testing-library/react",
]


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def run_cmd(pm, script):
    if pm == "npm":
        return f"npm run {script}" if script != "test" else "npm test"
    if pm == "yarn":
        return f"yarn {script}"
    if pm == "bun":
        return f"bun run {script}"
    return f"pnpm {script}"


def find_package_jsons(root, limit=40):
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORE]
        if "package.json" in filenames:
            found.append(os.path.join(dirpath, "package.json"))
            if len(found) >= limit:
                break
    return sorted(found, key=lambda p: p.count(os.sep))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        sys.exit(1)
    root = os.path.abspath(args[0])
    as_json = "--json" in sys.argv

    pm = None
    for lock, name in LOCKFILES:
        if os.path.exists(os.path.join(root, lock)):
            pm = name
            break
    pm = pm or "npm"

    pkgs = find_package_jsons(root)
    root_pkg = read_json(os.path.join(root, "package.json")) or {}
    monorepo = (
        bool(root_pkg.get("workspaces"))
        or os.path.exists(os.path.join(root, "pnpm-workspace.yaml"))
        or any(
            os.path.exists(os.path.join(root, f))
            for f in ("nx.json", "turbo.json", "lerna.json")
        )
    )

    commands = {}
    per_package = []
    for p in pkgs:
        d = read_json(p) or {}
        scripts = d.get("scripts", {}) or {}
        found = {}
        for group, rx in SCRIPT_GROUPS.items():
            for name in scripts:
                if rx.match(name):
                    found[group] = name
                    break
        deps = {**(d.get("dependencies") or {}), **(d.get("devDependencies") or {})}
        fws = [f for f in TEST_FRAMEWORKS if f in deps]
        rel = os.path.relpath(os.path.dirname(p), root) or "."
        per_package.append(
            {
                "dir": rel,
                "scripts": found,
                "test_frameworks": fws,
                "has_eslint": "eslint" in deps,
                "has_biome": "@biomejs/biome" in deps,
                "has_typescript": "typescript" in deps,
            }
        )
        if rel == ".":
            for g, name in found.items():
                commands[g] = run_cmd(pm, name)

    # Fallbacks when scripts are missing
    has_tsconfig = os.path.exists(os.path.join(root, "tsconfig.json"))
    notes = []
    if "typecheck" not in commands and has_tsconfig:
        commands["typecheck"] = "npx tsc --noEmit"
        notes.append("No typecheck script; falling back to `npx tsc --noEmit`.")
    if "typecheck" not in commands and not has_tsconfig:
        notes.append(
            "No root tsconfig.json found; type errors will not be caught. Check sub-packages."
        )
    if "test" not in commands:
        if any(per_package and p["test_frameworks"] for p in per_package):
            notes.append(
                "A test framework is installed but no root test script exists; look in sub-package scripts."
            )
        else:
            notes.append(
                "No test command found. Add characterization tests before refactoring (see SKILL.md)."
            )
    if monorepo:
        notes.append(
            "Monorepo detected: prefer running checks only for affected packages (e.g. `pnpm --filter <pkg> test`, `nx affected`, `turbo run test --filter=...`), then the full suite at the end."
        )

    # Does tsc actually cover JS?
    js_unchecked = None
    if has_tsconfig:
        raw = ""
        try:
            with open(os.path.join(root, "tsconfig.json"), encoding="utf-8") as fh:
                raw = fh.read()
        except OSError:
            pass
        allow = re.search(r'"allowJs"\s*:\s*true', raw)
        check = re.search(r'"checkJs"\s*:\s*true', raw)
        js_unchecked = not (allow and check)
        if js_unchecked:
            notes.append(
                "tsc does NOT check JS files (checkJs off or inherited). Refactors touching .js code need tests, not just a typecheck."
            )

    for cfg in (
        "eslint.config.js",
        "eslint.config.mjs",
        "eslint.config.ts",
        ".eslintrc",
        ".eslintrc.js",
        ".eslintrc.cjs",
        ".eslintrc.json",
        "biome.json",
        "biome.jsonc",
    ):
        if os.path.exists(os.path.join(root, cfg)):
            notes.append(f"Lint config present: {cfg}")
            break

    order = [
        commands[g] for g in ("typecheck", "lint", "test", "build") if g in commands
    ]
    result = {
        "root": root,
        "package_manager": pm,
        "monorepo": monorepo,
        "commands": commands,
        "suggested_order": order,
        "js_unchecked_by_tsc": js_unchecked,
        "packages": per_package[:15],
        "notes": notes,
    }

    if as_json:
        print(json.dumps(result, indent=2))
        return

    print(f"# Verification plan: {root}\n")
    print(f"Package manager: {pm}   Monorepo: {'yes' if monorepo else 'no'}")
    print("\nCommands detected:")
    for g in ("typecheck", "lint", "test", "build", "format"):
        print(f"  {g:10s} {commands.get(g, '-')}")
    if order:
        print("\nRun after every step (fast to slow):")
        print("  " + "  &&  ".join(order))
    print("\nPackages:")
    for p in per_package[:12]:
        print(f"  {p['dir']}: scripts={p['scripts']} tests={p['test_frameworks']}")
    if notes:
        print("\nNotes:")
        for n in notes:
            print(f"  - {n}")


if __name__ == "__main__":
    main()
