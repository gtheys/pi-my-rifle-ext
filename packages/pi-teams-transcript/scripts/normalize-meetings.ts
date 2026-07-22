// AIDEV-NOTE: one-off migration for existing meeting .md stubs written before
// bracket-nickname normalization. Rewrites ONLY: frontmatter attendees list,
// the "**Attendees:**" header line, and [[...]] links whose target still has a
// '[' (the bracket bug). Leaves the entire "## Transcript" section byte-for-byte
// intact. Reuses index.ts's tested parseAttendee/resolveAttendee/attendeeLink.
//
//   bun run packages/pi-teams-transcript/scripts/normalize-meetings.ts <dir>
//
// Not in the package `files` allowlist — not shipped, run by hand only.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { attendeeLink, parseAttendee, resolveAttendee } from '../index.ts'

const DIR = process.argv[2] ?? '/home/geert/Documents/ZenVault/Meetings'

function yamlScalar(s: string): string {
  if (/^[\s]|[\s]$|[:#\-[\]{}&*!|>'"%@`]/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`
  }
  return s
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"')
  }
  return t
}

interface FileResult {
  file: string
  changed: boolean
  attendees: number
  headerRewritten: boolean
  linksFixed: number
  notes: string[]
}

async function normalizeFile(filePath: string): Promise<FileResult> {
  const r: FileResult = {
    file: path.basename(filePath),
    changed: false,
    attendees: 0,
    headerRewritten: false,
    linksFixed: 0,
    notes: [],
  }
  const src = await fs.readFile(filePath, 'utf8')

  const fmMatch = src.match(/^---\n([\s\S]*?)\n---\n/)
  if (!fmMatch) {
    r.notes.push('no frontmatter — skipped')
    return r
  }
  const afterFm = src.slice(fmMatch[0].length)
  const transcriptIdx = afterFm.indexOf('## Transcript')
  if (transcriptIdx === -1) {
    r.notes.push('no ## Transcript — skipped')
    return r
  }
  const middle = afterFm.slice(0, transcriptIdx)
  const transcript = afterFm.slice(transcriptIdx)

  // --- frontmatter: de-bracket the attendees list, keep the raw names ---
  const fmLines = fmMatch[1].split('\n')
  const rawAttendees: string[] = []
  const outFm: string[] = []
  let i = 0
  while (i < fmLines.length) {
    if (/^attendees:\s*$/.test(fmLines[i])) {
      outFm.push('attendees:')
      i++
      while (i < fmLines.length && /^\s+-\s+/.test(fmLines[i])) {
        const raw = unquote(fmLines[i].replace(/^\s+-\s+/, ''))
        rawAttendees.push(raw)
        outFm.push(`  - ${yamlScalar(parseAttendee(raw).full)}`)
        r.attendees++
        i++
      }
      continue
    }
    outFm.push(fmLines[i])
    i++
  }

  // --- middle: header Attendees line + bracket-bug link canonicalization ---
  let outMiddle = middle
  if (rawAttendees.length) {
    const links = rawAttendees
      .map((a) => attendeeLink(rawAttendees, a))
      .join(', ')
    const before = outMiddle
    outMiddle = outMiddle.replace(/^(- \*\*Attendees:\*\*).*$/m, `$1 ${links}`)
    r.headerRewritten = outMiddle !== before
  }

  outMiddle = outMiddle.replace(/\[\[(.+?)\]\]/g, (whole, inside: string) => {
    const pipe = inside.indexOf('|')
    const target = (pipe === -1 ? inside : inside.slice(0, pipe)).trim()
    if (!target.includes('[')) return whole // already clean — leave it
    const { full, alias } = resolveAttendee(rawAttendees, target)
    r.linksFixed++
    return alias ? `[[${full}|${alias}]]` : `[[${full}]]`
  })

  const result = `---\n${outFm.join('\n')}\n---\n${outMiddle}${transcript}`
  r.changed = result !== src
  if (r.changed) await fs.writeFile(filePath, result, 'utf8')
  return r
}

async function main() {
  const entries = await fs.readdir(DIR)
  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort()
  console.log(`# normalize-meetings: ${mdFiles.length} .md file(s) in ${DIR}\n`)
  let anyChanged = false
  for (const f of mdFiles) {
    const res = await normalizeFile(path.join(DIR, f))
    if (res.changed) {
      anyChanged = true
      console.log(
        `✓ ${res.file}  attendees=${res.attendees} header=${res.headerRewritten ? 'yes' : 'no'} linksFixed=${res.linksFixed}`,
      )
    } else {
      console.log(`· ${res.file}  (unchanged)`)
    }
    for (const n of res.notes) console.log(`    - ${n}`)
  }
  console.log(`\n${anyChanged ? 'changed' : 'no changes'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
