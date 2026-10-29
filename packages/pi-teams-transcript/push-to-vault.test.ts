import { expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pushStagingToVault } from './index.ts'

async function stage(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'vault-push-'))
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body, 'utf8')
  }
  return dir
}

test('pushes new .md, skips existing, moves to pushed/, leaves .vtt in place', async () => {
  const staging = await stage({
    'standup__abc.md': '---\ntitle: standup\n---\nbody',
    'other__def.md': '---\ntitle: other\n---\nbody',
    'vtt/standup__abc.vtt': 'WEBVTT\n\n00:00 text',
  })
  const vault = await fs.mkdtemp(path.join(tmpdir(), 'vault-'))
  await fs.writeFile(
    path.join(vault, 'other__def.md'),
    '---\ntitle: other\n---\nexisting vault copy',
    'utf8',
  )

  const lines = await pushStagingToVault(staging, vault)

  expect(lines).toEqual([
    'skip (exists): other__def.md',
    'pushed: standup__abc.md',
  ])
  expect(await fs.readFile(path.join(vault, 'standup__abc.md'), 'utf8')).toBe(
    '---\ntitle: standup\n---\nbody',
  )
  // existing vault note never overwritten
  expect(await fs.readFile(path.join(vault, 'other__def.md'), 'utf8')).toBe(
    '---\ntitle: other\n---\nexisting vault copy',
  )

  // staging .md moved to pushed/, vtt untouched as the sync dedup store
  expect((await fs.readdir(path.join(staging, 'pushed'))).sort()).toEqual([
    'other__def.md',
    'standup__abc.md',
  ])
  expect(await fs.readdir(path.join(staging, 'vtt'))).toEqual([
    'standup__abc.vtt',
  ])

  // re-run finds nothing — idempotent
  expect(await pushStagingToVault(staging, vault)).toEqual([])
})

test('missing vault folder fails loud instead of creating a junk directory', async () => {
  const staging = await stage({ 'a__b.md': 'body' })
  const missing = path.join(staging, 'no-such-vault')
  await expect(pushStagingToVault(staging, missing)).rejects.toThrow(
    /vault Meetings folder does not exist/,
  )
})
