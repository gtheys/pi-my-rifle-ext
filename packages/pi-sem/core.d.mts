// AIDEV-NOTE: Loose type declarations for the .mjs glue module.
// Signatures are intentionally permissive (`any`) to preserve the prior
// implicit-any behaviour now that tsc checks this workspace. Tighten these
// when the core module is ported to TypeScript.
export declare const SEM_INSTALL_HINT: unknown
export declare function normalizeSelection(selection?: unknown): any
export declare function describeSelection(selection?: unknown): any
export declare function buildSemDiffArgs(selection?: unknown): string[]
export declare function buildGitDiffArgs(selection?: unknown): string[]
export declare function buildGitNameOnlyArgs(selection?: unknown): string[]
export declare function buildImpactArgs(opts: {
  entity: string
  file?: string
  scope?: string
}): string[]
export declare function buildContextArgs(opts: {
  entity: string
  file?: string
  budget?: number
}): string[]
export declare function buildLogArgs(opts: {
  entity: string
  file?: string
  limit?: number
  verbose?: boolean
}): string[]
export declare function buildEntitiesArgs(opts: { file?: string }): string[]
export declare function buildBlameArgs(opts: { file?: string }): string[]
export declare function resolveSemInvocation(cwd?: string): {
  command: string
  argsPrefix: string[]
  source: string
}
export declare function parseSemJsonOutput(toolName: string, text: string): any
export declare function summarizeSemDiffPayload(payload: unknown): any
export declare function compareCoverage(
  gitFiles?: string[],
  semFiles?: string[],
): { missing: string[]; extra: string[] }
export declare function pickImpactTargets(payload: unknown, limit?: number): any
export declare function buildEvaluationReport(opts: unknown): any
export declare function formatEvaluationReport(report: unknown): string
