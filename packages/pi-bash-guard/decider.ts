// AIDEV-NOTE: strands-decider HTTP client (POST /v1/systemone — the server
// `strands-decider serve <model>` exposes on 127.0.0.1, no auth). One choice
// question per command; every failure mode (network, timeout, non-200,
// unparseable body) returns null so classify.deciderOutcome() can fail closed
// into a human confirmation. fetch is injectable so tests need no server.
export type DeciderVerdict = {
  choice: 'safe' | 'destructive'
  confidence: number
} | null

export type DeciderFetch = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

export const DECIDER_PATH = '/v1/systemone'

const STATE_PREFIX = 'A coding agent wants to run this shell command:\n\n'

// criteria keys are the answer vocabulary ('safe' / 'destructive'); keep them
// in sync with parseDeciderAnswer below.
function buildRequestBody(command: string): string {
  return JSON.stringify({
    state: `${STATE_PREFIX}${command}`,
    questions: {
      destructive: {
        type: 'choice',
        instructions:
          'Should a human approve this command before it runs, or is it safe to run without approval?',
        criteria: {
          safe: 'read-only or trivially reversible: listing, reading, searching, git status/diff/log, tests, builds',
          destructive:
            'deletes or overwrites data, force operations, mutates system or global state, network side effects, installs software, or is hard to undo',
        },
      },
    },
  })
}

// AIDEV-NOTE: the /v1/systemone answer body is not pinned by a schema doc the
// package can rely on, so the parser accepts the shapes seen in the strands
// decider examples (choice/answer/value carrying a criteria key) and rejects
// everything else to null. A tolerance, not a contract.
function parseDeciderAnswer(body: unknown): DeciderVerdict {
  if (typeof body !== 'object' || body === null) return null
  const root = body as Record<string, unknown>
  const answers = root.answers
  if (typeof answers !== 'object' || answers === null) return null
  const entry = (answers as Record<string, unknown>).destructive
  if (typeof entry !== 'object' || entry === null) return null
  const record = entry as Record<string, unknown>
  let raw: string | null = null
  if (typeof record.choice === 'string') {
    raw = record.choice
  } else if (typeof record.answer === 'string') {
    raw = record.answer
  } else if (typeof record.value === 'string') {
    raw = record.value
  }
  if (raw !== 'safe' && raw !== 'destructive') return null
  const confidence = record.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return null
  }
  return { choice: raw, confidence }
}

export async function askDecider(
  baseUrl: string,
  command: string,
  timeoutMs: number,
  fetchImpl: DeciderFetch,
): Promise<DeciderVerdict> {
  const url = `${baseUrl.replace(/\/+$/, '')}${DECIDER_PATH}`
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: buildRequestBody(command),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    return parseDeciderAnswer(await response.json())
  } catch {
    return null
  }
}
