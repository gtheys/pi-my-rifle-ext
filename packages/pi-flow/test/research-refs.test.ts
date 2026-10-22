import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { type AvenRunner, findTicketResearchTarget } from '../flow/jira-ref.ts'
import { buildPhasePrompt } from '../flow/phase-prompts.ts'
import { parseResearchArgs } from '../research/args.ts'
import { findResearchedArtifact } from '../research/artifact.ts'
import { buildTicketResearchPrompt } from '../research/prompt.ts'
import { classifyResearchTarget } from '../research/refs.ts'

// --- args ---

test('parseResearchArgs: ID= prefix forces the ticket path', () => {
  assert.deepEqual(parseResearchArgs('ID=DP-257'), {
    kind: 'feature',
    topic: 'DP-257',
    forceRef: true,
  })
  assert.deepEqual(parseResearchArgs('ID=  dp-9  '), {
    kind: 'feature',
    topic: 'dp-9',
    forceRef: true,
  })
})

test('parseResearchArgs: ID= without a ref → help', () => {
  assert.deepEqual(parseResearchArgs('ID='), { kind: 'help' })
  assert.deepEqual(parseResearchArgs('ID=   '), { kind: 'help' })
})

test('parseResearchArgs: bare topic stays unforced', () => {
  assert.deepEqual(parseResearchArgs('DP-257 rate limits'), {
    kind: 'feature',
    topic: 'DP-257 rate limits',
  })
})

// --- classification ---

test('classify: force wins in any mode and normalizes case', () => {
  for (const mode of ['work', 'personal'] as const) {
    assert.deepEqual(
      classifyResearchTarget('dp-257', { force: true, explicit: false, mode }),
      { kind: 'ticket', jiraId: 'DP-257' },
    )
  }
})

test('classify: work mode + explicit jira-shaped topic → ticket', () => {
  assert.deepEqual(
    classifyResearchTarget('DP-257', {
      force: false,
      explicit: true,
      mode: 'work',
    }),
    { kind: 'ticket', jiraId: 'DP-257' },
  )
})

