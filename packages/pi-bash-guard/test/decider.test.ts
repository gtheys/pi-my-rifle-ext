import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { askDecider, type DeciderFetch } from '../decider.ts'

function okFetch(body: unknown): DeciderFetch {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })
}

const SAFE_BODY = {
  model: 'strands-decider-2B-qwen3.5-v1-2610',
  answers: {
    destructive: { type: 'choice', choice: 'safe', confidence: 0.91 },
  },
}

describe('askDecider', () => {
  it('parses a safe verdict with confidence', async () => {
    const verdict = await askDecider(
      'http://127.0.0.1:8000',
      'bun install',
      3000,
      okFetch(SAFE_BODY),
    )
    assert.deepEqual(verdict, { choice: 'safe', confidence: 0.91 })
  })

  it('accepts answer/value key variants tolerantly', async () => {
    for (const key of ['answer', 'value']) {
      const body = {
        answers: {
          destructive: {
            type: 'choice',
            [key]: 'destructive',
            confidence: 0.7,
          },
        },
      }
      const verdict = await askDecider('http://x', 'c', 1000, okFetch(body))
      assert.deepEqual(verdict, { choice: 'destructive', confidence: 0.7 })
    }
  })

  it('returns null on an unknown choice label', async () => {
    const verdict = await askDecider(
      'http://x',
      'c',
      1000,
      okFetch({
        answers: {
          destructive: { type: 'choice', choice: 'maybe', confidence: 0.9 },
        },
      }),
    )
    assert.equal(verdict, null)
  })

  it('returns null when confidence is missing', async () => {
    const verdict = await askDecider(
      'http://x',
      'c',
      1000,
      okFetch({ answers: { destructive: { type: 'choice', choice: 'safe' } } }),
    )
    assert.equal(verdict, null)
  })

  it('returns null on a non-200 response', async () => {
    const failing: DeciderFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })
    assert.equal(await askDecider('http://x', 'c', 1000, failing), null)
  })

  it('returns null when the request throws (unreachable)', async () => {
    const unreachable: DeciderFetch = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    assert.equal(await askDecider('http://x', 'c', 1000, unreachable), null)
  })

  it('posts to /v1/systemone with a choice question', async () => {
    let seenUrl = ''
    let seenBody = ''
    const spy: DeciderFetch = async (url, init) => {
      seenUrl = url
      seenBody = init.body
      return { ok: true, status: 200, json: async () => SAFE_BODY }
    }
    await askDecider('http://127.0.0.1:8000/', 'ls x', 3000, spy)
    assert.equal(seenUrl, 'http://127.0.0.1:8000/v1/systemone')
    const parsed = JSON.parse(seenBody) as Record<string, unknown>
    assert.equal(typeof parsed.state, 'string')
    const questions = parsed.questions as Record<string, unknown>
    const q = questions.destructive as Record<string, unknown>
    assert.equal(q.type, 'choice')
    const criteria = q.criteria as Record<string, unknown>
    assert.ok('safe' in criteria && 'destructive' in criteria)
  })
})
