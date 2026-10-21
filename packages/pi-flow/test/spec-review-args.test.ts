import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSpecReviewArgs } from '../spec-review/args.ts'

test('parseSpecReviewArgs: bare invocation -> ok without workspace', () => {
  assert.deepEqual(parseSpecReviewArgs(''), { kind: 'ok' })
  assert.deepEqual(parseSpecReviewArgs('   '), { kind: 'ok' })
})

test('parseSpecReviewArgs: help -> help', () => {
  assert.deepEqual(parseSpecReviewArgs('help'), { kind: 'help' })
})

test('parseSpecReviewArgs: --workspace <name> -> ok with workspace', () => {
  assert.deepEqual(parseSpecReviewArgs('--workspace personal'), {
    kind: 'ok',
    workspace: 'personal',
  })
})

test('parseSpecReviewArgs: --workspace without value -> help', () => {
  assert.deepEqual(parseSpecReviewArgs('--workspace'), { kind: 'help' })
})

test('parseSpecReviewArgs: unknown arg -> help', () => {
  assert.deepEqual(parseSpecReviewArgs('--bogus'), { kind: 'help' })
  assert.deepEqual(parseSpecReviewArgs('PMR-YWY0'), { kind: 'help' })
})
