// AIDEV-NOTE: pi-bash-guard tier-0 pure classifier. Three tiers, all pure so
// the smuggling cases stay unit-testable without a decider or a Pi session:
//   allow  — single read-only command, no shell metacharacters (fast path,
//            never hits the decider)
//   deny   — catastrophic patterns no agent session should ever run; blocked
//            outright with no approval path (a human can still run them by
//            hand — humans own the machine)
//   decider — everything else: the strands-decider verdict (flow/decider.ts)
//            decides auto-allow vs human confirmation
// Guardrail, not a privilege boundary (same stance as flow/land-gate.ts):
// aliases, `sh -c '...'`, and variable-built commands are not decoded.
import type { DeciderVerdict } from './decider.ts'

// Command starts, and only read-only verbs, with no shell metacharacter
// anywhere in the string. A metacharacter anywhere (`; | & > < \` $ ( )` or a
// newline) demotes the whole command to the decider tier — `ls && rm -rf x`
// must NEVER match the allowlist via its first word.
const METACHARS = /[\n;&|><`$()]/

// AIDEV-NOTE: find(1) is only read-only without -delete/-exec/-fprint; those
// flags demote to the decider even though the rest of the command is plain.
const FIND_WRITES =
  /(^|\s)-(delete|exec|execdir|fprint|fprint0|fprintf|ok|okdir)\b/

const ALLOW_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  // filesystem reads
  { name: 'ls', re: /^ls\b/ },
  { name: 'pwd', re: /^pwd\b/ },
  { name: 'cat', re: /^cat\b/ },
  { name: 'head', re: /^head\b/ },
  { name: 'tail', re: /^tail\b/ },
  { name: 'wc', re: /^wc\b/ },
  { name: 'tree', re: /^tree\b/ },
  { name: 'file', re: /^file\b/ },
  { name: 'stat', re: /^stat\b/ },
  { name: 'du', re: /^du\b/ },
  { name: 'df', re: /^df\b/ },
  { name: 'echo', re: /^echo\b/ },
  { name: 'which', re: /^which\b/ },
  { name: 'whoami', re: /^whoami\b/ },
  { name: 'date', re: /^date\b/ },
  { name: 'uname', re: /^uname\b/ },
  // search
  { name: 'rg', re: /^rg\b/ },
  { name: 'grep', re: /^grep\b/ },
  { name: 'fd', re: /^fd\b/ },
  { name: 'find', re: /^find\b/ },
  { name: 'jq', re: /^jq\b/ },
  // git reads (mutations like add/commit/checkout/reset go to the decider)
  { name: 'git status', re: /^git\s+status\b/ },
  { name: 'git diff', re: /^git\s+diff\b/ },
  { name: 'git log', re: /^git\s+log\b/ },
  { name: 'git show', re: /^git\s+show\b/ },
  {
    name: 'git branch (read)',
    re: /^git\s+branch(-a|-v|-vv|--list|\s+-[av])*\s*$/,
  },
  { name: 'git rev-parse', re: /^git\s+rev-parse\b/ },
  { name: 'git describe', re: /^git\s+describe\b/ },
  { name: 'git remote -v', re: /^git\s+remote\s+(-v|--verbose)\s*$/ },
  { name: 'git stash list', re: /^git\s+stash\s+list\b/ },
  { name: 'git worktree list', re: /^git\s+worktree\s+list\b/ },
  { name: 'git config --get', re: /^git\s+config\s+--get\b/ },
  // test/check runners (repo gates)
  { name: 'node --test', re: /^node\s+--test\b/ },
  { name: 'node --version', re: /^node\s+--version\b/ },
  { name: 'npm test', re: /^npm\s+(test|run\s+(test|lint|typecheck|check))\b/ },
  { name: 'bun test', re: /^bun\s+(test|run\s+(test|lint|typecheck|check))\b/ },
  { name: 'bunx biome check', re: /^bunx\s+biome\s+check\b/ },
  { name: 'npx tsc', re: /^npx\s+tsc\b/ },
]

// Catastrophic patterns: blocked with no approval path. Deliberately short —
// the destructive-but-sometimes-legit range (rm in a worktree, git reset
// --hard, ...) belongs to the decider + human confirm, not here.
const DENY_PATTERNS: ReadonlyArray<{ reason: string; re: RegExp }> = [
  { reason: 'filesystem formatting', re: /\bmkfs(\.\w+)?\b/ },
  {
    reason: 'raw device write',
    re: /\bdd\b[^|]*\bof=\/dev\/|>\s*\/dev\/(sd|nvme|hd|vd)/,
  },
  { reason: 'fork bomb', re: /:\(\)\s*\{.*\}\s*;\s*:/ },
  {
    reason: 'remote script piped to a shell',
    re: /\b(curl|wget)\b[^|]*\|\s*(ba|z|fi|da)?sh\b/,
  },
  {
    reason: 'rm -rf at filesystem root or home',
    re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/(\s|$|\*)|~(\/|\s|$)|\$HOME\b)/,
  },
  {
    reason: 'chmod recursive at filesystem root or home',
    re: /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)+(\/(\s|$)|~(\/|\s|$)|\$HOME\b)/,
  },
  {
    reason: 'system shutdown/reboot',
    re: /\b(shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/,
  },
]

export type CommandClass =
  | { tier: 'allow' }
  | { tier: 'deny'; reason: string }
  | { tier: 'decider' }

export function classifyCommand(command: string): CommandClass {
  for (const pattern of DENY_PATTERNS) {
    if (pattern.re.test(command)) {
      return { tier: 'deny', reason: pattern.reason }
    }
  }
  const trimmed = command.trim()
  if (METACHARS.test(command)) return { tier: 'decider' }
  if (FIND_WRITES.test(trimmed) && /^find\b/.test(trimmed)) {
    return { tier: 'decider' }
  }
  for (const pattern of ALLOW_PATTERNS) {
    if (pattern.re.test(trimmed)) return { tier: 'allow' }
  }
  return { tier: 'decider' }
}

export type DeciderOutcome =
  | { action: 'allow' }
  | { action: 'confirm'; detail: string }

// AIDEV-NOTE: pure verdict combiner. null verdict (unreachable/unparseable
// server) confirms with a human — fail-closed, never a silent allow.
export function deciderOutcome(
  verdict: DeciderVerdict,
  threshold: number,
): DeciderOutcome {
  if (verdict === null) {
    return {
      action: 'confirm',
      detail: 'decider unreachable or returned an unusable answer',
    }
  }
  if (verdict.choice === 'safe' && verdict.confidence >= threshold) {
    return { action: 'allow' }
  }
  if (verdict.choice === 'safe') {
    return {
      action: 'confirm',
      detail: `decider says safe but confidence ${verdict.confidence.toFixed(2)} is below the threshold ${threshold.toFixed(2)}`,
    }
  }
  return {
    action: 'confirm',
    detail: `decider says destructive (confidence ${verdict.confidence.toFixed(2)})`,
  }
}

// The message shown in the human confirmation dialog.
export function confirmMessage(
  command: string,
  outcome: Extract<DeciderOutcome, { action: 'confirm' }>,
): string {
  return `Approve this bash command?\n\n$ ${command}\n\n${outcome.detail}`
}
