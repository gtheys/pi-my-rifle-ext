// AIDEV-NOTE: PMR-T22H — /spec-review and /spec-publish command handlers,
// moved out of index.ts unchanged. /spec-review (PMR-MR36): ctx.ui.select is
// modal and blocks the handler, so the picker collects a BATCH and ONE
// combined sendUserMessage lands after the handler returns — review prompts
// never interleave. Repo name = basename of the git toplevel (aven project).
// Approval is never done here: the injected prompt makes the session the
// reviewer and gates approval on the user's explicit "approve <REF>".
// /spec-publish (PMR-MR36 subtask PMR-2D2X): shared publish for /spec-review
// approvals and feature-plan-aven sessions. Resolution + task text are pure
// (publish.ts); the actual git work runs in a subagent worker — push failure
// never rolls back an approval, it only notifies.
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  avenExec,
  avenOverrideArg,
  resolveSpecWorkspace,
} from '../aven/client.ts'
import { parseSpecReviewArgs } from './args.ts'
import { listSpecsInReview, readPlanPath } from './aven-spec.ts'
import { openFileInPane } from './open-in-pane.ts'
import { pickSpecs } from './picker.ts'
import { buildReviewPrompt } from './prompt.ts'
import {
  buildPublishWorkerTask,
  isPublishSuccess,
  resolvePublishRoot,
  spawnPublishWorker,
} from './publish.ts'
import { parseSpecPublishArgs } from './publish-args.ts'

async function gitToplevel(pi: ExtensionAPI): Promise<string> {
  const out = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
  return out.stdout.trim()
}

