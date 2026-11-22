/**
 * resolve_notes_path tool — compute the canonical notes directory path.
 * Added for PMR-TF0R (feature PMR-HHS8: make all flow document paths env-standard).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { NOTES_SUBDIRS, resolveNotesPath } from './helpers.ts'

// AIDEV-NOTE: PMR-HHS8 fix round (review P3) — the union is derived from
// NOTES_SUBDIRS, so adding a subdir is a single edit in helpers.ts.

export function registerResolveNotesPath(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'resolve_notes_path',
    label: 'Resolve Notes Path',
    description:
      'Compute the canonical notes directory path for this repo. If $LLM_NOTES_ROOT is set, uses $LLM_NOTES_ROOT/<repo>/notes[/<subdir>]; otherwise falls back to <git-toplevel>/notes[/<subdir>]. subdir is restricted to a fixed allowlist ("" for the notes root, or "prs", "specs", "research", "tickets"). Returns the full absolute path.',
    promptSnippet: 'Compute the canonical notes directory path for this repo',
    parameters: Type.Object({
      subdir: Type.Union(
        NOTES_SUBDIRS.map((subdir) => Type.Literal(subdir)),
        {
          description:
            'Notes subdirectory ("" for the notes root; allowlist: prs, specs, research, tickets)',
        },
      ),
    }),
    async execute(_id, params) {
      const notesPath = await resolveNotesPath(pi, params.subdir)
      return {
        content: [{ type: 'text', text: notesPath }],
        details: { notesPath },
      }
    },
  })
}
