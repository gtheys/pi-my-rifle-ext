// AIDEV-NOTE: viewerPlacement mirrors VIEWER_PLACEMENTS / ViewerPlacement in
// herdr/viewer.ts — duplicate literal union by design (config stays standalone);
// keep the two in sync (PMR-YD1P).
// AIDEV-NOTE: pi-flow config boundary (PMR-T22H) — TypeBox schema is the
// source of truth for config shape; config.schema.json (checked in) mirrors
// it. Malformed config throws a clear error — never silent defaults
// (AGENTS.md rule). resolveMode is the pi-bound mode resolver; the pure
// modeForToplevel decision lives in work-mode.ts.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  getAgentDir,
} from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'
import { modeForToplevel, type WorkMode } from './work-mode.ts'

const PiFlowConfigSchema = Type.Object({
  workRoots: Type.Array(
    Type.String({ description: 'Absolute path prefix of a work repo root' }),
    {
      description: 'Git toplevels under any prefix are "work" mode',
      minItems: 0,
    },
  ),
  avenWorkspace: Type.Optional(
    Type.String({
      description:
        'Aven workspace name or key forced on every aven call pi-flow makes (skips cwd inference and search fallback)',
    }),
  ),
  yolo: Type.Optional(
    Type.Boolean({
      description:
        'Run /flow phases without confirmation gates (personal mode only — work-mode runs refuse yolo at loop start). Only applies when the --yolo flag is absent on the /flow invocation — an explicit flag wins over config',
    }),
  ),
  viewerPlacement: Type.Optional(
    Type.Union(
      [
        Type.Literal('right'),
        Type.Literal('below'),
        Type.Literal('left'),
        Type.Literal('above'),
        Type.Literal('tab'),
      ],
      {
        description:
          'Default Herdr pane placement for /flow-view when no placement argument is given',
      },
    ),
  ),
  landTestCommand: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Argv of the test command flow_land runs before authorizing a landing (default ["bun","run","test"]). PMR-05HX: the landing gate never trusts a claimed-green suite.',
      minItems: 1,
    }),
  ),
  telemetry: Type.Optional(
    Type.Object(
      {
        enabled: Type.Boolean({
          description:
            'Master switch — telemetry subscribes to nothing when false/absent (PMR-R8AG)',
        }),
        // AIDEV-NOTE: PMR-VSST — `otlpEndpoint` is schema-OPTIONAL so a
        // loki-only config (telemetry.enabled false + telemetry.loki.enabled
        // true) parses without an OTLP base. The surviving coupling —
        // enabled true REQUIRES the endpoint — is an explicit check at the
        // readConfigFile boundary below (a TypeBox union could express it
        // but wrecks the error messages and the checked-in JSON mirror).
        otlpEndpoint: Type.Optional(
          Type.String({
            description:
              'OTLP/HTTP base URL (e.g. https://host:4478); spans POST to <endpoint>/v1/traces. Required when telemetry.enabled is true (PMR-VSST); omit for a loki-only setup',
          }),
        ),
        headers: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description:
              'Static extra headers for OTLP export. Secrets belong in env (PI_FLOW_OTLP_TOKEN), not config',
          }),
        ),
        captureContent: Type.Optional(
          Type.Union(
            [
              Type.Literal('off'),
              Type.Literal('text'),
              Type.Literal('tools'),
              Type.Literal('all'),
            ],
            {
              description:
                'Content captured on spans (cumulative): off = metadata only (default), text = assistant text, tools = + tool calls the model made and tool input/output, all = + model reasoning. Captured content can contain secrets and lands in the trace backend',
            },
          ),
        ),
        jiraBaseUrl: Type.Optional(
          Type.String({
            description:
              'Base URL for Jira issue links, e.g. https://example.atlassian.net/browse/ — work-mode spans then carry flow.url = <base><jira key> so dashboards can link tickets. Absent = no links',
          }),
        ),
        maxContentChars: Type.Optional(
          Type.Integer({
            minimum: 100,
            maximum: 100000,
            description:
              'Max characters per captured content attribute (default 2000). Tempo truncates attribute values beyond max_attribute_bytes (default 2048) silently — raise both together',
          }),
        ),
        // AIDEV-NOTE: PMR-ZV9Y (4.2) — `telemetry.loki` gates the Loki
        // transition-event stream (telemetry/loki.ts). SINGLE STRICT READER,
        // session-side ONLY (do not add a tolerant daemon half): unlike
        // `reconcile`/`liveness` (TWO READERS, ONE FILE), the daemon never
        // pushes Loki — only the live session fan-out (subtask 4.3) does, so
        // there is exactly one reader here (this schema, via readConfigFile,
        // which throws on a malformed shape — AGENTS.md: never silent
        // defaults). `enabled` defaults to false: absent/disabled = ZERO Loki
        // network calls. `endpoint` stores the base URL only (user-provided,
        // e.g. http://loki.example.com:3100); the pusher appends
        // /loki/api/v1/push (D2). `headers` are static extra headers (Bearer
        // token belongs in env, never config). Free text (note/halt prose) is
        // NEVER a label — it rides the JSON line (ISC-A-1).
        loki: Type.Optional(
          Type.Object(
            {
              enabled: Type.Optional(
                Type.Boolean({
                  description:
                    'Push flow transition-event streams to Loki. Default false (disabled — zero network calls)',
                  default: false,
                }),
              ),
              endpoint: Type.Optional(
                Type.String({
                  description:
                    'Loki base URL (user-provided, e.g. http://loki.example.com:3100); events POST to <endpoint>/loki/api/v1/push. Required with telemetry.loki.enabled',
                }),
              ),
              headers: Type.Optional(
                Type.Record(Type.String(), Type.String(), {
                  description:
                    'Static extra headers for the Loki push. Secrets belong in env, not config',
                }),
              ),
            },
            {
              description:
                'Optional Loki transition-event stream, session-side only (PMR-ZV9Y 4.2)',
            },
          ),
        ),
      },
      { description: 'Optional OTLP telemetry export (PMR-R8AG)' },
    ),
  ),
  // AIDEV-NOTE: PMR-ZV9Y (5.2) — `notify` gates the flow-side DESKTOP
  // notification channel (telemetry/dispatch.ts createNotifySink). SINGLE
  // STRICT READER, session-side ONLY (same posture as `telemetry.loki`, unlike
  // the TWO-READER `reconcile`/`liveness` blocks): the daemon has no notify
  // path, only the live session fan-out pages, so exactly one reader exists
  // (this schema via readConfigFile, which throws on a malformed shape).
  // DEFAULT TRUE — the channel is opt-OUT, so a fresh install pages on a
  // waiting_human run instead of silently notifying nobody. pi-flow's switch
  // gates the FLOW-side page only; the user's own channel toggles
  // (desktop/herdr/ntfy) keep living in pi-desktop-notify's config, and
  // Grafana alerting is the independent second channel with its own
  // pause/mute (PMR-ZV9Y D3).
  notify: Type.Optional(
    Type.Object(
      {
        desktop: Type.Optional(
          Type.Object(
            {
              enabled: Type.Optional(
                Type.Boolean({
                  description:
                    'Send a desktop notification on waiting_human / halted flow transitions through pi-desktop-notify. Default true (opt-out)',
                  default: true,
                }),
              ),
            },
            {
              description:
                'Desktop channel via @gtheys/pi-desktop-notify (optional dependency)',
            },
          ),
        ),
      },
      { description: 'Flow-state notifications (PMR-ZV9Y 5.2)' },
    ),
  ),
  runServer: Type.Optional(
    Type.Object(
      {
        enabled: Type.Optional(
          Type.Boolean({
            description:
              'Kill switch for the durable run server (PMR-XTQQ). false = never spawn the daemon and journal writers permanently use today\u2019s full in-session path. Default true',
          }),
        ),
      },
      { description: 'Durable run server (daemon) settings' },
    ),
  ),
  // AIDEV-NOTE: PMR-MSDJ (2.1, plan PMR-V36Y decision 4) — `reconcile` is the
  // pushgateway liveness-retire switch. TWO READERS, ONE FILE, DELIBERATE
  // SPLIT (do not "unify" them):
  //   • extension side (this schema + resolveReconcileSettings): strict —
  //     an invalid shape throws at the readConfigFile boundary (AGENTS.md:
  //     never silent defaults).
  //   • daemon side (flow/reconcile.ts parseReconcileSettings): tolerant —
  //     server/daemon.ts must stay node-only (no pi-coding-agent import), so
  //     it reads the GLOBAL file as raw text and falls back to the same
  //     defaults with a warning instead of throwing.
  // Both agree on enabled=true / intervalMinutes=360; the split only changes
  // what happens on a MALFORMED file (extension: loud throw, daemon: defaults
  // + warning). The daemon has no session cwd, so it never sees project
  // overrides — the manual /flow-reconcile-push command is the escape hatch.
  // Unknown keys are NOT rejected by either reader (Value.Check does not
  // enforce additionalProperties — true for the whole schema), so a stray key
  // is silently ignored on both paths.
  reconcile: Type.Optional(
    Type.Object(
      {
        enabled: Type.Optional(
          Type.Boolean({
            description:
              'Reconcile stale run-liveness metrics (tombstone the v2 pi_flow_state series whose aven ticket is not live (neither active nor todo): state halted/waiting_human/waiting_machine becomes stale). Default true',
          }),
        ),
        intervalMinutes: Type.Optional(
          Type.Integer({
            minimum: 1,
            description:
              'Daemon reconcile interval in minutes. Default 360 (6h)',
          }),
        ),
      },
      { description: 'Pushgateway liveness reconcile (PMR-V36Y)' },
    ),
  ),
  // AIDEV-NOTE: PMR-8MQH (4.1) — `liveness` is the running-flow liveness-push
  // switch. Same TWO READERS, ONE FILE, DELIBERATE SPLIT as `reconcile` above
  // (do not "unify" them):
  //   • extension side (this schema + resolveLivenessSettings): strict — an
  //     invalid shape throws at the readConfigFile boundary (AGENTS.md: never
  //     silent defaults).
  //   • daemon side (flow/liveness.ts parseLivenessSettings): tolerant —
  //     server/daemon.ts must stay node-only (no pi-coding-agent import), so
  //     it reads the GLOBAL file as raw text and falls back to the same
  //     defaults with a warning instead of throwing.
  // Both agree on enabled=true / intervalMinutes=5; the defaults are pinned
  // equal in test/config.test.ts against DEFAULT_LIVENESS_SETTINGS so the two
  // readers cannot drift. The daemon has no session cwd, so it sees only the
  // GLOBAL config — project overrides are invisible to it by design.
  // Unknown keys are NOT rejected by either reader (Value.Check does not
  // enforce additionalProperties — true for the whole schema), so a stray key
  // is silently ignored on both paths.
  liveness: Type.Optional(
    Type.Object(
      {
        enabled: Type.Optional(
          Type.Boolean({
            description:
              'Push run-liveness metrics for flows in flight. Default true',
          }),
        ),
        intervalMinutes: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: 'Daemon liveness push interval in minutes. Default 5',
          }),
        ),
      },
      {
        description: 'Run-liveness pushes while flows are in flight (PMR-8MQH)',
      },
    ),
  ),
})

