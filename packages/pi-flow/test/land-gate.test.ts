// Tests for the landing gate (PMR-06RH): pure decisions consumed by the
// flow_land tool and the bash tool_call interceptor.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  landDecision,
  landingBashBlock,
  landingIntercept,
} from '../flow/land-gate.ts'
import { createLandingState, registerLandTool } from '../tools/land.ts'

type LandExecute = (
  toolCallId: string,
  params: { ref: string; route: 'pr' | 'merge-main'; artifact?: string },
) => Promise<{
  content: { type: string; text: string }[]
  isError?: boolean
}>

describe('landDecision', () => {
  it('refuses without the review-passed label', () => {
    const d = landDecision(['planned', 'active'], null)
    assert.equal(d.ok, false)
    if (!d.ok) assert.match(d.reason, /review-passed/)
  })

  it('refuses on unreadable labels', () => {
    const d = landDecision(null, null)
    assert.equal(d.ok, false)
  })

  it('allows with review-passed label and no artifact', () => {
    assert.deepEqual(landDecision(['review-passed'], null), { ok: true })
  })

  it('allows with a clean review artifact', () => {
    const d = landDecision(['review-passed'], 'notes\nblockers_count: 0\n')
    assert.deepEqual(d, { ok: true })
  })

  it('refuses when the artifact reports blockers', () => {
    const d = landDecision(
      ['review-passed'],
      'blockers_count: 2\n- blocker: a\n- blocker: b\n',
    )
    assert.equal(d.ok, false)
    if (!d.ok) assert.match(d.reason, /2/)
  })

  it('refuses a malformed artifact instead of treating it as clean', () => {
    const d = landDecision(['review-passed'], 'looks fine to me')
    assert.equal(d.ok, false)
    if (!d.ok) assert.match(d.reason, /blockers_count/)
  })
})

describe('landingBashBlock', () => {
  it('blocks git push while a flow ref is active', () => {
    const reason = landingBashBlock('git push origin feat/x', 'PMR-ABC1')
    assert.ok(reason !== null)
    assert.match(reason, /flow_land/)
    assert.match(reason, /PMR-ABC1/)
  })

  it('blocks gh pr create while a flow ref is active', () => {
    const reason = landingBashBlock('gh pr create --title x', 'PMR-ABC1')
    assert.ok(reason !== null)
    assert.match(reason, /flow_land/)
  })

  it('allows normal git use when no flow ref is active', () => {
    assert.equal(landingBashBlock('git push origin feat/x', null), null)
    assert.equal(landingBashBlock('gh pr create', null), null)
  })

  it('allows non-landing commands even with an active ref', () => {
    assert.equal(landingBashBlock('git status', 'PMR-ABC1'), null)
    assert.equal(landingBashBlock('git commit -m x', 'PMR-ABC1'), null)
    assert.equal(landingBashBlock('gh pr view 12', 'PMR-ABC1'), null)
  })

  it('blocks flag-tolerant and chained landing forms (PMR-4Y1Z)', () => {
    const blocked = [
      'git -C /tmp/wt push origin x',
      'git -c user.name=x push',
      'git --git-dir /a/.git push',
      'git --no-pager push --force',
      'git status || git push',
      'make test | git push',
      'git add . & git push',
      'echo hi\ngit push',
      '(cd x && git push)',
      'echo $(git push)',
      'FOO=1 git push',
      'gh -R org/repo pr create --title x',
      'true && gh --repo org/repo pr create',
    ]
    for (const command of blocked) {
      assert.ok(
        landingBashBlock(command, 'PMR-ABC1') !== null,
        `expected block: ${command}`,
      )
    }
  })

  it('does not false-positive on quoted or unrelated text (PMR-4Y1Z)', () => {
    const allowed = [
      'echo "git push"',
      'git log --grep push',
      'git -C /tmp/wt status',
      'grep -r "gh pr create" docs',
      'git stash push',
    ]
    for (const command of allowed) {
      assert.equal(
        landingBashBlock(command, 'PMR-ABC1'),
        null,
        `expected allow: ${command}`,
      )
    }
  })

  it('does not match git pushd-like words', () => {
    assert.equal(landingBashBlock('echo git push', 'PMR-ABC1'), null)
  })
})

