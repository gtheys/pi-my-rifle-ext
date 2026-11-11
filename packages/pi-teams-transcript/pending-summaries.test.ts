import { expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findPendingSummaries } from './index.ts'

const VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Hine> hello'

async function stage(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'pending-summaries-'))
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body, 'utf8')
  }
  return dir
}

test('.vtt whose note was pushed (pushed/) is not re-bootstrapped', async () => {
  const dir = await stage({
    'vtt/2026-10-29_monthly__abc.vtt': VTT,
    'pushed/2026-10-29_monthly__abc.md': '---\n---\n# done\n## Summary\n- x',
  })

  const result = await findPendingSummaries(dir)

  expect(result.pending).toEqual([])
  expect(result.pushed).toBe(1)
  // the zombie-stub bug: a sibling .md must NOT be bootstrapped from the vtt
  await expect(
    fs.access(path.join(dir, '2026-10-29_monthly__abc.md')),
  ).rejects.toThrow()
})

test('.vtt whose note already sits in the vault is not re-bootstrapped', async () => {
  const dir = await stage({ 'vtt/2026-11-11_sync__def.vtt': VTT })
  const vault = await fs.mkdtemp(path.join(tmpdir(), 'vault-'))
  await fs.writeFile(
    path.join(vault, '2026-11-11_sync__def.md'),
    '---\n---\n# done\n## Summary\n- x',
    'utf8',
  )

  const result = await findPendingSummaries(dir, vault)

  expect(result.pending).toEqual([])
  expect(result.pushed).toBe(1)
  await expect(
    fs.access(path.join(dir, '2026-11-11_sync__def.md')),
  ).rejects.toThrow()
})

test('orphan .vtt with no pushed/vault note bootstraps a pending stub', async () => {
  const dir = await stage({ 'vtt/2026-11-12_new__9ab.vtt': VTT })

  const result = await findPendingSummaries(dir)

  expect(result.pending).toEqual([path.join(dir, '2026-11-12_new__9ab.md')])
  const stub = await fs.readFile(
    path.join(dir, '2026-11-12_new__9ab.md'),
    'utf8',
  )
  expect(stub).toContain('## Transcript')
})

test('sibling .md with a summary counts as done; without one stays pending', async () => {
  const dir = await stage({
    'vtt/a__aaa.vtt': VTT,
    'a__aaa.md': '---\n---\n# a\n## Summary\n- x',
    'vtt/b__bbb.vtt': VTT,
    'b__bbb.md': '---\n---\n# b\n## Transcript\nstuff',
  })

  const result = await findPendingSummaries(dir)

  expect(result.alreadyDone).toBe(1)
  expect(result.pending).toEqual([path.join(dir, 'b__bbb.md')])
})