export type PiFlowConfig = Static<typeof PiFlowConfigSchema>

// AIDEV-NOTE: PMR-JP37 (3.3) — persists viewerPlacement to the GLOBAL config
// (<agentDir>/pi-flow/config.json). Best-effort by contract: the /flow-view
// handler warns and still opens the pane if this throws. A present-but-
// malformed existing file throws via the same Value.Check contract as
// readConfigFile so a bad config is never clobbered; a valid file that merely
// lacks viewerPlacement is merged in-place, preserving all other keys
// (including unknown ones — the merged object is NOT re-validated).
export async function saveViewerPlacement(
  agentDir: string,
  placement: 'right' | 'below' | 'left' | 'above' | 'tab',
): Promise<string> {
  const file = path.join(agentDir, 'pi-flow', 'config.json')
  const existing = await readConfigFile(file)
  const merged: Record<string, unknown> = { ...existing }
  // workRoots is required by PiFlowConfigSchema — a fresh config must carry the
  // empty default so the file is valid on the next read.
  if (merged.workRoots === undefined) merged.workRoots = []
  merged.viewerPlacement = placement
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return file
}

export async function readConfigFile(
  file: string,
): Promise<Partial<PiFlowConfig>> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {}
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read pi-flow config ${file}: ${msg}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`pi-flow config ${file} is not valid JSON: ${msg}`)
  }
  if (!Value.Check(PiFlowConfigSchema, parsed)) {
    const errors = Value.Errors(PiFlowConfigSchema, parsed)
      // AIDEV-NOTE: include the property path so enum/shape errors name the
      // offending key (e.g. viewerPlacement) instead of bare "equal to constant".
      .map((e) => {
        let text = e.message
        if (e.instancePath !== '/') text = `${e.instancePath}: ${text}`
        return text
      })
      .join('; ')
    throw new Error(`pi-flow config ${file} is invalid: ${errors}`)
  }
  // AIDEV-NOTE: PMR-VSST — the surviving OTLP coupling, enforced at the same
  // strict boundary as the schema check above (never silent defaults):
  // telemetry.enabled true without otlpEndpoint is invalid. Kept out of the
  // schema so a loki-only config (enabled false + telemetry.loki) parses —
  // see the AIDEV-NOTE on the otlpEndpoint property.
  if (
    parsed.telemetry?.enabled === true &&
    parsed.telemetry.otlpEndpoint === undefined
  ) {
    throw new Error(
      `pi-flow config ${file} is invalid: telemetry.otlpEndpoint is required when telemetry.enabled is true`,
    )
  }
  return parsed
}

