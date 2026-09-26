/**
 * find_or_create_epic tool \u2014 pull-in a Jira-synced ticket as a local epic,
 * or return an existing local epic ref unchanged.
 *
 * AIDEV-NOTE: idempotent by construction \u2014 aven show <input> succeeding
 * short-circuits before any write, and the jira-ref metadata lookup
 * short-circuits the create-epic path on a second run for the same key.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import {
  avenAdd,
  avenDepAdd,
  avenListByMetadata,
  avenShowJson,
} from '../shared/aven.ts'

const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/

export interface FindOrCreateEpicResult {
  epicRef: string
  syncedRef: string
  created: boolean
}

/** Defensive string field pick \u2014 unknown/non-string yields ''. */
function pickString(record: unknown, field: string): string {
  if (typeof record !== 'object' || record === null) {
    return ''
  }
  const value = (record as Record<string, unknown>)[field]
  if (typeof value === 'string') {
    return value
  }
  return ''
}

function pickBool(record: unknown, field: string): boolean {
  if (typeof record !== 'object' || record === null) {
    return false
  }
  return (record as Record<string, unknown>)[field] === true
}

export async function findOrCreateEpic(
  pi: ExtensionAPI,
  input: string,
  cwd: string,
): Promise<FindOrCreateEpicResult> {
  const existing = await avenShowJson(pi, input, cwd)
  if (existing !== null) {
    return { epicRef: input, syncedRef: '', created: false }
  }

  if (!JIRA_KEY_PATTERN.test(input)) {
    throw new Error(
      `find_or_create_epic: "${input}" is not a known ticket ref or Jira key`,
    )
  }

  const epicCandidates = await avenListByMetadata(pi, 'jira-ref', input, cwd)
  const existingEpic = epicCandidates.find((item) => pickBool(item, 'is_epic'))
  if (existingEpic !== undefined) {
    return {
      epicRef: pickString(existingEpic, 'ref'),
      syncedRef: '',
      created: false,
    }
  }

  const syncedCandidates = await avenListByMetadata(pi, 'jira-key', input, cwd)
  const syncedTicket = syncedCandidates.find(
    (item) => !pickBool(item, 'is_epic'),
  )
  if (syncedTicket === undefined) {
    throw new Error(
      `find_or_create_epic: no synced ticket found for Jira key "${input}"`,
    )
  }
  const syncedRef = pickString(syncedTicket, 'ref')
  const summary = pickString(syncedTicket, 'title')

  const epicRef = await avenAdd(
    pi,
    {
      title: `${input} \u2014 ${summary}`,
      epic: true,
      metadata: { 'jira-ref': input },
    },
    cwd,
  )
  await avenDepAdd(pi, epicRef, syncedRef, cwd)

  return { epicRef, syncedRef, created: true }
}

export function registerFindOrCreateEpic(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'find_or_create_epic',
    label: 'Find or Create Epic',
    description:
      'Resolve an aven ref or Jira key to a local epic ref. Returns an existing local epic unchanged, or pulls in a Jira-synced ticket as a new local epic (find-or-create, idempotent).',
    promptSnippet: 'Resolve or create a local epic for a ticket ref/Jira key',
    parameters: Type.Object({
      input: Type.String({
        description: 'aven ref (e.g. PMR-AB12) or Jira key (e.g. DP-71)',
      }),
      cwd: Type.String({ description: 'Working directory for aven commands' }),
    }),
    async execute(_id, params) {
      const result = await findOrCreateEpic(pi, params.input, params.cwd)
      return {
        content: [
          {
            type: 'text',
            text: `epic=${result.epicRef} synced=${result.syncedRef} created=${result.created}`,
          },
        ],
        details: result,
      }
    },
  })
}
