/**
 * Test Runner Extension
 *
 * Provides a `run_tests` tool that:
 *   - Discovers test scripts from the nearest package.json
 *   - Prompts the user to select a script when multiple are found
 *   - Spawns an isolated pi subagent (bash-only) to execute the tests
 *   - Activates pi-intercom contact_supervisor in the subagent for live progress
 *   - Returns structured pass/fail results with per-failure details
 *
 * Command: /run-tests [script-key]
 *
 * Requires: pi-intercom installed (bundled as dep) for live progress updates.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { buildRunCommand, discoverTestScripts } from "./discover.ts";
import { runTestSubagent, type TestFailure, type TestRunResult } from "./runner.ts";

export default function (pi: ExtensionAPI) {
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

      // AIDEV-NOTE: The supervisor target is the pi session name registered with the
      // pi-intercom broker. The subagent reads PI_SUBAGENT_ORCHESTRATOR_TARGET and uses
      // it as the contact_supervisor destination. We use the existing session name if set,
      // otherwise assign one so the subagent can find us.
      const existingName = pi.getSessionName();
      const supervisorTarget =
        existingName ?? `test-run-${Math.random().toString(36).slice(2, 10)}`;
      if (!existingName) {
        pi.setSessionName(supervisorTarget);
      }

      // AIDEV-NOTE: Fire-and-forget — we do NOT await the subagent. The tool returns
      // immediately so the main session is unblocked. When the subagent finishes,
      // pi.sendMessage() injects the result back and triggerTurn re-engages the LLM.
      // We intentionally omit the abort signal so the background run survives agent turns.
      // Progress during the run comes via pi-intercom contact_supervisor messages.
      runTestSubagent({ command, cwd: runDir, supervisorTarget })
        .then((result) => {
          const summary = buildSummaryText(selected!.key, command, result);
          const icon = result.failed > 0 || result.exitCode !== 0 ? "⚠️" : "✅";
          pi.sendMessage(
            {
              customType: "test-runner-complete",
              content: `${icon} Test run complete (\`${selected!.key}\`):\n\n${summary}`,
              display: true,
              details: { script: selected!.key, command, cwd: runDir, ...result },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        })
        .catch((err: unknown) => {
          pi.sendMessage(
            {
              customType: "test-runner-complete",
              content: `❌ Test runner error for \`${selected!.key}\`: ${String(err)}`,
              display: true,
              details: { script: selected!.key, command, cwd: runDir, error: String(err) },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        });

      return {
        content: [
          {
            type: "text",
            text: `Tests started in background: \`${command}\`\n\nSession is unlocked — you'll be notified here when the run completes.`,
          },
        ],
        details: { running: true, script: selected.key, command, cwd: runDir },
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

    renderResult(result, { expanded }, theme) {
      type Details = TestRunResult & {
        script?: string;
        command?: string;
        running?: boolean;
        found?: boolean;
        cancelled?: boolean;
      };

      const details = result.details as Details | undefined;

      if (!details) {
        const t = result.content[0];
        return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
      }

      // Not-found / cancelled states
      if (details.found === false || details.cancelled) {
        const t = result.content[0];
        return new Text(
          theme.fg("muted", t?.type === "text" ? t.text : "(no output)"),
          0,
          0,
        );
      }

      // While running — show progress text
      if (details.running) {
        const t = result.content[0];
        return new Text(
          theme.fg("warning", "⏳ ") +
            theme.fg("dim", t?.type === "text" ? t.text : "Running tests..."),
          0,
          0,
        );
      }

      const passed = details.passed ?? 0;
      const failed = details.failed ?? 0;
      const skipped = details.skipped ?? 0;
      const hasFailed = failed > 0 || (details.exitCode ?? 0) !== 0;

      const icon = hasFailed ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const parts = [
        theme.fg("success", `${passed} passed`),
        failed > 0 ? theme.fg("error", `${failed} failed`) : "",
        skipped > 0 ? theme.fg("muted", `${skipped} skipped`) : "",
      ]
        .filter(Boolean)
        .join(theme.fg("muted", " · "));

      if (!expanded) {
        let text = `${icon} ${parts}`;
        const errors: TestFailure[] = details.errors ?? [];
        if (hasFailed && errors.length > 0) {
          const first = errors[0];
          const label = first.test ?? first.file ?? "unknown";
          text += "\n" + theme.fg("error", `  → ${label.slice(0, 80)}`);
          if (errors.length > 1) {
            text += theme.fg("muted", ` (+${errors.length - 1} more)`);
          }
        }
        return new Text(text, 0, 0);
      }

      // Expanded: full error list
      const container = new Container();
      container.addChild(new Text(`${icon} ${parts}`, 0, 0));

      const errors: TestFailure[] = details.errors ?? [];
      if (errors.length > 0) {
        container.addChild(new Spacer(1));
        for (const err of errors) {
          const label = [err.file, err.test].filter(Boolean).join(" › ");
          container.addChild(
            new Text(theme.fg("error", `✗ ${label || "Test failure"}`), 0, 0),
          );
          if (err.message) {
            container.addChild(
              new Text(theme.fg("dim", `  ${err.message.split("\n")[0]}`), 0, 0),
            );
          }
          if (err.stack) {
            for (const line of err.stack.split("\n").slice(0, 4)) {
              container.addChild(
                new Text(theme.fg("muted", `    ${line.trim()}`), 0, 0),
              );
            }
          }
        }
      } else if (hasFailed && (details.exitCode ?? 0) !== 0) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg("error", `Process exited with code ${details.exitCode}`),
            0,
            0,
          ),
        );
        if (details.rawOutput) {
          const tail = details.rawOutput.split("\n").slice(-5).join("\n");
          container.addChild(new Text(theme.fg("muted", tail), 0, 0));
        }
      }

      if (details.command) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", `$ ${details.command}`), 0, 0));
      }

      return container;
    },
  });

  pi.registerCommand("run-tests", {
    description: "Run test scripts from the nearest package.json",
    handler: (args) => {
      const scriptArg = args.trim();
      const msg = scriptArg
        ? `Please run the test script "${scriptArg}" using the run_tests tool.`
        : "Please run the tests using the run_tests tool.";
      pi.sendUserMessage(msg);
    },
  });
}

function buildSummaryText(
  scriptKey: string,
  command: string,
  result: TestRunResult,
): string {
  const { passed, failed, skipped, errors, exitCode } = result;

  if (exitCode !== 0 && passed === 0 && failed === 0) {
    return `Tests failed to run (exit ${exitCode}). Command: \`${command}\`\n\nCheck that the command exists and all dependencies are installed.`;
  }

  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  const lines = [`Script \`${scriptKey}\`: ${parts.join(", ")}`];

  if (errors.length > 0) {
    lines.push("\n**Failed tests:**");
    for (const err of errors) {
      const label = [err.file, err.test].filter(Boolean).join(" › ");
      lines.push(`- ✗ ${label || "unknown"}`);
      if (err.message) {
        lines.push(`  ${err.message.split("\n")[0]}`);
      }
    }
  }

  return lines.join("\n");
}
