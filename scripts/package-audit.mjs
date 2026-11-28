#!/usr/bin/env node
// AIDEV-NOTE: PMR-0SWR governed-distribution audit. Three checks per publishable workspace:
// 1. `npm pack --dry-run` output must be fully covered by the package.json `files`
//    allowlist (plus npm always-included files), and every `files` entry must exist.
// 2. Packed file contents are scanned for secrets and absolute home paths.
// 3. Import reachability (PMR-0AN2): every local file statically reachable from the
//    package entrypoints (pi.extensions + exports) must be covered by the `files`
//    allowlist — a missing entry crashes the published package at load time with
//    MODULE_NOT_FOUND, which checks 1-2 structurally cannot catch (they only look
//    at what npm packs from the allowlist, never at what the code imports).
// Exit 1 on any violation. Run: `node scripts/package-audit.mjs` (or `bun run audit:pack`).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkImportReachability, isCovered } from "./lib/package-reachability.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const home = process.env.HOME;

// High-signal secret patterns only — avoid false positives on docs.
const SECRET_PATTERNS = [
	{ name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
	{ name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

function scanContents(pkgDir, packedFiles) {
	const findings = [];
	for (const rel of packedFiles) {
		if (rel === "package.json") continue;
		const abs = join(pkgDir, rel);
		let content;
		try {
			content = readFileSync(abs, "utf8");
		} catch {
			continue; // binary or unreadable — skip
		}
		for (const { name, re } of SECRET_PATTERNS) {
			if (re.test(content)) findings.push(`${rel}: matches ${name}`);
		}
		if (home && content.includes(home)) findings.push(`${rel}: contains absolute home path ${home}`);
	}
	return findings;
}

let failures = 0;
const workspaces = rootPkg.workspaces ?? [];
for (const pattern of workspaces) {
	// Only flat globs like "packages/*" are used in this repo.
	const base = pattern.replace(/\/\*$/, "");
	const dirs = execFileSync("ls", [join(root, base)], { encoding: "utf8" }).trim().split("\n");
	for (const dir of dirs) {
		const pkgDir = join(root, base, dir);
		const pkgJsonPath = join(pkgDir, "package.json");
		if (!existsSync(pkgJsonPath)) continue;
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
		if (pkg.private) continue;

		const filesEntries = pkg.files ?? [];
		if (filesEntries.length === 0) {
			console.log(`FAIL ${pkg.name}: no "files" allowlist`);
			failures++;
			continue;
		}

		for (const entry of filesEntries) {
			if (!existsSync(join(pkgDir, entry))) {
				console.log(`FAIL ${pkg.name}: files entry "${entry}" does not exist`);
				failures++;
			}
		}

		const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: pkgDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		// npm prints the JSON array on stdout.
		const parsed = JSON.parse(out);
		const packedFiles = parsed[0].files.map((f) => f.path);

		const uncovered = packedFiles.filter((p) => !isCovered(p, filesEntries));
		for (const p of uncovered) {
			console.log(`FAIL ${pkg.name}: packed "${p}" not covered by files allowlist`);
			failures++;
		}

		const leaks = scanContents(pkgDir, packedFiles);
		for (const leak of leaks) {
			console.log(`FAIL ${pkg.name}: ${leak}`);
			failures++;
		}

		const unreachable = checkImportReachability(pkgDir, filesEntries, pkg);
		for (const finding of unreachable) {
			console.log(`FAIL ${pkg.name}: ${finding}`);
			failures++;
		}

		if (uncovered.length === 0 && leaks.length === 0 && unreachable.length === 0) {
			console.log(`OK   ${pkg.name} (${packedFiles.length} files packed, allowlist clean)`);
		}
	}
}

if (failures > 0) {
	console.error(`\npackage-audit: ${failures} violation(s)`);
	process.exit(1);
}
console.log("\npackage-audit: all workspaces clean");