// AIDEV-NOTE: Global getAgentDir()/pi-flow/config.json, then project override
// ctx.cwd/CONFIG_DIR_NAME/pi-flow/config.json wins. Missing files = empty
// merge; present-but-invalid = throw.
//
// PMR-BF8W: herdr worktree bootstrap copies only .env*, so a linked git
// worktree has no .pi/pi-flow/config.json and a stale global landTestCommand
// (e.g. ["cargo","test"] left over for another project) silently won the
// flow_land gate. When cwd sits in a LINKED worktree (git rev-parse
// --git-common-dir points outside the worktree's own .git), the main
// checkout's project config is consulted as a middle layer:
//   global < main checkout project < worktree-local project (nearest wins)
// Main-checkout behavior is unchanged (project wins over global). The git
// lookup is best-effort: outside a repo or on git failure the layer is simply
// absent. Present-but-invalid config files still throw via readConfigFile —
// never silent defaults (AGENTS.md rule).
const execFileAsync = promisify(execFile)

// Absolute path of the main checkout that owns the linked worktree containing
// cwd, or undefined when cwd is not inside a linked worktree (plain checkout,
// non-git dir, git unavailable/failed).
async function mainCheckoutRoot(cwd: string): Promise<string | undefined> {
  try {
    const toplevel = (
      await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd })
    ).stdout.trim()
    const commonDir = (
      await execFileAsync('git', ['rev-parse', '--git-common-dir'], { cwd })
    ).stdout.trim()
    // Resolve both against cwd (git prints relative paths when cwd is the
    // repo root) so the comparison is stable for any nesting depth.
    const resolvedCommon = path.resolve(cwd, commonDir)
    const ownGitDir = path.resolve(toplevel, '.git')
    if (resolvedCommon === ownGitDir) return undefined
    return path.dirname(resolvedCommon)
  } catch {
    return undefined
  }
}

