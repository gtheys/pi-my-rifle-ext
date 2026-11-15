// PMR-R5VB subtask 1.3 — parser + orchestration for `/flow answer <ref> <choice>`.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AnswerChoice } from '../aven/client.ts'
import {
  type AnswerDeps,
  answerUsageText,
  executeFlowAnswer,
  parseFlowAnswerArgs,
} from '../flow/answer.ts'
import { clearAvenPrefixes, registerAvenPrefixes } from '../flow/ref-kind.ts'

describe('parseFlowAnswerArgs', () => {
  it('returns not-answer when the leading token is not answer', () => {
    assert.deepEqual(parseFlowAnswerArgs('PMR-ZTVG approve'), {
      kind: 'not-answer',
    })
    assert.deepEqual(parseFlowAnswerArgs(''), { kind: 'not-answer' })
    assert.deepEqual(parseFlowAnswerArgs('answerish PMR-ZTVG approve'), {
      kind: 'not-answer',
    })
  })

  it('returns help on bare answer', () => {
    assert.deepEqual(parseFlowAnswerArgs('answer'), { kind: 'answer-help' })
  })

  it('parses a happy aven ref + choice', () => {
    assert.deepEqual(parseFlowAnswerArgs('answer PMR-ZTVG approve'), {
      kind: 'answer',
      ref: 'PMR-ZTVG',
      choice: 'approve',
    })
    assert.deepEqual(parseFlowAnswerArgs('answer aven:PMR-ZTVG fail'), {
      kind: 'answer',
      ref: 'PMR-ZTVG',
      choice: 'fail',
    })
  })

  it('returns help on 2 parts', () => {
    assert.deepEqual(parseFlowAnswerArgs('answer PMR-ZTVG'), {
      kind: 'answer-help',
    })
  })

  it('returns help on 4 parts', () => {
    assert.deepEqual(parseFlowAnswerArgs('answer PMR-ZTVG approve extra'), {
      kind: 'answer-help',
    })
  })

  it('returns help on a bad choice', () => {
    assert.deepEqual(parseFlowAnswerArgs('answer PMR-ZTVG maybe'), {
      kind: 'answer-help',
    })
  })

  it('returns help on a jira-shaped ref', () => {
    clearAvenPrefixes()
    assert.deepEqual(parseFlowAnswerArgs('answer DP-71 approve'), {
      kind: 'answer-help',
    })
  })

  it('accepts a jira-shaped bare ref registered as an aven prefix', () => {
    registerAvenPrefixes(['PMR'])
    assert.deepEqual(parseFlowAnswerArgs('answer PMR-2424 pass'), {
      kind: 'answer',
      ref: 'PMR-2424',
      choice: 'pass',
    })
    clearAvenPrefixes()
  })
})

describe('answerUsageText', () => {
  it('mentions both gates and all four choices', () => {
    for (const needle of [
      'spec',
      'review',
      'approve',
      'reject',
      'pass',
      'fail',
    ]) {
      assert.ok(
        answerUsageText.includes(needle),
        `usage text should include ${needle}`,
      )
    }
  })
})

// --- orchestration (executeFlowAnswer) ---

function makeDeps(overrides: Partial<AnswerDeps> = {}): {
  deps: AnswerDeps
  notes: string[]
  journal: unknown[]
} {
  const notes: string[] = []
  const journal: unknown[] = []
  const deps: AnswerDeps = {
    notify(msg, _level) {
      notes.push(msg)
    },
    async writeGateAnswer() {
      return true
    },
    async writeAvenNote() {
      return true
    },
    async appendJournal(event) {
      journal.push(event)
    },
    now: () => '2026-11-15T00:00:00Z',
    ...overrides,
  }
  return { deps, notes, journal }
}

describe('executeFlowAnswer', () => {
  const cases: Array<{
    choice: AnswerChoice
    gate: 'spec' | 'review'
    journalGate: 'spec-review' | 'code-review'
  }> = [
    { choice: 'approve', gate: 'spec', journalGate: 'spec-review' },
    { choice: 'reject', gate: 'spec', journalGate: 'spec-review' },
    { choice: 'pass', gate: 'review', journalGate: 'code-review' },
    { choice: 'fail', gate: 'review', journalGate: 'code-review' },
  ]

  for (const { choice, gate, journalGate } of cases) {
    it(`maps ${choice} → gate ${gate} / journal ${journalGate} and records everything`, async () => {
      const { deps, notes, journal } = makeDeps()
      await executeFlowAnswer({ ref: 'PMR-ZTVG', choice }, deps)
      assert.equal(journal.length, 1)
      assert.deepEqual(journal[0], {
        kind: 'gate-answer',
        at: '2026-11-15T00:00:00Z',
        ref: 'PMR-ZTVG',
        gate: journalGate,
        choice,
      })
      assert.equal(notes.length, 1)
      assert.match(
        notes[0] ?? '',
        new RegExp(`PMR-ZTVG ${gate}=${choice} recorded`),
      )
    })
  }

  it('metadata failure → error notify, nothing else attempted', async () => {
    let noteCalled = false
    const { deps, notes, journal } = makeDeps({
      async writeGateAnswer() {
        return false
      },
      async writeAvenNote() {
        noteCalled = true
        return true
      },
    })
    await executeFlowAnswer({ ref: 'PMR-ZTVG', choice: 'approve' }, deps)
    assert.equal(noteCalled, false)
    assert.equal(journal.length, 0)
    assert.equal(notes.length, 1)
    assert.match(notes[0] ?? '', /flow answer NOT recorded: PMR-ZTVG approve/)
  })

  it('note failure → warning notify, journal still attempted, info still sent', async () => {
    const levels: string[] = []
    const { deps, journal } = makeDeps({
      async writeAvenNote() {
        return false
      },
      notify(_msg, level) {
        levels.push(level)
      },
    })
    await executeFlowAnswer({ ref: 'PMR-ZTVG', choice: 'pass' }, deps)
    assert.equal(journal.length, 1)
    assert.deepEqual(levels, ['warning', 'info'])
  })

  it('appendJournal throwing is swallowed and info notify still sent', async () => {
    const { deps, notes } = makeDeps({
      async appendJournal() {
        throw new Error('disk full')
      },
    })
    await executeFlowAnswer({ ref: 'PMR-ZTVG', choice: 'fail' }, deps)
    assert.equal(notes.length, 1)
    assert.match(notes[0] ?? '', /recorded/)
  })

  it('module source contains no sendUserMessage and no pi import (no model turn, PMR-R5VB)', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../flow/answer.ts', import.meta.url)),
      'utf8',
    )
    assert.ok(!source.includes('sendUserMessage'))
    assert.ok(!/from ['"]@earendil-works\/pi-coding-agent['"]/.test(source))
  })
})
