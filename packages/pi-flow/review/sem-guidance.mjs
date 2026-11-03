export function getSemToolAvailability(activeToolNames = []) {
  const names = new Set(Array.isArray(activeToolNames) ? activeToolNames : [])
  return {
    diff: names.has('sem_diff'),
    impact: names.has('sem_impact'),
    context: names.has('sem_context'),
    entities: names.has('sem_entities'),
    any:
      names.has('sem_diff') ||
      names.has('sem_impact') ||
      names.has('sem_context') ||
      names.has('sem_entities'),
  }
}

function diffStep(target, tools) {
  if (!tools.diff) return null

  switch (target.type) {
    case 'uncommitted':
      return 'Start with `sem_diff` on the working tree to identify the changed functions, classes, blocks, and properties before reading large raw diffs.'
    case 'commit':
      return `Start with \`sem_diff\` for commit \`${target.sha}\` to inventory changed entities and spot the riskiest touched code paths.`
    case 'baseBranch':
      if (target.mergeBase) {
        return `Start with \`sem_diff\` over the range \`${target.mergeBase}..HEAD\` to see the semantic shape of the branch before diving into line hunks.`
      }
      return `Use \`sem_diff\` once you know the merge-base range for branch \`${target.branch}\`; use it for overview, not as the only source of review evidence.`
    case 'pullRequest':
      if (target.mergeBase) {
        return `Start with \`sem_diff\` over \`${target.mergeBase}..HEAD\` to understand the PR's changed entities before line-level verification.`
      }
      return `Use \`sem_diff\` for the PR diff once the merge base is known; use it as a semantic overview, not the sole review source.`
    case 'folder':
      return null
    case 'custom':
      return 'Use `sem_diff` only if the custom instructions are about change analysis or review summaries; do not default to it for snapshot/file-reading tasks.'
    default:
      return null
  }
}

function contextStep(target, tools) {
  if (!tools.context) return null
  if (target.type === 'folder') {
    return 'Prefer `sem_context` when one function/class inside the reviewed files looks suspicious and you need compact, dependency-aware context instead of reading whole large files.'
  }
  return 'Prefer `sem_context` for the specific changed entity you are reasoning about. Use it before loading whole large files when you need focused context around a function, method, class, or block.'
}

function impactStep(tools) {
  if (!tools.impact) return null
  return 'Use `sem_impact` on 1-3 risky changed entities when you suspect hidden blast radius, affected tests, or cross-module consequences. Prefer `scope=tests` for test selection and `scope=all` when validating broader impact.'
}

function entitiesStep(target, tools) {
  if (!tools.entities) return null
  if (target.type === 'folder') {
    return 'Use `sem_entities` to inventory the reviewed files and pick the highest-value functions/classes/blocks before deeper inspection.'
  }
  return 'Use `sem_entities` if you need a quick structural inventory of a changed file before drilling into a suspicious entity.'
}

export function buildSemReviewGuidance(target, toolsInput) {
  const tools =
    toolsInput && typeof toolsInput === 'object' && toolsInput.any !== undefined
      ? toolsInput
      : getSemToolAvailability([])

  if (!tools.any) return null

  const steps = [
    diffStep(target, tools),
    impactStep(tools),
    contextStep(target, tools),
    entitiesStep(target, tools),
    'Always confirm final findings with raw `git diff`, `read`, or direct file inspection before citing line numbers or writing the review comment.',
    'sem may under-cover tests, assets, generated files, or non-semantic glue code. If semantic coverage looks incomplete, fall back to raw git/file inspection.',
  ].filter(Boolean)

  if (steps.length === 0) return null

  const header =
    target.type === 'folder'
      ? '## Semantic tooling for this snapshot review'
      : '## Semantic tooling for this diff review'

  return `${header}\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`
}
