/**
 * Test Runner Extension
 *
 * Provides a `run_tests` tool and `/run-tests` command that:
 *   - Discover test scripts from the nearest package.json
 *   - Spawn a fully-detached pi subagent with its own session file
 *   - Use pi-intercom contact_supervisor as the sole result channel
 *   - Allow switching into the subagent session to watch the live transcript
 *
 * Commands:
 *   /run-tests [script]   — run tests (no LLM turn, truly non-blocking)
 *   /test-runner switch   — jump into the most recent test session
 *   /test-runner back     — return to the session you came from
 *   /test-runner model    — configure the subagent model
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Container, Text } from '@earendil-works/pi-tui'
import { Type } from '@sinclair/typebox'
import { buildRunCommand, discoverTestScripts } from './discover.ts'
import { generateSessionFile, spawnTestSubagent } from './runner.ts'

// AIDEV-NOTE: Config is persisted to ~/.pi/agent/test-runner/config.json so it
// survives new sessions. pi.appendEntry() is NOT used — that is session-scoped only.
interface TestRunnerConfig {
  defaultModel?: string
  /** Session to return to after /test-runner back. */
  previousSession?: string
}

// AIDEV-NOTE: TestRun is in-memory only (process lifetime). We don’t persist
// the run list — the session files themselves are the persistent record.
interface TestRun {
  runId: string
  sessionFile: string
  script: string
  command: string
  cwd: string
  started: number
}

// AIDEV-NOTE: Config is persisted to ~/.pi/agent/test-runner/config.json so it
// survives new sessions. pi.appendEntry() is NOT used — that is session-scoped only.
interface TestRunnerConfig {
  defaultModel?: string
}

function getConfigPath(): string {
  return path.join(getAgentDir(), 'test-runner', 'config.json')
}

function loadConfig(): TestRunnerConfig {
  try {
    return JSON.parse(
      fs.readFileSync(getConfigPath(), 'utf-8'),
    ) as TestRunnerConfig
  } catch {
    return {}
  }
}

