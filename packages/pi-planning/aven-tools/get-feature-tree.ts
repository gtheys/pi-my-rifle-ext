/**
 * get_feature_tree tool — read a feature's phase/subtask tree from
 * `aven epic list`, classify + sort it, and compute the resume pointer
 * (first non-done phase, or null when all phases are done).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { avenEpicList } from '../shared/aven.ts'

export interface FeatureTreeSubtask {
  ref: string
  title: string
  status: string
}

export interface FeatureTreePhase {
  ref: string
  title: string
  status: string
  subtasks: FeatureTreeSubtask[]
}

export interface FeatureTreeResult {
  phases: FeatureTreePhase[]
  resumeRef: string | null
}

const PHASE_TITLE_PATTERN = /^(\d+)\.\s/
const SUBTASK_TITLE_PATTERN = /^(\d+)\.(\d+)\s/

/** Defensive string field pick — unknown/non-string yields ''. */
function pickString(record: unknown, field: string): string {
  if (typeof record !== 'object' || record === null) {
    return ''
  }
  const value = (record as Record<string, unknown>)[field]
  if (typeof value === 'string') {
    return value
  }
  return ''
}

function pickBool(record: unknown, field: string): boolean {
  if (typeof record !== 'object' || record === null) {
    return false
  }
  return (record as Record<string, unknown>)[field] === true
}

/**
 * AIDEV-NOTE: classification is title-regex-first (numeric prefix), with
 * is_epic as the phase/subtask discriminator — subtask titles ("N.M ...")
 * never carry is_epic:true in practice, but the flag is checked defensively
 * in case a subtask is mistakenly epic-flagged upstream.
 */
function isPhase(item: unknown): boolean {
  const title = pickString(item, 'title')
  return PHASE_TITLE_PATTERN.test(title) && pickBool(item, 'is_epic')
}

function isSubtask(item: unknown): boolean {
  const title = pickString(item, 'title')
  return SUBTASK_TITLE_PATTERN.test(title) && !pickBool(item, 'is_epic')
}

/** Leading "N" from a phase title, or Infinity if unparseable (sorts last). */
function phaseSortKey(title: string): number {
  const match = title.match(PHASE_TITLE_PATTERN)
  if (match === null) {
    return Number.POSITIVE_INFINITY
  }
  return Number.parseInt(match[1], 10)
}

/** Leading "N.M" from a subtask title, or Infinity if unparseable (sorts last). */
function subtaskSortKey(title: string): number {
  const match = title.match(SUBTASK_TITLE_PATTERN)
  if (match === null) {
    return Number.POSITIVE_INFINITY
  }
  return Number.parseInt(match[1], 10) * 1000 + Number.parseInt(match[2], 10)
}

export async function getFeatureTree(
  pi: ExtensionAPI,
  featureRef: string,
  cwd: string,
): Promise<FeatureTreeResult> {
  const items = await avenEpicList(pi, featureRef, cwd)

  const phases = items
    .filter(isPhase)
    .map((item) => ({
      ref: pickString(item, 'ref'),
      title: pickString(item, 'title'),
      status: pickString(item, 'status'),
      subtasks: [] as FeatureTreeSubtask[],
    }))
    .sort((a, b) => phaseSortKey(a.title) - phaseSortKey(b.title))

  const subtasks = items
    .filter(isSubtask)
    .map((item) => ({
      ref: pickString(item, 'ref'),
      title: pickString(item, 'title'),
      status: pickString(item, 'status'),
    }))
    .sort((a, b) => subtaskSortKey(a.title) - subtaskSortKey(b.title))

  for (const subtask of subtasks) {
    const phaseNumber = Math.trunc(subtaskSortKey(subtask.title) / 1000)
    const phase = phases.find(
      (candidate) => phaseSortKey(candidate.title) === phaseNumber,
    )
    if (phase !== undefined) {
      phase.subtasks.push(subtask)
    }
  }

  const resumePhase = phases.find((phase) => phase.status !== 'done')
  const resumeRef = resumePhase === undefined ? null : resumePhase.ref

  return { phases, resumeRef }
}

export function registerGetFeatureTree(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'get_feature_tree',
    label: 'Get Feature Tree',
    description:
      'Read a feature ticket\u2019s phase/subtask tree via `aven epic list`, sorted numerically, with a resume pointer (first non-done phase, or null when all done).',
    promptSnippet:
      'Read a feature\u2019s phase/subtask tree and resume pointer',
    parameters: Type.Object({
      feature_ref: Type.String({ description: 'Feature ticket ref' }),
      cwd: Type.String({ description: 'Working directory for aven commands' }),
    }),
    async execute(_id, params) {
      const result = await getFeatureTree(pi, params.feature_ref, params.cwd)
      return {
        content: [
          {
            type: 'text',
            text: `${params.feature_ref}: ${result.phases.length} phases, resume=${result.resumeRef ?? 'none'}`,
          },
        ],
        details: result,
      }
    },
  })
}
