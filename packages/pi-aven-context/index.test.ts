import { describe, expect, test } from 'bun:test'
import { maybeInjectAvenContext, stripPrimer } from './index.ts'

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

// AIDEV-NOTE: pins the branch-entry shape contract that index.ts's dedup
// predicate relies on: getBranch() entries look like
// { type: 'custom_message', customType: 'aven-context' }.
describe('branch entry shape contract', () => {
  test('dedup predicate matches a wired getBranch aven-context entry', () => {
    const entry = {
      type: 'custom_message',
      customType: 'aven-context',
    } as unknown
    const predicate = (e: unknown) => {
      if (typeof e !== 'object' || e === null) return false
      const rec = e as Record<string, unknown>
      return rec.type === 'custom_message' && rec.customType === 'aven-context'
    }
    expect(predicate(entry)).toBe(true)
    expect(predicate({ type: 'custom_message', customType: 'other' })).toBe(
      false,
    )
    expect(predicate({ type: 'message' })).toBe(false)
  })
})

describe('maybeInjectAvenContext', () => {
  const marker = '## Local Conventions'
  const tail = `${marker}\n\nProject: app\nAPP-1 status=active`
  const primeOutput = `# Aven CLI Primer\nstatic stuff\n\n${tail}`

  test('child session skips: no prime run, no send, returns false', async () => {
    let primeRuns = 0
    let sends = 0
    const result = await maybeInjectAvenContext({
      env: { PI_SUBAGENT_ID: 'worker-1' },
      runPrime: async () => {
        primeRuns++
        return primeOutput
      },
      branchHasAvenContext: () => false,
      sendCustomMessage: () => {
        sends++
      },
    })
    expect(result).toBe(false)
    expect(primeRuns).toBe(0)
    expect(sends).toBe(0)
  })

  test('parent with existing aven-context entry dedups: no send', async () => {
    let primeRuns = 0
    let sends = 0
    const result = await maybeInjectAvenContext({
      env: {},
      runPrime: async () => {
        primeRuns++
        return primeOutput
      },
      branchHasAvenContext: () => true,
      sendCustomMessage: () => {
        sends++
      },
    })
    expect(result).toBe(false)
    expect(primeRuns).toBe(0)
    expect(sends).toBe(0)
  })

  test('parent happy path: one send with primer-stripped content', async () => {
    const sent: string[] = []
    const result = await maybeInjectAvenContext({
      env: {},
      runPrime: async () => primeOutput,
      branchHasAvenContext: () => false,
      sendCustomMessage: (content) => {
        sent.push(content)
      },
    })
    expect(result).toBe(true)
    expect(sent.length).toBe(1)
    expect(
      sent[0].startsWith('Aven workspace state (live, from `aven prime`):'),
    ).toBe(true)
    expect(sent[0]).toContain(tail)
    expect(sent[0]).not.toContain('Aven CLI Primer')
  })

  test('prime rejection fails closed: no send, returns false', async () => {
    let sends = 0
    const result = await maybeInjectAvenContext({
      env: {},
      runPrime: async () => {
        throw new Error('aven: command not found')
      },
      branchHasAvenContext: () => false,
      sendCustomMessage: () => {
        sends++
      },
    })
    expect(result).toBe(false)
    expect(sends).toBe(0)
  })

  test('marker-less prime output fails closed: no send, returns false', async () => {
    let sends = 0
    const result = await maybeInjectAvenContext({
      env: {},
      runPrime: async () => '# Aven CLI Primer\n\nstatic only, no marker',
      branchHasAvenContext: () => false,
      sendCustomMessage: () => {
        sends++
      },
    })
    expect(result).toBe(false)
    expect(sends).toBe(0)
  })
})