function saveConfig(config: TestRunnerConfig): void {
  const configPath = getConfigPath()
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export default function (pi: ExtensionAPI) {
  let config: TestRunnerConfig = loadConfig()
  // AIDEV-NOTE: activeRuns is in-memory. Session files are the persistent record.
  const activeRuns: TestRun[] = []

  pi.on('session_start', async () => {
    config = loadConfig()
  })

  /**
   * Resolve the pi-intercom target the spawned child should send
   * contact_supervisor messages back to.
   *
   * AIDEV-NOTE: The intercom broker does NOT key sessions by the pi session UUID.
   * On connect it generates its own random UUID and registers each session under
   * that, plus the session's *presence name*. Broker.findSessions() resolves a
   * target by broker-id first, then by presence name (case-insensitive).
   *
   * The broker-id is not reachable from here, but the presence name is stable and
   * is pushed to the broker at registration (session_start) and re-synced on every
   * turn_start — both happen before any child is spawned. So we target the presence
   * name, which mirrors pi-intercom's resolveIntercomPresenceName():
   *   - named session  → its display name (pi.getSessionName())
   *   - unnamed session → `subagent-chat-<first 8 chars of pi session id>`
   *
   * Targeting the pi session UUID (ctx.sessionManager.getSessionId()) does NOT work
   * — the broker doesn't know it, and the send fails with "Session not found".
   * We deliberately do NOT call setSessionName() here: a name set mid-turn is not
   * synced until the next turn_start, so a freshly-set random name would be
   * unresolvable by the child. Reading the existing identity is race-free.
   */
  function resolveSupervisorTarget(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
  ): string {
    const displayName = pi.getSessionName()?.trim()
    if (displayName) return displayName
    const piSessionId = ctx.sessionManager.getSessionId()
    let normalized: string
    if (piSessionId.startsWith('session-')) {
      normalized = piSessionId.slice('session-'.length)
    } else {
      normalized = piSessionId
    }
    return `subagent-chat-${normalized.slice(0, 8)}`
  }

  /** Shared spawn logic used by the tool and both commands. */
  function startRun(
    script: string,
    command: string,
    runDir: string,
    supervisorTarget: string | undefined,
    model: string | undefined,
  ): TestRun {
    const runId = randomUUID().slice(0, 8)
    const sessionFile = generateSessionFile(getAgentDir(), runId)
    const run: TestRun = {
      runId,
      sessionFile,
      script,
      command,
      cwd: runDir,
      started: Date.now(),
    }
    activeRuns.push(run)
    spawnTestSubagent({
      command,
      cwd: runDir,
      runId,
      sessionFile,
      supervisorTarget,
      model,
    })
    return run
  }

  // AIDEV-NOTE: Shared discovery + picker logic used by /test-runner (default) and /run-tests.
  async function resolveAndRun(
    scriptKey: string,
    cwd: string,
    ctx: Parameters<Parameters<typeof pi.registerCommand>[1]['handler']>[1],
  ): Promise<void> {
    const { scripts, packageDir } = discoverTestScripts(cwd)
    if (scripts.length === 0) {
      ctx.ui.notify(
        `No test scripts found in package.json (searched from ${cwd})`,
        'warning',
      )
      return
    }

    const runDir = packageDir ?? cwd
    let selected: (typeof scripts)[0] | undefined

    if (scriptKey) {
      selected = scripts.find((s) => s.key === scriptKey)
      if (!selected) {
        ctx.ui.notify(
          `Script "${scriptKey}" not found. Available: ${scripts.map((s) => s.key).join(', ')}`,
          'warning',
        )
        return
      }
    } else if (scripts.length === 1) {
      selected = scripts[0]
    } else if (ctx.hasUI) {
      const choices = scripts.map((s) => `${s.key}: ${s.command}`)
      const choice = await ctx.ui.select('Which test script to run?', choices)
      if (!choice) return
      selected =
        scripts[scripts.findIndex((s) => `${s.key}: ${s.command}` === choice)]
    } else {
      selected = scripts[0]
    }

    if (!selected) return

    const command = buildRunCommand(selected.key, runDir)
    const supervisorTarget = resolveSupervisorTarget(pi, ctx)

    const run = startRun(
      selected.key,
      command,
      runDir,
      supervisorTarget,
      config.defaultModel,
    )
    ctx.ui.notify(
      `Tests started: ${command}\n/test-runner switch to watch  •  /test-runner back to return`,
      'info',
    )
    // Keep the session file path accessible in the notification for reference
    ctx.ui.setStatus('test-runner', `⏳ ${selected.key} — ${run.runId}`)
  }

  pi.registerTool({
    name: 'run_tests',
    label: 'Run Tests',
    description: [
      'Discover and run JS/TS test scripts from the nearest package.json.',
      'Spawns an isolated subagent (bash-only) to run the tests and report structured pass/fail results.',
      'Uses pi-intercom contact_supervisor for live progress updates when pi-intercom is installed.',
    ].join(' '),
    promptSnippet:
      'Run JS/TS tests from package.json and return structured failures',
    parameters: Type.Object({
      model: Type.Optional(
        Type.String({
          description:
            "Model ID for the subagent (e.g. 'claude-haiku-4-5'). Overrides the configured default.",
        }),
      ),
      script: Type.Optional(
        Type.String({
          description:
            "Test script key from package.json (e.g. 'test', 'test:unit'). Auto-detected if omitted.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            'Working directory to search for package.json. Defaults to the current project directory.',
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = params.cwd ?? ctx.cwd
      const { scripts, packageDir } = discoverTestScripts(workDir)

      if (scripts.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No test scripts found in package.json (searched from ${workDir})`,
            },
          ],
          details: { found: false },
        }
      }

      const runDir = packageDir ?? workDir

      // Resolve which script to run
      let selected: ReturnType<typeof scripts.find>
      if (params.script) {
        selected = scripts.find((s) => s.key === params.script)
      }

      if (!selected && scripts.length > 1 && ctx.hasUI) {
        const choices = scripts.map((s) => `${s.key}: ${s.command}`)
        const choice = await ctx.ui.select('Which test script to run?', choices)
        if (!choice) {
          return {
            content: [{ type: 'text', text: 'Cancelled' }],
            details: { cancelled: true },
          }
        }
        selected =
          scripts[scripts.findIndex((s) => `${s.key}: ${s.command}` === choice)]
      }

      selected ??= scripts[0]

      const command = buildRunCommand(selected.key, runDir)

      const supervisorTarget = resolveSupervisorTarget(pi, ctx)

      const run = startRun(
        selected.key,
        command,
        runDir,
        supervisorTarget,
        params.model ?? config.defaultModel,
      )

      return {
        content: [
          {
            type: 'text',
            text: [
              `Tests started: \`${command}\``,
              `Session: ${run.sessionFile}`,
              `Use /test-runner switch to watch the live transcript, /test-runner back to return.`,
            ].join('\n'),
          },
        ],
        details: {
          running: true,
          script: selected.key,
          command,
          cwd: runDir,
          sessionFile: run.sessionFile,
          runId: run.runId,
        },
      }
    },

    renderCall(args, theme) {
      const script = args.script ?? 'auto-detect'
      let cwdSuffix: string
      if (args.cwd) {
        cwdSuffix = theme.fg('muted', ` in ${args.cwd}`)
      } else {
        cwdSuffix = ''
      }
      return new Text(
        theme.fg('toolTitle', theme.bold('run_tests ')) +
          theme.fg('accent', script) +
          cwdSuffix,
        0,
        0,
      )
    },

    renderResult(result, _opts, theme) {
      type Details = {
        script?: string
        command?: string
        running?: boolean
        found?: boolean
        cancelled?: boolean
        sessionFile?: string
        runId?: string
      }

      const details = result.details as Details | undefined
      const t = result.content[0]
      let text: string
      if (t?.type === 'text') {
        text = t.text
      } else {
        text = '(no output)'
      }

      if (!details || details.found === false || details.cancelled) {
        return new Text(theme.fg('muted', text), 0, 0)
      }

      if (details.running) {
        const container = new Container()
        container.addChild(
          new Text(
            theme.fg('warning', '⏳ ') +
              theme.fg('accent', details.script ?? 'tests') +
              theme.fg('muted', ' running in background'),
            0,
            0,
          ),
        )
        if (details.sessionFile) {
          container.addChild(
            new Text(
              theme.fg(
                'dim',
                `   /test-runner switch to watch  •  /test-runner back to return`,
              ),
              0,
              0,
            ),
          )
        }
        return container
      }

      return new Text(theme.fg('muted', text), 0, 0)
    },
  })

  // AIDEV-NOTE: /run-tests runs tests WITHOUT going through the LLM at all.
  // Command handlers have no agent turn — fire-and-forget here truly means
  // the session stays idle while tests run and after results arrive.
  // Results are injected into the transcript via pi.sendMessage(display:true)
  // without triggerTurn, so the user decides whether to ask the LLM to act.
  pi.registerCommand('run-tests', {
    description: 'Alias for /test-runner — run test scripts from package.json',
    handler: async (args, ctx) => {
      await resolveAndRun(args.trim(), ctx.cwd, ctx)
    },
  })

  // AIDEV-NOTE: /test-runner handles config, session switching, and run listing.
  // switch/back use ctx.switchSession() which is only available in command handlers.
  pi.registerCommand('test-runner', {
    description: 'Manage test-runner: switch | back | model | reset',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0]

      // ── switch ──────────────────────────────────────────────────────────────
      if (sub === 'switch') {
        if (activeRuns.length === 0) {
          ctx.ui.notify('No test runs started in this session.', 'warning')
          return
        }

        let run: TestRun
        if (activeRuns.length === 1) {
          run = activeRuns[0]
        } else {
          const age = (r: TestRun) => {
            const secs = Math.round((Date.now() - r.started) / 1000)
            if (secs < 60) {
              return `${secs}s ago`
            }
            return `${Math.round(secs / 60)}m ago`
          }
          const choices = activeRuns.map(
            (r) => `${r.script} — ${r.command} (${age(r)})`,
          )
          const choice = await ctx.ui.select('Switch to test session:', choices)
          if (!choice) return
          run =
            activeRuns[
              activeRuns.findIndex(
                (r) => `${r.script} — ${r.command} (${age(r)})` === choice,
              )
            ]
        }

        // Store current session so /test-runner back can return here.
        const currentFile = ctx.sessionManager.getSessionFile()
        if (currentFile) {
          config.previousSession = currentFile
          saveConfig(config)
        }

        ctx.ui.notify(`Switching to test session: ${run.script}`, 'info')
        await ctx.switchSession(run.sessionFile)
        return
      }

      // ── back ────────────────────────────────────────────────────────────────
      if (sub === 'back') {
        if (!config.previousSession) {
          ctx.ui.notify(
            'No previous session stored. Use /resume to pick one.',
            'warning',
          )
          return
        }
        await ctx.switchSession(config.previousSession)
        return
      }

      // ── model ───────────────────────────────────────────────────────────────
      if (sub === 'model') {
        const modelId = parts[1]
        if (!modelId) {
          let modelMsg: string
          if (config.defaultModel) {
            modelMsg = `test-runner default model: ${config.defaultModel}`
          } else {
            modelMsg = 'test-runner default model: (pi default)'
          }
          ctx.ui.notify(modelMsg, 'info')
          return
        }
        config.defaultModel = modelId
        saveConfig(config)
        ctx.ui.notify(`test-runner default model set to: ${modelId}`, 'info')
        return
      }

      // ── reset ───────────────────────────────────────────────────────────────
      if (sub === 'reset') {
        config = {}
        saveConfig(config)
        ctx.ui.notify('test-runner config reset', 'info')
        return
      }

      // ── status ─────────────────────────────────────────────────────────────
      if (sub === 'status') {
        const lines = ['test-runner status:']
        lines.push(`  model: ${config.defaultModel ?? '(pi default)'}`)
        if (activeRuns.length > 0) {
          lines.push('')
          lines.push('Active runs this session:')
          for (const r of activeRuns) {
            const secs = Math.round((Date.now() - r.started) / 1000)
            let age: string
            if (secs < 60) {
              age = `${secs}s`
            } else {
              age = `${Math.round(secs / 60)}m`
            }
            lines.push(`  ${r.script} (${age}) — ${r.runId}`)
          }
        }
        lines.push('')
        lines.push('/test-runner switch | back | model | reset | status')
        ctx.ui.notify(lines.join('\n'), 'info')
        return
      }
      // ── default: run tests ────────────────────────────────────────────────
      // /test-runner [script-key] starts a test run.
      // Unrecognised subcommands are treated as script keys (e.g. /test-runner test:unit).
      await resolveAndRun(args.trim(), ctx.cwd, ctx)
    },
  })
}
