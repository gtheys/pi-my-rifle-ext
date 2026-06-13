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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { buildRunCommand, discoverTestScripts } from "./discover.ts";
import { spawnTestSubagent, generateSessionFile } from "./runner.ts";

// AIDEV-NOTE: Config is persisted to ~/.pi/agent/test-runner/config.json so it
// survives new sessions. pi.appendEntry() is NOT used — that is session-scoped only.
interface TestRunnerConfig {
  defaultModel?: string;
  /** Session to return to after /test-runner back. */
  previousSession?: string;
}

// AIDEV-NOTE: TestRun is in-memory only (process lifetime). We don’t persist
// the run list — the session files themselves are the persistent record.
interface TestRun {
  runId: string;
  sessionFile: string;
  script: string;
  command: string;
  cwd: string;
  started: number;
}

// AIDEV-NOTE: Config is persisted to ~/.pi/agent/test-runner/config.json so it
// survives new sessions. pi.appendEntry() is NOT used — that is session-scoped only.
interface TestRunnerConfig {
  defaultModel?: string;
}

function getConfigPath(): string {
  return path.join(getAgentDir(), "test-runner", "config.json");
}

function loadConfig(): TestRunnerConfig {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf-8")) as TestRunnerConfig;
  } catch {
    return {};
  }
}

