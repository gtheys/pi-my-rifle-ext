// AIDEV-NOTE: PMR-YEE7 — rewritten from the stale PMR-ECJK smoke script.
// The old file re-implemented identity routing locally (simulateRouting)
// and asserted the OLD contract (no-mode → roleBlock inlined in the task
// message) — the exact opposite of the post-PMR-ECJK default (identity via
// --append-system-prompt). The routing matrix is covered against the REAL
// composeChildTask in task-composition.test.ts, so the routing section is
// deleted here. What remains is the still-valid part: the `system-prompt`
// frontmatter fixtures, now exercised against the REAL parser
// (loadAgentDefaults via __test__) instead of a local re-implementation,
// and the file is wired into the package test script.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import * as subagentsModule from '../pi-extension/subagents/index.ts'

interface AgentEnv {
  projectAgentsDir: string
}

const roots: string[] = []

async function withIsolatedAgentEnv(
  fn: (env: AgentEnv) => void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pi-spm-test-'))
  roots.push(root)
  const previousCwd = process.cwd()
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const projectDir = join(root, 'project')
  const projectAgentsDir = join(projectDir, '.pi', 'agents')
  const globalDir = join(root, 'global')
  mkdirSync(projectAgentsDir, { recursive: true })
  mkdirSync(join(globalDir, 'agents'), { recursive: true })
  process.chdir(projectDir)
  process.env.PI_CODING_AGENT_DIR = globalDir
  try {
    fn({ projectAgentsDir })
  } finally {
    process.chdir(previousCwd)
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }
  }
}

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
})

function writeAgent(agentsDir: string, name: string, content: string): void {
  writeFileSync(join(agentsDir, `${name}.md`), content)
}

const AGENT_REPLACE = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: replace
auto-exit: true
---

You are a specialized agent.`

const AGENT_APPEND = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: append
---

You are an appended identity.`

const AGENT_DEFAULT = `---
model: anthropic/claude-sonnet-4-20250514
---

You are a default agent.`

const AGENT_INVALID = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: foobar
---

Body here.`

describe('system-prompt frontmatter parsing (real parser)', () => {
  const testApi = (subagentsModule as any).__test__

  it('system-prompt: replace → mode is replace', async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      writeAgent(projectAgentsDir, 'test-replace', AGENT_REPLACE)
      const loaded = testApi.loadAgentDefaults('test-replace')
      assert.ok(loaded, 'expected agent to load')
      assert.equal(loaded.systemPromptMode, 'replace')
    })
  })

  it('system-prompt: append → mode is append', async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      writeAgent(projectAgentsDir, 'test-append', AGENT_APPEND)
      const loaded = testApi.loadAgentDefaults('test-append')
      assert.ok(loaded, 'expected agent to load')
      assert.equal(loaded.systemPromptMode, 'append')
    })
  })

  it('no system-prompt field → mode is undefined', async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      writeAgent(projectAgentsDir, 'test-default', AGENT_DEFAULT)
      const loaded = testApi.loadAgentDefaults('test-default')
      assert.ok(loaded, 'expected agent to load')
      assert.equal(loaded.systemPromptMode, undefined)
    })
  })

  it('system-prompt: foobar → mode is undefined (ignored)', async () => {
    await withIsolatedAgentEnv(({ projectAgentsDir }) => {
      writeAgent(projectAgentsDir, 'test-invalid', AGENT_INVALID)
      const loaded = testApi.loadAgentDefaults('test-invalid')
      assert.ok(loaded, 'expected agent to load')
      assert.equal(loaded.systemPromptMode, undefined)
    })
  })
})
