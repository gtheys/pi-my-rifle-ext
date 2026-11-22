// AIDEV-NOTE: Pure /flow arg parsing — ref only (PMR-Z2K7: --skip-research
// removed with the research phase). Same jira/aven split as implement/args.ts.
// Yolo mode (PMR yolo plan 1.1): `--yolo` may trail a ref (runs without gates)
// or stand alone as a picker invocation. It must NEVER fall through to
// parseRefKind — '--yolo' matches the ref charset and would start a run for a
// ticket named '--yolo'.

import { parseRefKind } from './ref-kind.ts'

// AIDEV-NOTE: PMR-N181 — exported so index.ts's usage notify and its test
// pin one string. Mentions --yolo (personal-mode only, PMR-ZRMQ).
export const FLOW_USAGE =
  'Usage: /flow <jira-id | aven-ref | aven:<ref> | jira:<key>> [--yolo] | /flow --yolo. --yolo runs without the receipt gates (personal mode only). Brainstorm topics go through /brainstorm.'

export type FlowArgs =
  | { kind: 'jira'; jiraId: string; yolo: boolean }
  | { kind: 'aven'; ref: string; yolo: boolean }
  | { kind: 'picker'; yolo: true }
  | { kind: 'help' }

export function parseFlowArgs(raw: string): FlowArgs {
  const parts = raw.trim().split(/\s+/)
  if (parts.length === 0 || parts[0] === '') return { kind: 'help' }
  if (parts.length > 2) return { kind: 'help' }
  const token = parts[0] ?? ''
  // PMR-N0W6: a literal '/flow help' is a usage request, not a run for a
  // ticket named 'help' — reserve the exact token (case-insensitive) in every
  // shape. Similar-but-different tokens ('helpme') still parse as refs.
  if (token.toLowerCase() === 'help') return { kind: 'help' }
  if (parts.length === 1) {
    // Single token: bare '--yolo' is the picker invocation — reserved here so
    // it never reaches parseRefKind ('--yolo' matches the ref charset).
    if (token === '--yolo') return { kind: 'picker', yolo: true }
    return parseRefToken(token, false)
  }
  // Two tokens: '<ref> --yolo' only. Flag-first ('--yolo <ref>') is usage.
  const flag = parts[1] ?? ''
  if (flag !== '--yolo') return { kind: 'help' }
  return parseRefToken(token, true)
}

function parseRefToken(token: string, yolo: boolean): FlowArgs {
  const parsed = parseRefKind(token)
  if (parsed.kind === 'jira') {
    return { kind: 'jira', jiraId: parsed.jiraId, yolo }
  }
  return { kind: 'aven', ref: parsed.ref, yolo }
}