function saveConfig(config: TestRunnerConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export default function (pi: ExtensionAPI) {
  let config: TestRunnerConfig = loadConfig();
  // AIDEV-NOTE: activeRuns is in-memory. Session files are the persistent record.
  const activeRuns: TestRun[] = [];

  pi.on("session_start", async () => {
    config = loadConfig();
  });

  /** Shared spawn logic used by both the tool and the /run-tests command. */
  function startRun(
    script: string,
    command: string,
    runDir: string,
    supervisorTarget: string | undefined,
    model: string | undefined,
  ): TestRun {
    const runId = randomUUID().slice(0, 8);
    const sessionFile = generateSessionFile(getAgentDir(), runId);
    const run: TestRun = { runId, sessionFile, script, command, cwd: runDir, started: Date.now() };
    activeRuns.push(run);
    spawnTestSubagent({ command, cwd: runDir, runId, sessionFile, supervisorTarget, model });
    return run;
  }


  pi.registerTool({
    name: "run_tests",
    label: "Run Tests",
    description: [
      "Discover and run JS/TS test scripts from the nearest package.json.",
      "Spawns an isolated subagent (bash-only) to run the tests and report structured pass/fail results.",
      "Uses pi-intercom contact_supervisor for live progress updates when pi-intercom is installed.",
    ].join(" "),
    promptSnippet: "Run JS/TS tests from package.json and return structured failures",
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
            "Working directory to search for package.json. Defaults to the current project directory.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = params.cwd ?? ctx.cwd;
      const { scripts, packageDir } = discoverTestScripts(workDir);

      if (scripts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No test scripts found in package.json (searched from ${workDir})`,
            },
          ],
          details: { found: false },
        };
      }

      const runDir = packageDir ?? workDir;

      // Resolve which script to run
      let selected = params.script
        ? scripts.find((s) => s.key === params.script)
        : undefined;

      if (!selected && scripts.length > 1 && ctx.hasUI) {
        const choices = scripts.map((s) => `${s.key}: ${s.command}`);
        const choice = await ctx.ui.select("Which test script to run?", choices);
        if (!choice) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
            details: { cancelled: true },
          };
        }
        selected = scripts[scripts.findIndex((s) => `${s.key}: ${s.command}` === choice)];
      }

      selected ??= scripts[0];

      const command = buildRunCommand(selected.key, runDir);

      const existingName = pi.getSessionName();
      const supervisorTarget =
        existingName ?? `test-run-${Math.random().toString(36).slice(2, 10)}`;
      if (!existingName) pi.setSessionName(supervisorTarget);

      const run = startRun(selected.key, command, runDir, supervisorTarget, params.model ?? config.defaultModel);

      return {
        content: [
          {
            type: "text",
            text: [
              `Tests started: \`${command}\``,
              `Session: ${run.sessionFile}`,
              `Use /test-runner switch to watch the live transcript, /test-runner back to return.`,
            ].join("\n"),
          },
        ],
        details: { running: true, script: selected.key, command, cwd: runDir, sessionFile: run.sessionFile, runId: run.runId },
      };
    },

    renderCall(args, theme) {
      const script = args.script ?? "auto-detect";
      const cwdSuffix = args.cwd ? theme.fg("muted", ` in ${args.cwd}`) : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("run_tests ")) +
          theme.fg("accent", script) +
          cwdSuffix,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      type Details = {
        script?: string;
        command?: string;
        running?: boolean;
        found?: boolean;
        cancelled?: boolean;
        sessionFile?: string;
        runId?: string;
      };

      const details = result.details as Details | undefined;
      const t = result.content[0];
      const text = t?.type === "text" ? t.text : "(no output)";

      if (!details || details.found === false || details.cancelled) {
        return new Text(theme.fg("muted", text), 0, 0);
      }

      if (details.running) {
        const container = new Container();
        container.addChild(new Text(theme.fg("warning", "⏳ ") + theme.fg("accent", details.script ?? "tests") + theme.fg("muted", " running in background"), 0, 0));
        if (details.sessionFile) {
          container.addChild(new Text(theme.fg("dim", `   /test-runner switch to watch  •  /test-runner back to return`), 0, 0));
        }
        return container;
      }

      return new Text(theme.fg("muted", text), 0, 0);
    },

      if (details.command) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `$ ${details.command}`), 0, 0));
      }

      return container;
    },
  });

  // AIDEV-NOTE: /run-tests runs tests WITHOUT going through the LLM at all.
  // Command handlers have no agent turn — fire-and-forget here truly means
  // the session stays idle while tests run and after results arrive.
  // Results are injected into the transcript via pi.sendMessage(display:true)
  // without triggerTurn, so the user decides whether to ask the LLM to act.
  pi.registerCommand("run-tests", {
    description: "Run test scripts from the nearest package.json (non-blocking, no LLM turn)",
    handler: async (args, ctx) => {
      const workDir = ctx.cwd;
      const { scripts, packageDir } = discoverTestScripts(workDir);

      if (scripts.length === 0) {
        ctx.ui.notify(`No test scripts found in package.json (searched from ${workDir})`, "warn");
        return;
      }

      const runDir = packageDir ?? workDir;
      let selected: (typeof scripts)[0] | undefined;
      const scriptKey = args.trim();

      if (scriptKey) {
        selected = scripts.find((s) => s.key === scriptKey);
        if (!selected) {
          ctx.ui.notify(
            `Script "${scriptKey}" not found. Available: ${scripts.map((s) => s.key).join(", ")}`,
            "warn",
          );
          return;
        }
      } else if (scripts.length === 1) {
        selected = scripts[0];
      } else if (ctx.hasUI) {
        const choices = scripts.map((s) => `${s.key}: ${s.command}`);
        const choice = await ctx.ui.select("Which test script to run?", choices);
        if (!choice) return;
        selected = scripts[scripts.findIndex((s) => `${s.key}: ${s.command}` === choice)];
      } else {
        selected = scripts[0];
      }

      if (!selected) return;

      const command = buildRunCommand(selected.key, runDir);

      const existingName = pi.getSessionName();
      const supervisorTarget =
        existingName ?? `test-run-${Math.random().toString(36).slice(2, 10)}`;
      if (!existingName) pi.setSessionName(supervisorTarget);

      const run = startRun(selected.key, command, runDir, supervisorTarget, config.defaultModel);

      // AIDEV-NOTE: No triggerTurn — session stays idle. Results arrive via
      // pi-intercom contact_supervisor as inline messages in the main session.
      // Use /test-runner switch to watch the subagent transcript live.
      ctx.ui.notify(
        `Tests started: ${command}\nSession: ${run.sessionFile}\n/test-runner switch to watch • /test-runner back to return`,
        "info",
      );
    },
  });

  // AIDEV-NOTE: /test-runner handles config, session switching, and run listing.
  // switch/back use ctx.switchSession() which is only available in command handlers.
  pi.registerCommand("test-runner", {
    description: "Manage test-runner: switch | back | model | reset",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];

      // ── switch ──────────────────────────────────────────────────────────────
      if (sub === "switch") {
        if (activeRuns.length === 0) {
          ctx.ui.notify("No test runs started in this session.", "warn");
          return;
        }

        let run: TestRun;
        if (activeRuns.length === 1) {
          run = activeRuns[0];
        } else {
          const age = (r: TestRun) => {
            const secs = Math.round((Date.now() - r.started) / 1000);
            return secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
          };
          const choices = activeRuns.map(
            (r) => `${r.script} — ${r.command} (${age(r)})`,
          );
          const choice = await ctx.ui.select("Switch to test session:", choices);
          if (!choice) return;
          run = activeRuns[activeRuns.findIndex(
            (r) => `${r.script} — ${r.command} (${age(r)})` === choice,
          )];
        }

        // Store current session so /test-runner back can return here.
        const currentFile = ctx.sessionManager.getSessionFile();
        if (currentFile) {
          config.previousSession = currentFile;
          saveConfig(config);
        }

        ctx.ui.notify(`Switching to test session: ${run.script}`, "info");
        await ctx.switchSession(run.sessionFile);
        return;
      }

      // ── back ────────────────────────────────────────────────────────────────
      if (sub === "back") {
        if (!config.previousSession) {
          ctx.ui.notify("No previous session stored. Use /resume to pick one.", "warn");
          return;
        }
        await ctx.switchSession(config.previousSession);
        return;
      }

      // ── model ───────────────────────────────────────────────────────────────
      if (sub === "model") {
        const modelId = parts[1];
        if (!modelId) {
          ctx.ui.notify(
            config.defaultModel
              ? `test-runner default model: ${config.defaultModel}`
              : "test-runner default model: (pi default)",
            "info",
          );
          return;
        }
        config.defaultModel = modelId;
        saveConfig(config);
        ctx.ui.notify(`test-runner default model set to: ${modelId}`, "info");
        return;
      }

      // ── reset ───────────────────────────────────────────────────────────────
      if (sub === "reset") {
        config = {};
        saveConfig(config);
        ctx.ui.notify("test-runner config reset", "info");
        return;
      }

      // ── status / help ────────────────────────────────────────────────────────
      const lines = ["test-runner:"];
      if (activeRuns.length > 0) {
        lines.push("");
        lines.push("Active runs:");
        for (const r of activeRuns) {
          const secs = Math.round((Date.now() - r.started) / 1000);
          const age = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
          lines.push(`  ${r.script} (${age}) — ${r.sessionFile}`);
        }
      }
      lines.push("");
      lines.push("Commands:");
      lines.push("  /test-runner switch        switch into most recent test session");
      lines.push("  /test-runner back          return to previous session");
      lines.push("  /test-runner model <id>    set default subagent model");
      lines.push("  /test-runner model         show current model");
      lines.push("  /test-runner reset         clear all config");
      lines.push("");
      lines.push(`Config: ${config.defaultModel ? `model=${config.defaultModel}` : "(defaults)"}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}