/**
 * AIDEV-NOTE: PMR-XTQQ — the runServer.enabled kill-switch contract (plan
 * decision 9): absent/true → durable run server enabled; explicit false →
 * the probe reports absent, ensureDaemon never spawns, and the pending
 * consumer stays off — from extension init (session_start sync) through
 * every /flow start. Pure so the derivation is pinned by tests.
 */
export function resolveRunServerEnabled(config: PiFlowConfig): boolean {
  return config.runServer?.enabled !== false
}

/**
 * AIDEV-NOTE: PMR-MSDJ (2.1) — typed read of the `reconcile` block with the
 * SAME defaults as `flow/reconcile.ts` parseReconcileSettings (enabled=true,
 * intervalMinutes=360). Keep the two in sync; the defaults are pinned by
 * test/config.test.ts. Malformedness cannot reach here on the extension path
 * (readConfigFile throws first); on the daemon path parseReconcileSettings
 * handles it. Takes Partial so readConfigFile's return type plugs straight in.
 */
export function resolveReconcileSettings(config: Partial<PiFlowConfig>): {
  enabled: boolean
  intervalMinutes: number
} {
  const settings = {
    enabled: true,
    intervalMinutes: 360,
  }
  if (config.reconcile?.enabled !== undefined) {
    settings.enabled = config.reconcile.enabled
  }
  if (config.reconcile?.intervalMinutes !== undefined) {
    settings.intervalMinutes = config.reconcile.intervalMinutes
  }
  return settings
}

