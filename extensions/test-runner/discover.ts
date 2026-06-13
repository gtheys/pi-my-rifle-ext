/**
 * Test script discovery from package.json.
 *
 * Walks up the directory tree from a given start path to find the nearest
 * package.json, then extracts scripts whose keys match known test patterns.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface TestScript {
  key: string;
  command: string;
}

export interface DiscoveryResult {
  scripts: TestScript[];
  packageDir: string | null;
}

// AIDEV-NOTE: Extend this list when adding support for more test frameworks.
const TEST_KEY_PATTERNS = [
  /^test$/,
  /^test:/,
  /^jest$/,
  /^vitest$/,
  /^playwright$/,
  /^mocha$/,
  /^cypress$/,
  /^e2e$/,
  /^e2e:/,
  /^spec$/,
];

function isTestKey(key: string): boolean {
  return TEST_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Walk up from startDir to find the nearest package.json.
 * Returns all scripts whose key matches known test patterns,
 * plus the directory where package.json was found.
 */
export function discoverTestScripts(startDir: string): DiscoveryResult {
  let dir = startDir;

  while (true) {
    const pkgPath = path.join(dir, "package.json");

    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        const scripts = pkg.scripts ?? {};
        const testScripts = Object.entries(scripts)
          .filter(([key]) => isTestKey(key))
          .map(([key, command]) => ({ key, command }));
        return { scripts: testScripts, packageDir: dir };
      } catch {
        return { scripts: [], packageDir: dir };
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { scripts: [], packageDir: null };
}

/**
 * Detect package manager from lockfile presence. Defaults to npm.
 */
export function detectPackageManager(dir: string): "yarn" | "pnpm" | "npm" {
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

/**
 * Build the shell command to run a given script key using the detected package manager.
 * e.g. key="test:unit", yarn → "yarn test:unit"
 */
export function buildRunCommand(key: string, dir: string): string {
  const pm = detectPackageManager(dir);
  switch (pm) {
    case "yarn":
      return `yarn ${key}`;
    case "pnpm":
      return `pnpm run ${key}`;
    default:
      return key === "test" ? "npm test" : `npm run ${key}`;
  }
}
