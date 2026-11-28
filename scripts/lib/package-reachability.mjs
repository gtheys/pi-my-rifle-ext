// AIDEV-NOTE: PMR-9ASP — shared import-reachability core, moved verbatim out of
// scripts/package-audit.mjs (PMR-0SWR/PMR-0AN2) so the release audit and the
// pi-flow default-suite files-allowlist gate
// (packages/pi-flow/test/packaged-allowlist.test.ts) import ONE implementation
// and semantics cannot drift. Dependency-free: node builtins only. No top-level
// side effects — safe to import from tests.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// npm always packs these regardless of `files`.
const ALWAYS_INCLUDED = /^package\.json$|^(README|LICEN[SC]E|COPYING|CHANGELOG|HISTORY|NOTICE)(\.|$)/i;

function isCovered(packedPath, filesEntries) {
	if (ALWAYS_INCLUDED.test(packedPath)) return true;
	for (const entry of filesEntries) {
		const clean = entry.replace(/\/$/, "");
		if (packedPath === clean) return true;
		if (packedPath.startsWith(`${clean}/`)) return true;
	}
	return false;
}

// AIDEV-NOTE: PMR-0AN2 — matches static `import/export … from '<rel>'` and dynamic
// `import('<rel>')` specifiers. Good enough for this repo's style (explicit .ts/.mjs
// suffixes, no extension-less or alias imports); a specifier it misses degrades to
// "not walked", never to a false FAIL.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g;

function entryPoints(pkg) {
	const entries = [];
	for (const ext of pkg.pi?.extensions ?? []) {
		if (typeof ext === "string") entries.push(ext);
	}
	const exports = pkg.exports;
	if (typeof exports === "string") entries.push(exports);
	else if (exports && typeof exports === "object") {
		for (const value of Object.values(exports)) {
			if (typeof value === "string") entries.push(value);
			else if (value && typeof value === "object") {
				for (const target of Object.values(value)) {
					if (typeof target === "string") entries.push(target);
				}
			}
		}
	}
	return entries.map((e) => e.replace(/^\.\//, "")).filter((e) => e !== "");
}

function checkImportReachability(pkgDir, filesEntries, pkg) {
	const findings = [];
	const seen = new Set();
	const queue = entryPoints(pkg).map((rel) => ({ rel, importer: "(entry)" }));
	while (queue.length > 0) {
		const { rel, importer } = queue.shift();
		if (seen.has(rel)) continue;
		seen.add(rel);
		const abs = join(pkgDir, rel);
		if (!existsSync(abs)) {
			findings.push(`imported file "${rel}" (from ${importer}) does not exist`);
			continue;
		}
		if (!isCovered(rel, filesEntries)) {
			findings.push(`statically imported "${rel}" (from ${importer}) is not in the files allowlist`);
		}
		if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(rel)) continue;
		let content;
		try {
			content = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		for (const m of content.matchAll(IMPORT_RE)) {
			const resolved = normalize(join(dirname(rel), m[1]));
			if (resolved.startsWith("..")) continue; // outside the package
			queue.push({ rel: resolved, importer: rel });
		}
	}
	return findings;
}

export { isCovered, entryPoints, checkImportReachability };
