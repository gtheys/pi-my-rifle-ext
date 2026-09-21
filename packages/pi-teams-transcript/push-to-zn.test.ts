import { expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pushStagingToZn, type ZnRunner } from './index.ts'

// Fake zn: records create calls, answers search-title with a fixed remote set
function fakeZn(remotePaths: string[]) {
  const created: Array<{ args: string[]; body: string }> = []
  const run: ZnRunner = async (args, input) => {
    if (args[0] === 'search-title') {
      const title = args[1]
      return JSON.stringify(
        remotePaths
          .filter((p) => p.endsWith(`/${title}.md`))
          .map((p) => ({ path: p })),
      )
    }
    if (args[0] === 'create') {
      created.push({ args, body: input ?? '' })
      return '{}'
    }
    throw new Error(`unexpected zn call: ${args.join(' ')}`)
  }
  return { run, created }
}

async function stage(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'zn-push-'))
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body, 'utf8')
  }
  return dir
}

test('pushes new .md and .vtt, skips existing, moves to pushed/', async () => {
  // md note already remote; vtt not (same basename — dedup must use full path)
  const { run, created } = fakeZn(['Meetings/standup__abc.md'])
  const dir = await stage({
    'standup__abc.md': '---\ntitle: standup\n---\nbody',
    'vtt/standup__abc.vtt': 'WEBVTT\n\n00:00 text',
    'vtt/other__def.vtt': 'WEBVTT\n\n00:00 other',
  })

  const lines = await pushStagingToZn(dir, run)

  expect(lines).toEqual([
    'skip (exists): Meetings/standup__abc.md',
    'pushed: Meetings/vtt/other__def.md',
    'pushed: Meetings/vtt/standup__abc.md',
  ])
  // only the two vtt notes created, with bodies and inbox subpaths
  expect(created.map((c) => c.args.join(' '))).toEqual([
    'create --folder inbox --subpath Meetings/vtt --title other__def --body -',
    'create --folder inbox --subpath Meetings/vtt --title standup__abc --body -',
  ])
  expect(created[1].body).toBe('WEBVTT\n\n00:00 text')

  // everything moved to pushed/ — re-run finds nothing
  expect(await pushStagingToZn(dir, run)).toEqual([])
  expect((await fs.readdir(path.join(dir, 'pushed'))).sort()).toEqual([
    'standup__abc.md',
    'vtt',
  ])
  expect((await fs.readdir(path.join(dir, 'pushed', 'vtt'))).sort()).toEqual([
    'other__def.vtt',
    'standup__abc.vtt',
  ])
})
