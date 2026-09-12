import { describe, expect, test } from 'bun:test'
import { stripPrimer } from './index.ts'

describe('stripPrimer', () => {
  test('keeps only the live workspace tail', () => {
    const prime = [
      '# Aven CLI Primer',
      '',
      'static primer lines...',
      '',
      '## Local Conventions',
      '',
      'Project: app',
      '### Active',
      'APP-1 status=active title="x"',
    ].join('\n')
    const result = stripPrimer(prime)
    expect(result.startsWith('## Local Conventions')).toBe(true)
    expect(result).toContain('APP-1')
    expect(result).not.toContain('Aven CLI Primer')
  })

  test('returns empty string when the marker is missing', () => {
    expect(stripPrimer('# Aven CLI Primer\n\nstatic only')).toBe('')
    expect(stripPrimer('')).toBe('')
  })
})
