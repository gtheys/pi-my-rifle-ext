// AIDEV-NOTE: PMR-JVJN — drift guard for the aven tree dependency contract.
// pi-flow tests normally assert pure prompt strings; reading the two
// engineering SKILL.md files + docs/aven-feature-flow.md from the repo root
// is deliberate NEW precedent (approved in the PMR-JVJN interview): the
// subtask→phase circularity lived in the CONTRACT between prompt.ts and the
// skills, so a per-file pin cannot catch reintroduction. These tests only
// run in-repo (skills/ and docs/ do not ship with the npm package).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { buildImplementPrompt } from '../implement/prompt.ts'

const repoRoot = join(import.meta.dirname, '../../..')
const planSkill = readFileSync(
  join(repoRoot, 'skills/engineering/feature-plan-aven/SKILL.md'),
  'utf8',
)
const implSkill = readFileSync(
  join(repoRoot, 'skills/engineering/implement-plan-aven/SKILL.md'),
  'utf8',
)
const flowDoc = readFileSync(
  join(repoRoot, 'docs/aven-feature-flow.md'),
  'utf8',
)

const contractSurfaces: ReadonlyArray<readonly [string, string]> = [
  ['feature-plan-aven', planSkill],
  ['implement-plan-aven', implSkill],
  ['docs/aven-feature-flow.md', flowDoc],
]

describe('aven tree dependency contract (PMR-JVJN)', () => {
  it('no contract surface deps a subtask on its phase', () => {
    for (const [name, text] of contractSurfaces) {
      assert.doesNotMatch(text, /dep add \$SUBTASK_REF \$PHASE_REF/, name)
      assert.doesNotMatch(text, /dep add SUB PHASE/, name)
      assert.doesNotMatch(text, /gated on its phase/, name)
      assert.doesNotMatch(text, /Subtasks depend on their phase/, name)
      for (const line of text.split('\n')) {
        if (/Subtask\s+title=/.test(line)) {
          assert.doesNotMatch(line, /depends_on/, `${name}: ${line.trim()}`)
        }
      }
    }
  })

  it('phases still chain via deps in every contract surface', () => {
    assert.match(planSkill, /Phases chain via deps/)
    assert.match(planSkill, /aven dep add \$PHASE_REF \$PREV_PHASE_REF/)
    assert.match(implSkill, /depends_on phase 1/)
    assert.match(flowDoc, /aven dep add \$PHASE_REF \$PREV_PHASE_REF/)
  })

  it('implement prompt states the prefix rule, not a blocked-check', () => {
    const p = buildImplementPrompt({
      mode: 'personal',
      ref: 'PMR-JVJN',
      route: 'plan',
    })
    assert.match(p, /subtasks carry no\s+dependencies/i)
    assert.match(p, /N\.\/N\.M title prefix/)
    assert.doesNotMatch(p, /never start a\s+subtask that is blocked/i)
    assert.doesNotMatch(p, /blocked by an open dependency/i)
  })
})
