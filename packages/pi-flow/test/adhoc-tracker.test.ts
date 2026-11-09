import { describe, expect, test } from 'bun:test'
import {
  adhocRunId,
  buildAdhocBody,
  createAdhocTracker,
} from '../adhoc/tracker.ts'

function session(entries: Array<{ at: string; cost: number }>): string {
  return entries
    .map((e) =>
      JSON.stringify({
        type: 'message',
        timestamp: e.at,
        message: {
          role: 'assistant',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: e.cost,
            },
          },
        },
      }),
    )
    .join('\n')
}

function harness(opts: { flow?: boolean } = {}) {
  const files = new Map<string, string>()
  const pushes: Array<{ id: string; body: string }> = []
  let clock = Date.parse('2026-11-09T10:00:00Z')
  const tracker = createAdhocTracker({
    now: () => clock,
    getSessionFile: () => '/main.jsonl',
    readSession: (f) => files.get(f) ?? null,
    push: async (id, body) => {
      pushes.push({ id, body })
    },
    flowActive: () => opts.flow === true,
  })
  return {
    tracker,
    files,
    pushes,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('adhoc tracker', () => {
  test('run id is a stable slug', () => {
    expect(
      adhocRunId('review', 'PR 1234: x/y', Date.parse('2026-11-09T10:05:00Z')),
    ).toBe('review-pr-1234-x-y-20261109T1005')
  })

  test('main-session run counts only usage inside its window and reports duration', async () => {
    const h = harness()
    h.files.set(
      '/main.jsonl',
      session([
        { at: '2026-11-09T09:59:00Z', cost: 5 }, // before the command: ignored
        { at: '2026-11-09T10:00:30Z', cost: 0.25 },
        { at: '2026-11-09T10:02:00Z', cost: 0.5 },
        { at: '2026-11-09T10:09:00Z', cost: 7 }, // after the last settle: ignored
      ]),
    )
    h.tracker.beginMain('pr-quality', 'PR 1', true)
    h.advance(180_000)
    await h.tracker.settled()
    const last = h.pushes[h.pushes.length - 1]
    expect(last.body).toContain(
      'pi_flow_adhoc_duration_seconds{run="pr-quality-pr-1-20261109T1000",kind="pr-quality",target="PR 1"} 180',
    )
    expect(last.body).toContain('role="main",session="main"} 0.75')
  })

  test('single-turn run closes after the first settle, conversation run stays open', async () => {
    const h = harness()
    h.tracker.beginMain('pr-quality', 'PR 1', true)
    await h.tracker.settled()
    const before = h.pushes.length
    await h.tracker.settled()
    expect(h.pushes.length).toBe(before)

    h.tracker.beginMain('brainstorm', 'topic', false)
    await h.tracker.settled()
    const mid = h.pushes.length
    await h.tracker.settled()
    expect(h.pushes.length).toBe(mid + 1)
  })

  test('worker run adds the subagent session cost and no main cost', async () => {
    const h = harness()
    h.files.set(
      '/rev.jsonl',
      session([{ at: '2026-11-09T10:01:00Z', cost: 0.4 }]),
    )
    h.files.set(
      '/main.jsonl',
      session([{ at: '2026-11-09T10:01:00Z', cost: 9 }]),
    )
    const run = h.tracker.beginWorker('review', 'PR 2')
    h.tracker.addWorker(run, { sessionFile: '/rev.jsonl', role: 'review' })
    h.advance(60_000)
    await h.tracker.finish(run)
    const body = h.pushes[h.pushes.length - 1].body
    expect(body).toContain('role="review",session="review-1"} 0.4')
    expect(body).not.toContain('role="main"')
  })

  test('nothing is tracked while a flow is active', async () => {
    const h = harness({ flow: true })
    expect(h.tracker.beginMain('brainstorm', 't', false)).toBeNull()
    expect(h.tracker.beginWorker('review', 't')).toBeNull()
    await h.tracker.settled()
    expect(h.pushes).toHaveLength(0)
  })

  test('unreadable sessions add no cost row but keep the duration', () => {
    const body = buildAdhocBody(
      {
        id: 'r',
        kind: 'review',
        target: 't',
        startMs: 0,
        endMs: 5000,
        mainSessionFile: '/gone',
        workers: [{ sessionFile: '/gone2', role: 'review' }],
      },
      () => null,
    )
    expect(body).toContain(
      'pi_flow_adhoc_duration_seconds{run="r",kind="review",target="t"} 5',
    )
    expect(body).not.toContain('pi_flow_adhoc_cost_usd')
  })
})

describe('adhoc tracker trace hooks', () => {
  function traced() {
    const events: string[] = []
    const tracker = createAdhocTracker({
      now: () => Date.parse('2026-11-09T10:00:00Z'),
      getSessionFile: () => null,
      readSession: () => null,
      push: async () => {},
      flowActive: () => false,
      trace: {
        begin: (run, nest) => events.push(`begin ${run.kind} ${nest}`),
        end: (run, attrs) =>
          events.push(`end ${run.kind} ${attrs['adhoc.run'] === run.id}`),
      },
    })
    return { tracker, events }
  }

  test('single-turn run: begin, then one end on first settle', async () => {
    const { tracker, events } = traced()
    tracker.beginMain('pr-quality', 'PR 1', true)
    await tracker.settled()
    await tracker.settled()
    expect(events).toEqual(['begin pr-quality true', 'end pr-quality true'])
  })

  test('conversation run ends once, when the next run replaces it', async () => {
    const { tracker, events } = traced()
    tracker.beginMain('brainstorm', 't', false)
    await tracker.settled()
    tracker.beginMain('pr-quality', 'PR 2', true)
    expect(events).toEqual([
      'begin brainstorm true',
      'end brainstorm true',
      'begin pr-quality true',
    ])
  })

  test('worker run: marker without nesting, then end', async () => {
    const { tracker, events } = traced()
    const run = tracker.beginWorker('review', 'PR 3')
    await tracker.finish(run)
    expect(events).toEqual(['begin review false', 'end review true'])
  })
})
