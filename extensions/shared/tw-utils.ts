/**
 * Shared taskwarrior helpers.
 * Used by both plan-tools and implement-plan extensions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Run `task <filter> export` and parse the JSON result. */
export async function twExport(pi: ExtensionAPI, filter: string[]): Promise<any[]> {
  const result = await pi.exec("task", [...filter, "export"], {});
  if (!result.stdout.trim()) return [];
  try {
    return JSON.parse(result.stdout);
  } catch {
    return [];
  }
}