export function registerSpecCommands(pi: ExtensionAPI): void {
  pi.registerCommand('spec-review', {
    description:
      'Review specs in plan-state=review. Usage: /spec-review [--workspace <name>]',
    handler: async (args, ctx) => {
      const parsed = parseSpecReviewArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /spec-review [--workspace <name>] | /spec-review help',
          'info',
        )
        return
      }
      let toplevel = ''
      try {
        toplevel = await gitToplevel(pi)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/spec-review: not a git repo (${msg})`, 'warning')
        return
      }
      const project = path.basename(toplevel)
      // AIDEV-NOTE: PMR-MR36 fix round — the same resolved workspace feeds
      // both the list and every per-pick readPlanPath. The list has no ref
      // yet, so only the flag and the config override apply there; per-ref
      // resolution joins at the per-pick readPlanPath.
      const override = await avenOverrideArg()
      const listWorkspace = parsed.workspace ?? override[1]
      const listed = await listSpecsInReview(avenExec, {
        project,
        workspace: listWorkspace,
      })
      if (listed.kind === 'error') {
        ctx.ui.notify(`/spec-review: ${listed.reason}`, 'warning')
        return
      }
      if (listed.specs.length === 0) {
        ctx.ui.notify('no specs awaiting review', 'info')
        return
      }
      const outcome = await pickSpecs({
        specs: listed.specs,
        select: (title, options) => ctx.ui.select(title, options),
        resolvePlanPath: async (ref) => {
          let workspace: string | undefined
          try {
            workspace = await resolveSpecWorkspace(parsed.workspace, ref)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            return { ok: false, reason: `${ref}: ${msg}` }
          }
          const plan = await readPlanPath(avenExec, ref, { workspace })
          if (plan.kind === 'error') return { ok: false, reason: plan.reason }
          if (plan.kind === 'none') {
            return {
              ok: false,
              reason: `${ref}: no plan-path metadata — skipped`,
            }
          }
          if (!existsSync(plan.planPath)) {
            return {
              ok: false,
              reason: `${ref}: plan file missing: ${plan.planPath}`,
            }
          }
          return { ok: true, planPath: plan.planPath }
        },
        onPicked: async (spec) => {
          const pane = await openFileInPane(pi, spec.planPath)
          if (!pane.details.ok) {
            const text = pane.content.map((c) => c.text).join('\n')
            ctx.ui.notify(`/spec-review: ${text}`, 'warning')
          }
        },
        onSkipped: (spec, reason) => {
          ctx.ui.notify(
            `/spec-review skipped ${spec.ref}: ${reason}`,
            'warning',
          )
        },
      })
      if (outcome.kind === 'error') {
        ctx.ui.notify(`/spec-review: ${outcome.reason}`, 'warning')
        return
      }
      if (outcome.picked.length === 0) {
        ctx.ui.notify('no specs selected for review', 'info')
        return
      }
      pi.sendUserMessage(buildReviewPrompt(outcome.picked))
    },
  })

  pi.registerCommand('spec-publish', {
    description:
      'Publish an approved spec plan. Usage: /spec-publish <REF> [--workspace <name>]',
    handler: async (args, ctx) => {
      const parsed = parseSpecPublishArgs(args)
      if (parsed.kind === 'help') {
        ctx.ui.notify(
          'Usage: /spec-publish <REF> [--workspace <name>] | /spec-publish help',
          'info',
        )
        return
      }
      let toplevel = ''
      try {
        toplevel = await gitToplevel(pi)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/spec-publish: not a git repo (${msg})`, 'warning')
        return
      }
      // AIDEV-NOTE: PMR-MR36 fix round — the plan-path query must run in
      // the same workspace the ref lives in (flag > config override > per-ref
      // resolution); a resolution failure stops the publish, never falls
      // back to the cwd-inferred workspace silently.
      let workspace: string | undefined
      try {
        workspace = await resolveSpecWorkspace(parsed.workspace, parsed.ref)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`/spec-publish: ${msg}`, 'warning')
        return
      }
      const plan = await readPlanPath(avenExec, parsed.ref, { workspace })
      if (plan.kind === 'error') {
        ctx.ui.notify(`/spec-publish: ${plan.reason}`, 'warning')
        return
      }
      if (plan.kind === 'none') {
        ctx.ui.notify(
          `/spec-publish: ${parsed.ref} has no plan-path metadata`,
          'warning',
        )
        return
      }
      if (!existsSync(plan.planPath)) {
        ctx.ui.notify(
          `/spec-publish: plan file missing: ${plan.planPath}`,
          'warning',
        )
        return
      }
      const resolved = resolvePublishRoot({
        repo: path.basename(toplevel),
        planPath: plan.planPath,
        toplevel,
      })
      if (resolved.kind === 'error') {
        ctx.ui.notify(`/spec-publish: ${resolved.reason}`, 'warning')
        return
      }
      const outcome = await spawnPublishWorker(ctx, {
        ref: parsed.ref,
        repo: path.basename(toplevel),
        root: resolved.root,
        planFile: resolved.planFile,
        name: `spec-publish: ${parsed.ref}`,
        cwd: toplevel,
        task: buildPublishWorkerTask({
          ref: parsed.ref,
          repo: path.basename(toplevel),
          root: resolved.root,
          planFile: resolved.planFile,
          isFallback: resolved.isFallback,
        }),
      })
      // AIDEV-NOTE: success requires the PUBLISH OK marker from the worker
      // contract — exit-0 alone was a false positive (PMR-MR36 fix round);
      // exit-0 without the marker is a warning, not a success.
      const ok = isPublishSuccess(outcome)
      let severity: 'info' | 'warning' = 'info'
      if (!ok) severity = 'warning'
      ctx.ui.notify(outcome, severity)
    },
  })

  // AIDEV-NOTE: PMR-XCA9 — /review-spec moved from pi-planning's
  // plan-tools/index.ts when the package was absorbed into pi-flow.
  pi.registerCommand('review-spec', {
    description: 'Open a spec/plan file with nvim in a herdr review pane',
    handler: async (args, ctx) => {
      const path = args.trim()
      if (!path) {
        ctx.ui.notify('Usage: /review-spec <path>', 'warning')
        return
      }

      const result = await openFileInPane(pi, path)
      const text = result.content[0]?.text ?? ''
      if (result.details.ok) {
        ctx.ui.notify(text, 'info')
      } else {
        ctx.ui.notify(text, 'error')
      }
    },
  })
}
