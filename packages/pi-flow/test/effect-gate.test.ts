// Tests for the pure effect gate (PMR-VDVJ phase 2): merge matcher,
// one-shot interceptor, effect declaration validation, and default recipes.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildEffectDeclaration,
  DEFAULT_RECIPES,
  mergeBashBlock,
  mergeIntercept,
} from '../flow/effect-gate.ts'
import { landingIntercept } from '../flow/land-gate.ts'
import { EFFECT_KINDS } from '../run-state.ts'

describe('mergeBashBlock regex matrix', () => {
  const ref = 'PMR-VDVJ'
  const match = (command: string) => mergeBashBlock(command, ref) !== null

  it('matches plain merge with options', () => {
    assert.equal(match('git merge --ff-only main'), true)
  })
  it('matches merge after global git options', () => {
    assert.equal(match('git -C /main merge main'), true)
  })
  it('matches bare git merge', () => {
    assert.equal(match('git merge'), true)
  })
  it('does not match merge-base', () => {
    assert.equal(match('git merge-base HEAD main'), false)
  })
  it('does not match merge-file', () => {
    assert.equal(match('git merge-file a b c'), false)
  })
  it('does not match merge-tree', () => {
    assert.equal(match('git merge-tree a b'), false)
  })
  it('does not match inside quotes', () => {
    assert.equal(match('echo "git merge main"'), false)
  })
  it('does not match git push (disjoint)', () => {
    assert.equal(match('git push origin main'), false)
  })
  it('does not match gh pr create (disjoint)', () => {
    assert.equal(match('gh pr create --fill'), false)
  })
  it('matches after && separator', () => {
    assert.equal(match('bun run check && git merge --ff-only main'), true)
  })
  it('matches after ; separator', () => {
    assert.equal(match('bun run lint; git merge main'), true)
  })
  it('returns null with no active ref', () => {
    assert.equal(mergeBashBlock('git merge main', null), null)
  })
  it('names flow_land with ref and route in the block reason', () => {
    const reason = mergeBashBlock('git merge main', 'PMR-VDVJ')
    assert.ok(reason !== null)
    assert.match(reason, /flow_land/)
    assert.match(reason, /ref=PMR-VDVJ/)
    assert.match(reason, /route=merge-main/)
  })
})

describe('mergeIntercept', () => {
  const command = 'git -C /main merge --ff-only PMR-VDVJ'
  const ref = 'PMR-VDVJ'
  const authorized = { ref, command }

  it('allows any command with no active ref', () => {
    const d = mergeIntercept('git merge main', null, authorized)
    assert.deepEqual(d, { action: 'allow', clear: false })
  })
  it('allows non-merge commands without clearing', () => {
    const d = mergeIntercept('bun run check', ref, authorized)
    assert.deepEqual(d, { action: 'allow', clear: false })
  })
  it('allows the exact authorized command once and clears', () => {
    const d = mergeIntercept(command, ref, authorized)
    assert.deepEqual(d, { action: 'allow', clear: true })
  })
  it('blocks on a second call (one-shot)', () => {
    const d = mergeIntercept(command, ref, null)
    assert.equal(d.action, 'block')
  })
  it('blocks when mergeAuthorized is null', () => {
    const d = mergeIntercept(command, ref, null)
    assert.equal(d.action, 'block')
  })
  it('blocks a different branch', () => {
    const d = mergeIntercept(
      'git -C /main merge --ff-only other',
      ref,
      authorized,
    )
    assert.equal(d.action, 'block')
  })
  it('blocks a different path', () => {
    const d = mergeIntercept(
      'git -C /other merge --ff-only PMR-VDVJ',
      ref,
      authorized,
    )
    assert.equal(d.action, 'block')
  })
  it('blocks different whitespace', () => {
    const d = mergeIntercept(
      'git -C /main merge --ff-only  PMR-VDVJ',
      ref,
      authorized,
    )
    assert.equal(d.action, 'block')
  })
  it('blocks an authorized ref mismatch', () => {
    const d = mergeIntercept(command, ref, {
      ref: 'PMR-OTHER',
      command,
    })
    assert.equal(d.action, 'block')
  })
})

