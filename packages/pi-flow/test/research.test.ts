import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseResearchArgs } from '../research/args.ts'
import { renderArtifact } from '../research/artifact.ts'
import { resolveResearchDir, slugify } from '../research/paths.ts'
import { buildResearchPrompt } from '../research/prompt.ts'
import { buildTicketPlan } from '../research/ticket-gate.ts'

// --- args ---

test('parseResearchArgs: empty → help', () => {
  assert.deepEqual(parseResearchArgs(''), { kind: 'help' })
  assert.deepEqual(parseResearchArgs('   '), { kind: 'help' })
})

test('parseResearchArgs: --debug with symptom', () => {
  assert.deepEqual(parseResearchArgs('--debug login 500s on prod'), {
    kind: 'debug',
    symptom: 'login 500s on prod',
  })
})

test('parseResearchArgs: --debug without symptom → help', () => {
  assert.deepEqual(parseResearchArgs('--debug'), { kind: 'help' })
  assert.deepEqual(parseResearchArgs('--debug   '), { kind: 'help' })
})

test('parseResearchArgs: topic', () => {
  assert.deepEqual(parseResearchArgs('rate limiting for the API'), {
    kind: 'feature',
    topic: 'rate limiting for the API',
  })
})

// --- paths ---

test('slugify matches plan-tools contract', () => {
  assert.equal(slugify('Add OAuth2 Login!'), 'add-oauth2-login')
  assert.equal(
    slugify('one two three four five six'),
    'one-two-three-four-five',
  )
})

test('resolveResearchDir: work mode, LLM_NOTES_ROOT set → notes-root branch', () => {
  const dir = resolveResearchDir('work', '/nr', '/pf', 'myrepo', '/home/x/repo')
  assert.equal(dir, '/nr/myrepo/notes/research')
})

test('resolveResearchDir: work mode, LLM_NOTES_ROOT unset → repo-local branch', () => {
  const dir = resolveResearchDir(
    'work',
    undefined,
    '/pf',
    'myrepo',
    '/home/x/repo',
  )
  assert.equal(dir, '/home/x/repo/notes/research')
})

test('resolveResearchDir: personal mode, PERSONAL_FEATURES set → features branch', () => {
  const dir = resolveResearchDir(
    'personal',
    '/nr',
    '/pf',
    'myrepo',
    '/home/x/repo',
  )
  assert.equal(dir, '/pf/myrepo/notes/research')
})

test('resolveResearchDir: personal mode, PERSONAL_FEATURES unset → repo-local branch', () => {
  const dir = resolveResearchDir(
    'personal',
    '/nr',
    undefined,
    'myrepo',
    '/home/x/repo',
  )
  assert.equal(dir, '/home/x/repo/notes/research')
})

// --- artifact ---

test('renderArtifact: feature flow sections', () => {
  const md = renderArtifact({
    kind: 'feature',
    title: 'Rate limiting',
    date: '2026-10-16',
    mode: 'work',
    questions: ['Q1', 'Q2'],
    findings: ['F1'],
    diagrams: ['```mermaid\ngraph TD\nA-->B\n```'],
    ticketImplications: ['Needs new endpoint'],
  })
  assert.match(md, /^# Research: Rate limiting$/m)
  assert.match(md, /## Questions/)
  assert.match(md, /- Q1/)
  assert.match(md, /## Findings/)
  assert.match(md, /## Diagrams/)
  assert.match(md, /```mermaid/)
  assert.match(md, /## Ticket implications/)
  assert.match(md, /- Needs new endpoint/)
  assert.doesNotMatch(md, /## Hypothesis chain/)
})

test('renderArtifact: debug flow sections', () => {
  const md = renderArtifact({
    kind: 'debug',
    title: 'login 500s',
    date: '2026-10-16',
    mode: 'personal',
    questions: [],
    findings: ['F1'],
    diagrams: [],
    hypothesisChain: ['H1: token expiry', 'H2: clock skew'],
    evidence: ['E1: logs show...'],
  })
  assert.match(md, /## Hypothesis chain/)
  assert.match(md, /- H1: token expiry/)
  assert.match(md, /## Evidence/)
  assert.doesNotMatch(md, /## Ticket implications/)
  assert.match(md, /Mode: personal/)
})

test('renderArtifact: empty sections rendered as none-yet', () => {
  const md = renderArtifact({
    kind: 'feature',
    title: 't',
    date: '2026-10-16',
    mode: 'work',
    questions: [],
    findings: [],
    diagrams: [],
    ticketImplications: [],
  })
  assert.match(md, /## Questions\n\n_None yet_\n/)
})

// --- ticket gate ---

// AIDEV-NOTE: the gate is the safety property under test — no plan object
// escapes buildTicketPlan unless confirmed === true.

test('buildTicketPlan: never returns plan without explicit confirm', () => {
  for (const confirmed of [false, undefined]) {
    const plan = buildTicketPlan({
      kind: 'feature',
      mode: 'work',
      confirmed,
      projectKey: 'SOL',
    })
    assert.equal(plan, null)
  }
})

test('buildTicketPlan: work mode → Jira plan with project key + acli', () => {
  const plan = buildTicketPlan({
    kind: 'debug',
    mode: 'work',
    confirmed: true,
    projectKey: 'SOL',
  })
  assert.ok(plan)
  assert.equal(plan.destination, 'jira')
  assert.equal(plan.projectKey, 'SOL')
  assert.equal(plan.typeLabel, 'bug')
  assert.match(plan.summary, /Jira project SOL/)
})

test('buildTicketPlan: personal mode → aven plan with workspace+project', () => {
  const plan = buildTicketPlan({
    kind: 'feature',
    mode: 'personal',
    confirmed: true,
    workspace: 'personal',
    project: 'ideas',
  })
  assert.ok(plan)
  assert.equal(plan.destination, 'aven')
  assert.equal(plan.typeLabel, 'feature')
  assert.match(plan.summary, /aven workspace 'personal', project 'ideas'/)
})

test('buildTicketPlan: confirmed but missing destination details → null', () => {
  assert.equal(
    buildTicketPlan({ kind: 'feature', mode: 'work', confirmed: true }),
    null,
  )
  assert.equal(
    buildTicketPlan({ kind: 'debug', mode: 'personal', confirmed: true }),
    null,
  )
})

// --- prompt ---

test('buildResearchPrompt: debug flow references debug skill and bug label', () => {
  const p = buildResearchPrompt({
    kind: 'debug',
    input: 'login 500s',
    artifactPath: '/tmp/r.md',
    mode: 'work',
  })
  assert.match(p, /engineering:debug/)
  assert.match(p, /\/tmp\/r\.md/)
  assert.match(p, /bug/)
  assert.match(p, /confirmed/)
})

test('buildResearchPrompt: feature flow references ask_user_question loop and scouts', () => {
  const p = buildResearchPrompt({
    kind: 'feature',
    input: 'rate limiting',
    artifactPath: '/tmp/r.md',
    mode: 'personal',
  })
  assert.match(p, /ask_user_question/)
  assert.match(p, /subagent/)
  assert.match(p, /mermaid/)
  assert.match(p, /feature/)
})
