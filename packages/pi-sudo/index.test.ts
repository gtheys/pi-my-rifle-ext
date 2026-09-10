import { describe, expect, test } from 'bun:test'
import {
  buildSudoShellCommand,
  detectAuthFailure,
  filterSudoPrompt,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  truncate,
} from './index.ts'

describe('truncate', () => {
  test('short text passes through unchanged', () => {
    expect(truncate('hello\nworld')).toEqual({
      text: 'hello\nworld',
      truncated: false,
    })
  })

  test('one-over line limit truncates', () => {
    const text = Array.from(
      { length: MAX_OUTPUT_LINES + 1 },
      (_, i) => `line ${i}`,
    ).join('\n')
    const result = truncate(text)
    expect(result.truncated).toBe(true)
    expect(result.text.split('\n')).toHaveLength(MAX_OUTPUT_LINES)
  })

  test('byte limit truncates independently of line count', () => {
    const bigLine = 'x'.repeat(20 * 1024)
    const text = [bigLine, bigLine, bigLine, bigLine].join('\n')
    const result = truncate(text)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES,
    )
  })

  test('empty string passes through', () => {
    expect(truncate('')).toEqual({ text: '', truncated: false })
  })
})

describe('filterSudoPrompt', () => {
  test('strips the sudo password prompt line', () => {
    const raw = '[sudo] password for alice:\ncommand output here'
    expect(filterSudoPrompt(raw)).not.toContain('[sudo] password')
    expect(filterSudoPrompt(raw)).toContain('command output here')
  })

  test('leaves unrelated stderr untouched', () => {
    const raw = 'real error: file not found'
    expect(filterSudoPrompt(raw)).toBe(raw)
  })
})

describe('detectAuthFailure', () => {
  test('code 0 is never an auth failure', () => {
    expect(detectAuthFailure(0, 'incorrect password')).toBe(false)
  })

  test('detects incorrect password / auth failure / sorry messages', () => {
    expect(detectAuthFailure(1, 'sudo: incorrect password')).toBe(true)
    expect(detectAuthFailure(1, 'pam: authentication failure')).toBe(true)
    expect(detectAuthFailure(1, 'Sorry, try again.')).toBe(true)
  })

  test('unrelated non-zero exit is not an auth failure', () => {
    expect(detectAuthFailure(127, 'command not found')).toBe(false)
  })
})

describe('buildSudoShellCommand', () => {
  // Regression: without the stdin redirect, an unconsumed password line
  // (sudo cached creds → no prompt) is inherited by the command and can be
  // echoed into stdout → tool result → model context.
  test('detaches command stdin from the password pipe', () => {
    expect(buildSudoShellCommand('pacman -Syu')).toBe(
      'exec </dev/null; pacman -Syu',
    )
  })
})