// --- PMR-VZEV: landingIntercept (pure interceptor decision) ---
describe('landingIntercept', () => {
  it('allows everything when no flow ref is active', () => {
    assert.deepEqual(landingIntercept('git push origin x', null, 'PMR-ABC1'), {
      action: 'allow',
      clear: false,
    })
    assert.deepEqual(landingIntercept('git push origin x', null, null), {
      action: 'allow',
      clear: false,
    })
  })

  it('blocks a landing command when the ref is not authorized', () => {
    const d = landingIntercept('git push origin x', 'PMR-ABC1', null)
    assert.equal(d.action, 'block')
    if (d.action === 'block') assert.match(d.reason, /flow_land/)
  })

  it('allows a landing command when authorized and asks for a clear', () => {
    assert.deepEqual(
      landingIntercept('git push origin x', 'PMR-ABC1', 'PMR-ABC1'),
      {
        action: 'allow',
        clear: true,
      },
    )
  })

  it('does not clear for non-landing commands even when authorized', () => {
    assert.deepEqual(landingIntercept('git status', 'PMR-ABC1', 'PMR-ABC1'), {
      action: 'allow',
      clear: false,
    })
  })
})

// PMR-VZEV clear-after-use: one authorization = one landing command. The
// second push after the state was cleared is blocked again.
describe('landingState clear-after-use (interceptor sequence)', () => {
  it('clears after the first allowed push and re-blocks the second', () => {
    const state = createLandingState()
    state.authorized = 'PMR-ABC1'
    state.humanReviewPassed = 'PMR-ABC1'
    const first = landingIntercept(
      'git push origin main',
      'PMR-ABC1',
      state.authorized,
    )
    assert.deepEqual(first, { action: 'allow', clear: true })
    if (first.action === 'allow' && first.clear) {
      state.authorized = null
      state.humanReviewPassed = null
    }
    const second = landingIntercept(
      'git push origin main',
      'PMR-ABC1',
      state.authorized,
    )
    assert.equal(second.action, 'block')
    assert.equal(state.humanReviewPassed, null)
  })
})

// --- PMR-VZEV: flow_land ref validation against loop.activeRef() ---
describe('flow_land ref validation', () => {
  const BIN_DIR = mkdtempSync(path.join(os.tmpdir(), 'pi-flow-refgate-bin-'))
  writeFileSync(
    path.join(BIN_DIR, 'aven'),
    `#!/bin/sh\necho '{"ref":"PMR-ABC1","labels":["review-passed"]}'\n`,
  )
  chmodSync(path.join(BIN_DIR, 'aven'), 0o755)

  function executeWithActiveRef(activeRef: string | null) {
    let execute: LandExecute | undefined
    const mockPi = {
      registerTool: (options: { execute: LandExecute }) => {
        execute = options.execute
      },
    }
    registerLandTool(
      mockPi as unknown as Parameters<typeof registerLandTool>[0],
      createLandingState(),
      () => activeRef,
      async () => ({ ok: true, summary: 'ok' }),
    )
    if (!execute) throw new Error('flow_land tool not registered')
    return execute
  }

  async function withFakeAven(fn: () => Promise<void>): Promise<void> {
    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${BIN_DIR}:${previousPath}`
    try {
      await fn()
    } finally {
      process.env.PATH = previousPath
    }
  }

  it('refuses when the ref does not match the active flow ref', async () => {
    const execute = executeWithActiveRef('PMR-OTHER')
    const result = await execute('r1', { ref: 'PMR-ABC1', route: 'pr' })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /does not match/)
  })

  it('allows when the ref matches the active flow ref', async () => {
    const execute = executeWithActiveRef('PMR-ABC1')
    await withFakeAven(async () => {
      const result = await execute('r2', { ref: 'PMR-ABC1', route: 'pr' })
      assert.equal(result.isError, undefined)
      assert.match(result.content[0].text, /authorized/)
    })
  })

  it('allows when no flow is active (hand-run landing outside a flow)', async () => {
    const execute = executeWithActiveRef(null)
    await withFakeAven(async () => {
      const result = await execute('r3', { ref: 'PMR-ABC1', route: 'pr' })
      assert.equal(result.isError, undefined)
      assert.match(result.content[0].text, /authorized/)
    })
  })
})