describe('buildEffectDeclaration', () => {
  const valid = {
    ref: 'PMR-VDVJ',
    effect: 'merge-main' as const,
    command: 'git merge --ff-only main',
    recipe: ['step one', 'step two'],
  }

  const rejectsWith = (input: unknown, pattern: RegExp) => {
    const result = buildEffectDeclaration(
      input as Parameters<typeof buildEffectDeclaration>[0],
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, pattern)
  }

  it('accepts a valid declaration with headSha', () => {
    const result = buildEffectDeclaration({
      ...valid,
      headSha: 'a'.repeat(40),
    })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.record.effect, 'merge-main')
      assert.equal(result.record.command, valid.command)
      assert.deepEqual(result.record.recipe, valid.recipe)
      assert.equal(result.record.headSha, 'a'.repeat(40))
      assert.ok(typeof result.record.at === 'string')
      assert.match(result.record.effectId, /^[0-9a-f]{12}$/)
    }
  })
  it('rejects an empty ref', () => rejectsWith({ ...valid, ref: '' }, /ref/))
  it('rejects a ref with path-escape characters', () =>
    rejectsWith({ ...valid, ref: '../evil' }, /ref/))
  it('rejects an unknown effect', () =>
    rejectsWith({ ...valid, effect: 'rm-rf' }, /effect/))
  it('rejects an empty command', () =>
    rejectsWith({ ...valid, command: '' }, /command/))
  it('rejects an empty recipe', () =>
    rejectsWith({ ...valid, recipe: [] }, /recipe/))
  it('rejects a recipe with an empty step', () =>
    rejectsWith({ ...valid, recipe: ['ok', '   '] }, /recipe/))
  it('rejects a short headSha', () =>
    rejectsWith({ ...valid, headSha: 'abc' }, /headSha/))
  it('rejects a non-hex headSha', () =>
    rejectsWith({ ...valid, headSha: `${'z'.repeat(40)}` }, /headSha/))
})

describe('DEFAULT_RECIPES', () => {
  it('has at least one non-empty step for every effect kind', () => {
    for (const kind of EFFECT_KINDS) {
      const recipe = DEFAULT_RECIPES[kind]
      assert.ok(recipe.length >= 1, `recipe for ${kind} must not be empty`)
      for (const step of recipe) {
        assert.ok(step.trim().length > 0, `empty step in recipe for ${kind}`)
      }
    }
  })
})

describe('effectDeclarationId determinism', () => {
  const base = {
    ref: 'PMR-VDVJ',
    effect: 'merge-main' as const,
    command: 'git merge --ff-only main',
    recipe: ['step'],
  }

  it('same input yields the same id', () => {
    const a = buildEffectDeclaration(base)
    const b = buildEffectDeclaration(base)
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    if (a.ok && b.ok) assert.equal(a.record.effectId, b.record.effectId)
  })
  it('changed command yields a different id', () => {
    const a = buildEffectDeclaration(base)
    const b = buildEffectDeclaration({
      ...base,
      command: 'git merge --no-ff main',
    })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    if (a.ok && b.ok) assert.notEqual(a.record.effectId, b.record.effectId)
  })
})

// --- PMR-VDVJ phase 4 additions ---

describe('mergeIntercept extra cases', () => {
  const command = 'git -C /main merge --ff-only PMR-VDVJ'
  const ref = 'PMR-VDVJ'
  const authorized = { ref, command }

  it('blocks a merge with extra flags', () => {
    const d = mergeIntercept(`${command} --no-edit`, ref, authorized)
    assert.equal(d.action, 'block')
  })
  it('never triggers on git merge-base', () => {
    const d = mergeIntercept('git merge-base HEAD main', ref, null)
    assert.deepEqual(d, { action: 'allow', clear: false })
  })
})

// PMR-VZEV regression, shared state shape: a push allow clears authorized +
// humanReviewPassed (the push one-shot) and does NOT clear mergeAuthorized;
// a merge allow clears ONLY mergeAuthorized (authorized stays cleared).
describe('PMR-VZEV: push and merge one-shots are independent', () => {
  const ref = 'PMR-ABC1'
  const mergeCommand = "git -C '/repo' merge --ff-only flow-branch"

  it('a push allow clears authorized + humanReviewPassed but keeps mergeAuthorized', () => {
    const state = {
      authorized: ref as string | null,
      humanReviewPassed: ref as string | null,
      mergeAuthorized: { ref, command: mergeCommand } as {
        ref: string
        command: string
      } | null,
    }
    const push = landingIntercept(
      'git push origin flow-branch',
      ref,
      state.authorized,
    )
    assert.deepEqual(push, { action: 'allow', clear: true })
    if (push.action === 'allow' && push.clear) {
      state.authorized = null
      state.humanReviewPassed = null
    }
    assert.equal(state.authorized, null)
    assert.equal(state.humanReviewPassed, null)
    assert.deepEqual(state.mergeAuthorized, { ref, command: mergeCommand })
    // The merge authorization survives and still allows the exact command.
    const merge = mergeIntercept(mergeCommand, ref, state.mergeAuthorized)
    assert.deepEqual(merge, { action: 'allow', clear: true })
  })

  it('a merge allow clears only mergeAuthorized — authorized stays as-is', () => {
    const state = {
      authorized: ref as string | null,
      humanReviewPassed: ref as string | null,
      mergeAuthorized: { ref, command: mergeCommand } as {
        ref: string
        command: string
      } | null,
    }
    const merge = mergeIntercept(mergeCommand, ref, state.mergeAuthorized)
    assert.deepEqual(merge, { action: 'allow', clear: true })
    if (merge.action === 'allow' && merge.clear) {
      state.mergeAuthorized = null
    }
    assert.equal(state.mergeAuthorized, null)
    assert.equal(state.authorized, ref)
    assert.equal(state.humanReviewPassed, ref)
    // One-shot: the second identical merge re-blocks.
    const second = mergeIntercept(mergeCommand, ref, state.mergeAuthorized)
    assert.equal(second.action, 'block')
  })
})
