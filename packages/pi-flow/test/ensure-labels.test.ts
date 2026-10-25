import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyLabelFailure } from '../flow/ensure-labels.ts'

describe('classifyLabelFailure', () => {
  it('classifies spawn ENOENT as aven-missing', () => {
    const error = Object.assign(new Error('spawn aven ENOENT'), {
      code: 'ENOENT',
    })
    const failure = classifyLabelFailure(error)
    assert.equal(failure.kind, 'aven-missing')
  })

  it('classifies aven already-exists stderr as already-exists', () => {
    const error = Object.assign(new Error('command failed'), {
      stderr: 'error label-already-exists: label "rpi" already exists',
    })
    const failure = classifyLabelFailure(error)
    assert.equal(failure.kind, 'already-exists')
  })

  it('classifies other stderr failures as other with detail', () => {
    const error = Object.assign(new Error('command failed'), {
      stderr: 'error db-locked: try again',
    })
    const failure = classifyLabelFailure(error)
    assert.equal(failure.kind, 'other')
    assert.equal(failure.detail, 'error db-locked: try again')
  })

  it('falls back to error message when no stderr', () => {
    const failure = classifyLabelFailure(new Error('aven timed out'))
    assert.equal(failure.kind, 'other')
    assert.equal(failure.detail, 'aven timed out')
  })

  it('handles non-Error throwables', () => {
    const failure = classifyLabelFailure('boom')
    assert.equal(failure.kind, 'other')
    assert.equal(failure.detail, 'boom')
  })
})
