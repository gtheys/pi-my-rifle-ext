import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modeForToplevel } from '../work-mode.ts'

const ROOTS = ['/home/geert/Code/salaryhero', '/work/client-x']

test('work: toplevel under a workRoot prefix', () => {
  assert.equal(
    modeForToplevel('/home/geert/Code/salaryhero/services/api', ROOTS),
    'work',
  )
})

test('work: toplevel exactly equal to a workRoot', () => {
  assert.equal(modeForToplevel('/work/client-x', ROOTS), 'work')
})

test('personal: unrelated toplevel', () => {
  assert.equal(
    modeForToplevel('/home/geert/personal/dotfiles', ROOTS),
    'personal',
  )
})

test('prefix match is path-segment aware — no /foo/barbaz vs /foo/bar', () => {
  assert.equal(
    modeForToplevel('/home/geert/Code/salaryhero-ext/repo', ROOTS),
    'personal',
  )
})

test('empty workRoots → always personal', () => {
  assert.equal(modeForToplevel('/home/geert/Code/salaryhero', []), 'personal')
})

test('workRoot with trailing slash still matches', () => {
  assert.equal(
    modeForToplevel('/work/client-x/repo', ['/work/client-x/']),
    'work',
  )
})