test('classify: personal mode bare jira-shaped topic stays topic (aven-ref ambiguity)', () => {
  assert.deepEqual(
    classifyResearchTarget('PMR-5900', {
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
      classifyResearchTarget('rate limiting', {
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
  const p = buildTicketResearchPrompt({
    jiraId: 'DP-257',
    target: { kind: 'epic', ref: 'PMR-ABC1' },
    artifactPath: '/tmp/r.md',
    mode: 'work',
  })
  assert.match(p, /aven show PMR-ABC1 --json/)
  assert.match(p, /epic_children/)
  assert.match(p, /aven show <synced-ref> --full/)
  assert.match(p, /acli jira workitem view DP-257/)
  assert.match(p, /aven edit PMR-ABC1 --label researched/)
  assert.match(p, /Do NOT run the ticket-creation gate/)
  assert.doesNotMatch(p, /TICKET CREATION GATE/)
})

test('ticket prompt: synced branch targets the aven ticket, no acli, marker for later epic', () => {
  const p = buildTicketResearchPrompt({
    jiraId: 'DP-247',
    target: { kind: 'synced', ref: 'DPX-TFZH' },
    artifactPath: '/tmp/r.md',
    mode: 'work',
  })
  assert.match(p, /synced aven ticket DPX-TFZH/)
  assert.match(p, /aven show DPX-TFZH --full/)
  assert.doesNotMatch(p, /acli/)
  assert.match(p, /aven edit DPX-TFZH --label researched/)
  assert.match(p, /researched by pi-flow/)
  assert.match(p, /creates the local epic and inherits/)
  assert.doesNotMatch(p, /TICKET CREATION GATE/)
})

test('ticket prompt: acli fallback stops on view failure, no label possible', () => {
  const p = buildTicketResearchPrompt({
    jiraId: 'DP-257',
    target: null,
    artifactPath: '/tmp/r.md',
    mode: 'work',
  })
  assert.match(p, /acli jira workitem view DP-257/)
  assert.match(p, /stop and/)
  assert.match(p, /researched by pi-flow/)
  assert.doesNotMatch(p, /--label researched/)
})

// --- research-label inheritance ---

async function withResearchDir(files: Record<string, string>): Promise<string> {
  const gitRoot = path.join(
    await mkdtemp(path.join(tmpdir(), 'pi-flow-research-')),
    'repo',
  )
  const dir = path.join(gitRoot, 'notes', 'research')
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content)
  }
  return gitRoot
}

test('findResearchedArtifact: finds the marker in the newest matching file', async () => {
  const root = await withResearchDir({
    '2026-10-01-dp-257.md': '# Research: DP-257\n',
    '2026-10-09-dp-257.md':
      '# Research: DP-257\n> researched by pi-flow on 2026-10-09\n',
    '2026-10-15-dp-257.md': '# Research: DP-257\nno marker here\n',
  })
  try {
    const found = await findResearchedArtifact(
      undefined,
      'repo',
      root,
      'DP-257',
    )
    assert.ok(found)
    assert.match(found, /2026-10-09-dp-257\.md$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findResearchedArtifact: slug boundary — dp-257 does not match dp-2570', async () => {
  const root = await withResearchDir({
    '2026-10-09-dp-2570.md': '> researched by pi-flow\n',
  })
  try {
    const found = await findResearchedArtifact(
      undefined,
      'repo',
      root,
      'DP-257',
    )
    assert.equal(found, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findResearchedArtifact: missing dir → null', async () => {
  const found = await findResearchedArtifact(
    undefined,
    'no-such-repo',
    '/nonexistent/root',
    'DP-257',
  )
  assert.equal(found, null)
})

// --- phase-prompts integration ---

const BASE = {
  ref: 'TP-1',
  skipResearch: false,
  gitRoot: '/home/x/pi-flow-range',
  workRoots: [] as string[],
  labels: [] as string[],
}

test('phase-prompts: explicit jira-shaped research resolves via findTicketRef', async () => {
  const seen: string[] = []
  const result = await buildPhasePrompt('research', {
    ...BASE,
    mode: 'work',
    research: { kind: 'feature', text: 'DP-257', refHint: 'explicit' },
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
  const result = await buildPhasePrompt('research', {
    ...BASE,
    mode: 'work',
    research: { kind: 'feature', text: 'DP-247', refHint: 'force' },
    findTicketRef: async () => ({ kind: 'synced', ref: 'DPX-TFZH' }),
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /aven show DPX-TFZH --full/)
  assert.doesNotMatch(result.prompt, /acli/)
})

test('phase-prompts: findTicketRef miss falls back to the acli branch', async () => {
  const result = await buildPhasePrompt('research', {
    ...BASE,
    mode: 'work',
    research: { kind: 'feature', text: 'DP-257', refHint: 'force' },
    findTicketRef: async () => null,
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /not aven-managed/)
  assert.match(result.prompt, /acli jira workitem view DP-257/)
})

test('phase-prompts: default ref-as-topic never takes the ticket path', async () => {
  const result = await buildPhasePrompt('research', {
    ...BASE,
    mode: 'work',
    ref: 'PMR-5900',
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /topic = "PMR-5900"/)
})

test('phase-prompts: debug symptoms never take the ticket path', async () => {
  const result = await buildPhasePrompt('research', {
    ...BASE,
    mode: 'work',
    research: { kind: 'debug', text: 'DP-257 crashes' },
    findTicketRef: async () => ({ kind: 'epic', ref: 'PMR-ABC1' }),
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /Debug flow/)
  assert.doesNotMatch(result.prompt, /aven show PMR-ABC1/)
})

// --- jira-ref target resolution ---

test('findTicketResearchTarget: epic beats synced; synced found via jira-key; miss = none', async () => {
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
  const t1 = await findTicketResearchTarget('DP-1', epicAndSynced)
  assert.deepEqual(t1, { kind: 'epic', ref: 'PMR-E1' })

  const syncedOnly = scripted({
    'jira-key=DP-2': '[{"ref":"DPX-S2","is_epic":false}]',
  })
  const t2 = await findTicketResearchTarget('DP-2', syncedOnly)
  assert.deepEqual(t2, { kind: 'synced', ref: 'DPX-S2' })

  const neither = scripted({})
  const t3 = await findTicketResearchTarget('DP-3', neither)
  assert.deepEqual(t3, { kind: 'none' })
})
