// AIDEV-NOTE: PMR-9ASP — hand-written declarations for the plain-.mjs
// reachability core so TS tests can import it (precedent:
// plugins/herdr/flow-viewer.d.mts, packages/pi-flow/review/sem-guidance.d.mts).
/** Loose structural mirror of the package.json fields the walker reads. */
export interface ReachabilityPkgJson {
  pi?: { extensions?: unknown } | undefined
  exports?: unknown
}
export declare function isCovered(
  packedPath: string,
  filesEntries: readonly string[],
): boolean
export declare function entryPoints(pkg: ReachabilityPkgJson): string[]
export declare function checkImportReachability(
  pkgDir: string,
  filesEntries: readonly string[],
  pkg: ReachabilityPkgJson,
): string[]
