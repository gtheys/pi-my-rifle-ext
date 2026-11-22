import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBrainstormArgs } from '../brainstorm/args.ts'
import { buildTicketBrainstormPrompt } from '../brainstorm/prompt.ts'
import { classifyBrainstormTarget } from '../brainstorm/refs.ts'
import {
  type AvenRunner,
  findTicketBrainstormTarget,
} from '../flow/jira-ref.ts'
import { buildPhasePrompt } from '../flow/phase-prompts.ts'

// --- args ---

test('parseBrainstormArgs: ID= prefix forces the ticket path', () => {
  assert.deepEqual(parseBrainstormArgs('ID=DP-257'), {
    kind: 'feature',
    topic: 'DP-257',
    forceRef: true,
  })
  assert.deepEqual(parseBrainstormArgs('ID=  dp-9  '), {
    kind: 'feature',
    topic: 'dp-9',
    forceRef: true,
  })
})

test('parseBrainstormArgs: ID= without a ref → help', () => {
  assert.deepEqual(parseBrainstormArgs('ID='), { kind: 'help' })
  assert.deepEqual(parseBrainstormArgs('ID=   '), { kind: 'help' })
})

test('parseBrainstormArgs: bare topic stays unforced', () => {
  assert.deepEqual(parseBrainstormArgs('DP-257 rate limits'), {
    kind: 'feature',
    topic: 'DP-257 rate limits',
  })
})

// --- classification ---

test('classify: force wins in any mode and normalizes case', () => {
  for (const mode of ['work', 'personal'] as const) {
    assert.deepEqual(
      classifyBrainstormTarget('dp-257', {
        force: true,
        explicit: false,
        mode,
      }),
      { kind: 'ticket', jiraId: 'DP-257' },
    )
  }
})

test('classify: work mode + explicit jira-shaped topic → ticket', () => {
  assert.deepEqual(
    classifyBrainstormTarget('DP-257', {
      force: false,
      explicit: true,
      mode: 'work',
    }),
    { kind: 'ticket', jiraId: 'DP-257' },
  )
})

test('classify: personal mode bare jira-shaped topic stays topic (aven-ref ambiguity)', () => {
  assert.deepEqual(
    classifyBrainstormTarget('PMR-5900', {
      force: false,
      explicit: true,
      mode: 'personal',
    }),
    { kind: 'topic', text: 'PMR-5900' },
  )
})

test('classify: non-jira text stays topic everywhere', () => {
  for (const mode of ['work', 'personal'] as const) {
    assert.deepEqual(
      classifyBrainstormTarget('rate limiting', {
        force: false,
        explicit: true,
        mode,
      }),
      { kind: 'topic', text: 'rate limiting' },
    )
  }
})

// --- ticket prompt ---

test('ticket prompt: epic branch labels the epic and forbids creation', () => {
  const p = buildTicketBrainstormPrompt({
    jiraId: 'DP-257',
    target: { kind: 'epic', ref: 'PMR-ABC1' },
    artifactPath: '/tmp/r.md',
    mode: 'work',
  })
  assert.match(p, /aven show PMR-ABC1 --json/)
  assert.match(p, /epic_children/)
  assert.match(p, /aven show <synced-ref> --full/)
  assert.match(p, /acli jira workitem view DP-257/)
  assert.doesNotMatch(p, /flow_phase_complete/)
  assert.doesNotMatch(p, /aven edit PMR-ABC1 --label brainstormed/)
  assert.match(p, /Do NOT run the ticket-creation gate/)
  assert.doesNotMatch(p, /TICKET CREATION GATE/)
})

test('ticket prompt: synced branch targets the aven ticket, no acli', () => {
  const p = buildTicketBrainstormPrompt({
    jiraId: 'DP-247',
    target: { kind: 'synced', ref: 'DPX-TFZH' },
    artifactPath: '/tmp/r.md',
    mode: 'work',
  })
  assert.match(p, /synced aven ticket DPX-TFZH/)
  assert.match(p, /aven show DPX-TFZH --full/)
  assert.doesNotMatch(p, /acli/)
  assert.doesNotMatch(p, /flow_phase_complete/)
  assert.doesNotMatch(p, /brainstormed by pi-flow/)
  assert.doesNotMatch(p, /TICKET CREATION GATE/)
})

test('ticket prompt: acli fallback stops on view failure, no label possible', () => {
  const p = buildTicketBrainstormPrompt({
    jiraId: 'DP-257',
    target: null,
    artifactPath: '/tmp/r.md',
    mode: 'work',
  })
  assert.match(p, /acli jira workitem view DP-257/)
  assert.match(p, /stop and/)
  assert.doesNotMatch(p, /brainstormed by pi-flow/)
  assert.doesNotMatch(p, /--label brainstormed/)
})

// --- phase-prompts integration ---

const BASE = {
  ref: 'TP-1',
  gitRoot: '/home/x/pi-flow-range',
  workRoots: [] as string[],
  labels: [] as string[],
}

