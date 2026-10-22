import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
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
    epicRef: 'PMR-ABC1',
    artifactPath: '/tmp/r.md',
    mode: 'work',
  })
  assert.match(p, /aven show PMR-ABC1 --json/)
  assert.match(p, /acli jira workitem view DP-257/)
  assert.match(p, /aven edit PMR-ABC1 --label researched/)
  assert.match(p, /Do NOT run the ticket-creation gate/)
  assert.doesNotMatch(p, /TICKET CREATION GATE/)
})

test('ticket prompt: acli fallback stops on view failure, no label possible', () => {
  const p = buildTicketResearchPrompt({
    jiraId: 'DP-257',
    epicRef: null,
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

test('phase-prompts: explicit jira-shaped research resolves via findEpicRef', async () => {
  const seen: string[] = []
  const result = await buildPhasePrompt('research', {
    ...BASE,
    mode: 'work',
    research: { kind: 'feature', text: 'DP-257', refHint: 'explicit' },
    findEpicRef: async (jiraId) => {
      seen.push(jiraId)
      return 'PMR-ABC1'
    },
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.deepEqual(seen, ['DP-257'])
  assert.match(result.prompt, /PMR-ABC1/)
  assert.doesNotMatch(result.prompt, /TICKET CREATION GATE/)
})

test('phase-prompts: findEpicRef miss falls back to the acli branch', async () => {
  const result = await buildPhasePrompt('research', {
    ...BASE,
    mode: 'work',
    research: { kind: 'feature', text: 'DP-257', refHint: 'force' },
    findEpicRef: async () => null,
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
    findEpicRef: async () => 'PMR-ABC1',
  })
  assert.equal(result.kind, 'send')
  if (result.kind !== 'send') return
  assert.match(result.prompt, /Debug flow/)
  assert.doesNotMatch(result.prompt, /aven show PMR-ABC1/)
})
