import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@mariozechner/pi-coding-agent'

export type SubagentsDataDirName =
  | 'results'
  | 'result-ref-reservations'
  | 'peers'
  | 'asks'
  | 'assignments'
  | 'inbox'
  | 'delivered'
  | 'spawn-seq'
  | 'retired'

export const SUBAGENTS_DATA_DIR_NAMES: readonly SubagentsDataDirName[] = [
  'results',
  'result-ref-reservations',
  'peers',
  'asks',
  'assignments',
  'inbox',
  'delivered',
  'spawn-seq',
  'retired',
]

/** Durable data root for pi-interactive-subagents: <agentDir>/pi-subagents/. */
export function subagentsDataRoot(agentDir: string = getAgentDir()): string {
  return join(agentDir, 'pi-subagents')
}

// AIDEV-NOTE: lazily creates the named data subdir on first use. Private
// per-user data (subagent results, peer inboxes) — enforce 0700 explicitly
// because umask may weaken mkdir's mode.
export function ensureSubagentsDataDir(
  name: SubagentsDataDirName,
  root: string = subagentsDataRoot(),
): string {
  mkdirSync(root, { recursive: true })
  chmodSync(root, 0o700)
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o700)
  return dir
}