test('phase-prompts: explicit jira-shaped brainstorm resolves via findTicketRef', async () => {
  const seen: string[] = []
  const result = await buildPhasePrompt('brainstorm', {
    ...BASE,
    mode: 'work',
    brainstorm: { kind: 'feature', text: 'DP-257', refHint: 'explicit' },
    findTicketRef: async (jiraId) => {
      seen.push(jiraId)
      return { kind: 'epic', ref: 'PMR-ABC1' }
    },
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.deepEqual(seen, ['DP-257'])
  assert.match(result.prompt, /PMR-ABC1/)
  assert.doesNotMatch(result.prompt, /TICKET CREATION GATE/)
})

test('phase-prompts: synced ticket resolves without acli', async () => {
  const result = await buildPhasePrompt('brainstorm', {
    ...BASE,
    mode: 'work',
    brainstorm: { kind: 'feature', text: 'DP-247', refHint: 'force' },
    findTicketRef: async () => ({ kind: 'synced', ref: 'DPX-TFZH' }),
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /aven show DPX-TFZH --full/)
  assert.doesNotMatch(result.prompt, /acli/)
})

// AIDEV-NOTE: PMR-YC8V — the brainstorm artifact dir must use the caller-
// supplied repoName (getRepoName: origin remote name preferred, worktree-
// safe), not the gitRoot basename: in a herdr worktree the basename is the
// worktree dir, which scattered notes into per-worktree junk dirs under the
// notes root — the symptom PMR-HHS8 eliminated for the resolver tools.
test('phase-prompts: brainstorm dir uses repoName, not the worktree gitRoot basename', async () => {
  const prev = process.env.LLM_NOTES_ROOT
  process.env.LLM_NOTES_ROOT = '/home/x/notes'
  try {
    const result = await buildPhasePrompt('brainstorm', {
      ...BASE,
      mode: 'work',
      gitRoot: '/home/x/.herdr/worktrees/pi-flow-range/feat-some-branch',
      repoName: 'pi-flow-range',
      brainstorm: { kind: 'feature', text: 'dark mode' },
    })
    assert.equal(result.kind, 'send')
    if (result.kind !== 'send') return
    assert.match(
      result.prompt,
      /\/home\/x\/notes\/pi-flow-range\/notes\/brainstorm\//,
    )
    assert.doesNotMatch(result.prompt, /feat-some-branch/)
  } finally {
    if (prev === undefined) delete process.env.LLM_NOTES_ROOT
    else process.env.LLM_NOTES_ROOT = prev
  }
})

test('phase-prompts: findTicketRef miss falls back to the acli branch', async () => {
  const result = await buildPhasePrompt('brainstorm', {
    ...BASE,
    mode: 'work',
    brainstorm: { kind: 'feature', text: 'DP-257', refHint: 'force' },
    findTicketRef: async () => null,
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /not aven-managed/)
  assert.match(result.prompt, /acli jira workitem view DP-257/)
})

test('phase-prompts: default ref-as-topic never takes the ticket path', async () => {
  const result = await buildPhasePrompt('brainstorm', {
    ...BASE,
    mode: 'work',
    ref: 'PMR-5900',
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /topic = "PMR-5900"/)
})

test('phase-prompts: debug symptoms never take the ticket path', async () => {
  const result = await buildPhasePrompt('brainstorm', {
    ...BASE,
    mode: 'work',
    brainstorm: { kind: 'debug', text: 'DP-257 crashes' },
    findTicketRef: async () => ({ kind: 'epic', ref: 'PMR-ABC1' }),
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /Debug flow/)
  assert.doesNotMatch(result.prompt, /aven show PMR-ABC1/)
})

// --- jira-ref target resolution ---

test('findTicketBrainstormTarget: epic beats synced; synced found via jira-key; miss = none', async () => {
  const scripted = (responses: Record<string, string>) =>
    (async (args: readonly string[]) => {
      const key = args.join(' ')
      for (const [needle, body] of Object.entries(responses)) {
        if (key.includes(needle)) return { stdout: body, stderr: '' }
      }
      return { stdout: '[]', stderr: '' }
    }) as AvenRunner

  const epicAndSynced = scripted({
    'jira-ref=DP-1': '[{"ref":"PMR-E1","is_epic":true}]',
    'jira-key=DP-1': '[{"ref":"DPX-S1","is_epic":false}]',
  })
  const t1 = await findTicketBrainstormTarget('DP-1', epicAndSynced)
  assert.deepEqual(t1, { kind: 'epic', ref: 'PMR-E1' })

  const syncedOnly = scripted({
    'jira-key=DP-2': '[{"ref":"DPX-S2","is_epic":false}]',
  })
  const t2 = await findTicketBrainstormTarget('DP-2', syncedOnly)
  assert.deepEqual(t2, { kind: 'synced', ref: 'DPX-S2' })

  const neither = scripted({})
  const t3 = await findTicketBrainstormTarget('DP-3', neither)
  assert.deepEqual(t3, { kind: 'none' })
})
