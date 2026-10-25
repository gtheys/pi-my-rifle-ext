// AIDEV-NOTE: pure picker-loop logic for /spec-review (PMR-MR36) — no ctx,
// no pi, side effects only through the injected callbacks (select,
// resolvePlanPath, onPicked, onSkipped). ctx.ui.select is modal and blocks
// the handler, so the loop collects a BATCH: each pick resolves the plan
// path (missing -> skipped with a notice) and re-presents the remaining
// entries plus Done; the caller sends one combined review prompt after Done
// so review prompts never interleave. A cancel (undefined selection)
// behaves like Done. onPicked may be async (the caller opens the file in a
// pane, which awaits) and the loop awaits it before the next select; onSkipped
// stays synchronous. When the last spec is picked the loop ends without
// requiring a final Done.

import type { SpecInReview } from './aven-spec.ts'

export interface PickedSpec {
  ref: string
  title: string
  planPath: string
}

export type PlanPathProbe =
  | { ok: true; planPath: string }
  | { ok: false; reason: string }

export type PickerOutcome =
  | { kind: 'done'; picked: PickedSpec[] }
  | { kind: 'error'; reason: string }

export function pickerOptions(specs: SpecInReview[]): string[] {
  return [...specs.map((s) => `${s.ref} ${s.title}`), 'Done']
}

export async function pickSpecs(opts: {
  specs: SpecInReview[]
  select: (title: string, options: string[]) => Promise<string | undefined>
  resolvePlanPath: (ref: string) => Promise<PlanPathProbe>
  onPicked?: (spec: PickedSpec) => void | Promise<void>
  onSkipped?: (spec: SpecInReview, reason: string) => void
}): Promise<PickerOutcome> {
  const remaining = [...opts.specs]
  const picked: PickedSpec[] = []
  while (remaining.length > 0) {
    let choice: string | undefined
    try {
      choice = await opts.select(
        'Specs awaiting review:',
        pickerOptions(remaining),
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { kind: 'error', reason: `picker failed: ${msg}` }
    }
    if (choice === undefined || choice === 'Done') {
      return { kind: 'done', picked }
    }
    const index = remaining.findIndex((s) => `${s.ref} ${s.title}` === choice)
    if (index === -1) continue
    const [spec] = remaining.splice(index, 1)
    if (spec === undefined) continue
    const probe = await opts.resolvePlanPath(spec.ref)
    if (!probe.ok) {
      opts.onSkipped?.(spec, probe.reason)
      continue
    }
    const entry: PickedSpec = {
      ref: spec.ref,
      title: spec.title,
      planPath: probe.planPath,
    }
    picked.push(entry)
    await opts.onPicked?.(entry)
  }
  return { kind: 'done', picked }
}