/**
 * AIDEV-NOTE: PMR-8MQH (4.1) — typed read of the `liveness` block with the
 * SAME defaults as `flow/liveness.ts` DEFAULT_LIVENESS_SETTINGS /
 * parseLivenessSettings (enabled=true, intervalMinutes=5). Keep the two in
 * sync; the equality is pinned by test/config.test.ts. Malformedness cannot
 * reach here on the extension path (readConfigFile throws first); on the
 * daemon path parseLivenessSettings handles it. Takes Partial so
 * readConfigFile's return type plugs straight in.
 */
export function resolveLivenessSettings(config: Partial<PiFlowConfig>): {
  enabled: boolean
  intervalMinutes: number
} {
  const settings = {
    enabled: true,
    intervalMinutes: 5,
  }
  if (config.liveness?.enabled !== undefined) {
    settings.enabled = config.liveness.enabled
  }
  if (config.liveness?.intervalMinutes !== undefined) {
    settings.intervalMinutes = config.liveness.intervalMinutes
  }
  return settings
}

/**
 * AIDEV-NOTE: PMR-ZV9Y (4.2) — typed read of the session-side `telemetry.loki`
 * block. SINGLE STRICT READER (no daemon/tolerant half — the daemon never
 * pushes Loki, see the AIDEV-NOTE on the schema block): an invalid shape
 * throws at the readConfigFile boundary before this is ever reached.
 * Defaults: disabled (`enabled` absent/false → resolveLokiSettings.enabled
 * false = ZERO Loki network calls), empty endpoint, empty headers. The
 * `LokiSettings` this returns plugs straight into telemetry/loki.ts
 * pushLokiEvent. Takes Partial so readConfigFile's return type plugs in.
 */
export function resolveLokiSettings(config: Partial<PiFlowConfig>): {
  enabled: boolean
  endpoint: string
  headers: Record<string, string>
} {
  const loki = config.telemetry?.loki
  const settings = {
    enabled: false,
    endpoint: '',
    headers: {} as Record<string, string>,
  }
  if (loki?.enabled !== undefined) settings.enabled = loki.enabled
  if (loki?.endpoint !== undefined) settings.endpoint = loki.endpoint
  if (loki?.headers !== undefined) settings.headers = { ...loki.headers }
  return settings
}

