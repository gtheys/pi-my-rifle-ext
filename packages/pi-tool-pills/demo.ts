/** Demo: old vs new pi-tool-pills rendering. Run: bun demo.ts */
import { execSync } from 'node:child_process'
import { FffService, fffFormatGrepText } from './fff.ts'
import { iconizePaths, renderTree } from './icons.ts'

const lsRaw = execSync('ls -F .. | head -20').toString().trimEnd()
console.log('════════ ls — BEFORE (plain) ════════')
console.log(lsRaw)
console.log('\n════════ ls — AFTER (tree + nerd icons) ════════')
console.log(renderTree(lsRaw))

const findRaw = execSync(
  "find .. -maxdepth 1 -type d -name 'pi-*' | sort | head -8",
)
  .toString()
  .trimEnd()
console.log('\n════════ find — BEFORE ════════')
console.log(findRaw)
console.log('\n════════ find — AFTER (icons) ════════')
console.log(iconizePaths(findRaw))

const s = new FffService()
await s.init(process.cwd())
if (s.isAvailable) {
  console.log(
    '\n════════ FFF find — glob "**/package.json" (frecency-ranked) ════════',
  )
  // biome-ignore lint/style/noNonNullAssertion: guarded by s.isAvailable above
  const r = s.finder!.glob('**/package.json', { pageSize: 5 })
  console.log(
    r.ok ? r.value.items.map((i) => i.relativePath).join('\n') : r.error,
  )

  console.log('\n════════ FFF grep — "FffService" ════════')
  // biome-ignore lint/style/noNonNullAssertion: guarded by s.isAvailable above
  const g = s.finder!.grep('FffService', { pageSize: 4, mode: 'plain' })
  console.log(g.ok ? fffFormatGrepText(g.value.items, 4) : g.error)
} else {
  console.log('\nFFF unavailable — SDK fallback would be used')
}
s.destroy()
