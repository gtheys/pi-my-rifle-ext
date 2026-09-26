/**
 * create_feature_tree tool — materialize a phase/subtask ticket tree under
 * an approved feature.
 *
 * AIDEV-NOTE: gate first — feature's plan-state metadata must be 'approved'
 * before any aven write happens. Non-approved states return a readable tool
 * error result (not a throw) and touch zero aven writes.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  avenAdd,
  avenDepAdd,
  avenEpicAdd,
  avenLabelCreate,
  avenShowFull,
} from '../shared/aven.ts'

export interface SubtaskInput {
  title: string
  body: string
}

export interface PhaseInput {
  title: string
  summary: string
  subtasks: SubtaskInput[]
}

export interface SubtaskResult {
  ref: string
  title: string
}

export interface PhaseResult {
  ref: string
  title: string
  subtasks: SubtaskResult[]
}

export interface CreateFeatureTreeResult {
  phases: PhaseResult[]
  /** Set when the plan-state gate rejects the call (zero aven writes). */
  error?: string
}

export async function createFeatureTree(
  pi: ExtensionAPI,
  featureRef: string,
  planPath: string,
  phases: PhaseInput[],
  cwd: string,
): Promise<CreateFeatureTreeResult> {
  const feature = await avenShowFull(pi, featureRef, cwd)
  const planState = feature.metadata['plan-state']
  if (planState !== 'approved') {
    return {
      phases: [],
      error: `create_feature_tree: ${featureRef} plan-state is "${planState ?? 'unset'}", must be "approved"`,
    }
  }

  await avenLabelCreate(pi, 'phase', cwd)
  await avenLabelCreate(pi, 'impl', cwd)

  const phaseResults: PhaseResult[] = []
  let prevPhaseRef: string | undefined

  for (let i = 0; i < phases.length; i += 1) {
    const phase = phases[i]
    const phasePrefix = `${i + 1}. `
    const phaseRef = await avenAdd(
      pi,
      {
        title: `${phasePrefix}${phase.title}`,
        labels: ['phase', 'impl'],
        description: phase.summary,
        metadata: { 'plan-path': planPath },
      },
      cwd,
    )
    await avenEpicAdd(pi, phaseRef, featureRef, cwd)
    if (prevPhaseRef !== undefined) {
      await avenDepAdd(pi, phaseRef, prevPhaseRef, cwd)
    }
    prevPhaseRef = phaseRef

    const subtaskResults: SubtaskResult[] = []
    for (let j = 0; j < phase.subtasks.length; j += 1) {
      const subtask = phase.subtasks[j]
      const subtaskPrefix = `${i + 1}.${j + 1} `
      const subtaskRef = await avenAdd(
        pi,
        {
          title: `${subtaskPrefix}${subtask.title}`,
          labels: ['impl'],
          description: subtask.body,
          metadata: { 'plan-path': planPath },
        },
        cwd,
      )
      await avenEpicAdd(pi, subtaskRef, featureRef, cwd)
      subtaskResults.push({ ref: subtaskRef, title: subtask.title })
    }

    phaseResults.push({
      ref: phaseRef,
      title: phase.title,
      subtasks: subtaskResults,
    })
  }

  return { phases: phaseResults }
}

function isGateError(result: CreateFeatureTreeResult): boolean {
  return result.error !== undefined
}

const SubtaskSchema = Type.Object({
  title: Type.String(),
  body: Type.String(),
})

const PhaseSchema = Type.Object({
  title: Type.String(),
  summary: Type.String(),
  subtasks: Type.Array(SubtaskSchema),
})

export function registerCreateFeatureTree(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'create_feature_tree',
    label: 'Create Feature Tree',
    description:
      'Materialize a phase/subtask ticket tree under an approved feature (plan-state=approved gate).',
    promptSnippet: 'Create the phase/subtask ticket tree for a feature',
    parameters: Type.Object({
      feature_ref: Type.String({ description: 'Feature ticket ref' }),
      plan_path: Type.String({ description: 'Absolute path to plan.md' }),
      phases: Type.Array(PhaseSchema),
      cwd: Type.String({ description: 'Working directory for aven commands' }),
    }),
    async execute(_id, params) {
      const result = await createFeatureTree(
        pi,
        params.feature_ref,
        params.plan_path,
        params.phases,
        params.cwd,
      )
      if (isGateError(result)) {
        return {
          content: [{ type: 'text', text: result.error ?? 'gate rejected' }],
          details: result,
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: `created ${result.phases.length} phase(s) under ${params.feature_ref}`,
          },
        ],
        details: result,
      }
    },
  })
}