/**
 * AIDEV-NOTE: PMR-ZV9Y (5.2) — typed read of the session-side `notify`
 * block. SINGLE STRICT READER, no daemon/tolerant half (the daemon has no
 * notify path — see the AIDEV-NOTE on the schema block): a malformed shape
 * throws at the readConfigFile boundary before this is ever reached.
 * DEFAULT: `desktop.enabled` ABSENT resolves TRUE — the flow-side desktop
 * channel is opt-OUT (the opposite of `telemetry.loki`, which is opt-IN), so a
 * fresh install pages on a waiting_human/halted transition. Takes Partial so
 * readConfigFile's return type plugs straight in; the returned object is
 * freshly built, never aliased to the config.
 */
export function resolveNotifySettings(config: Partial<PiFlowConfig>): {
  desktop: { enabled: boolean }
} {
  const settings = { desktop: { enabled: true } }
  const enabled = config.notify?.desktop?.enabled
  if (enabled !== undefined) settings.desktop.enabled = enabled
  return settings
}

/**
 * AIDEV-NOTE: PMR-1QKY — provenance-preserving loadConfig variant: records
 * which config layer (global / main checkout project / project) LAST supplied
 * each merged key, so flow_land can name the winning file in the land-test
 * source label. Merge order and semantics are identical to loadConfig (see
 * the PMR-BF8W note below); the layer strings double as the label fragments
 * shown to the user, so keep them human-readable.
 */
export type ConfigOrigin = 'global' | 'main checkout project' | 'project'

export interface LoadedConfig {
  config: PiFlowConfig
  /** Layer that last supplied each key (Object.assign last-writer-wins). */
  origins: Partial<Record<keyof PiFlowConfig, ConfigOrigin>>
}

/** One Object.assign layer of the loadConfig merge, with provenance. */
function mergeLayer(
  merged: PiFlowConfig,
  origins: LoadedConfig['origins'],
  origin: ConfigOrigin,
  layer: Partial<PiFlowConfig>,
): void {
  Object.assign(merged, layer)
  for (const key of Object.keys(layer) as Array<keyof PiFlowConfig>) {
    origins[key] = origin
  }
}

export async function loadConfigWithOrigins(
  cwd: string,
): Promise<LoadedConfig> {
  const globalPath = path.join(getAgentDir(), 'pi-flow', 'config.json')
  const projectPath = path.join(cwd, CONFIG_DIR_NAME, 'pi-flow', 'config.json')
  const mainRoot = await mainCheckoutRoot(cwd)
  let mainPath: string | undefined
  if (mainRoot === undefined) mainPath = undefined
  else mainPath = path.join(mainRoot, CONFIG_DIR_NAME, 'pi-flow', 'config.json')
  const merged: PiFlowConfig = { workRoots: [] }
  const origins: LoadedConfig['origins'] = {}
  mergeLayer(merged, origins, 'global', await readConfigFile(globalPath))
  if (mainPath !== undefined) {
    mergeLayer(
      merged,
      origins,
      'main checkout project',
      await readConfigFile(mainPath),
    )
  }
  mergeLayer(merged, origins, 'project', await readConfigFile(projectPath))
  return { config: merged, origins }
}

export async function loadConfig(cwd: string): Promise<PiFlowConfig> {
  return (await loadConfigWithOrigins(cwd)).config
}

export async function resolveMode(
  pi: ExtensionAPI,
  cwd?: string,
): Promise<WorkMode> {
  const { stdout } = await pi.exec('git', ['rev-parse', '--show-toplevel'], {})
  const toplevel = stdout.trim()
  // AIDEV-NOTE: session cwd, not process.cwd() — see avenOverrideArg note in
  // aven/client.ts.
  const config = await loadConfig(cwd ?? process.cwd())
  return modeForToplevel(toplevel, config.workRoots)
}
