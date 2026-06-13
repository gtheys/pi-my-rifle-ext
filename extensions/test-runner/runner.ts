/**
 * Subagent runner for test execution.
 *
 * Spawns a pi subprocess in JSON mode (bash tool only). The subagent runs
 * the test command, parses output, and emits a structured JSON block.
 *
 * Pi-intercom's contact_supervisor tool is activated in the child by
 * setting PI_SUBAGENT_* env vars, enabling real-time progress_update
 * messages back to the supervisor session.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface TestFailure {
  test?: string;
  file?: string;
  message: string;
  stack?: string;
}

export interface TestRunResult {
  passed: number;
  failed: number;
  skipped: number;
  errors: TestFailure[];
  rawOutput: string;
  exitCode: number;
}

export interface RunnerOptions {
  command: string;
  cwd: string;
  /** Intercom target name for pi-intercom contact_supervisor. */
  supervisorTarget?: string;
  signal?: AbortSignal;
  /** Called with a short progress string as the subagent produces output. */
  onUpdate?: (text: string) => void;
}

// AIDEV-NOTE: System prompt tells the subagent exactly what to run and what JSON
// structure to emit at the end. parseTestResult() relies on this exact format.
function buildSystemPrompt(command: string): string {
  return `You are a test runner assistant. Your only job is to run the specified test command and report structured results.

## Task

Run this exact command in the working directory:
\`\`\`
${command}
\`\`\`

## Instructions

1. Run the command using the bash tool. Use a timeout of 120 seconds.
2. If the \`contact_supervisor\` tool is available, call it once after tests complete with reason \`"progress_update"\` and a brief status like "Tests done: X passed, Y failed".
3. Parse the test output carefully to extract:
   - Total tests passed
   - Total tests failed or errored
   - Total tests skipped
   - Per-failure details (test name, file, error message, stack trace)
4. End your response with a JSON block in **exactly** this format:

\`\`\`json
{
  "passed": 0,
  "failed": 0,
  "skipped": 0,
  "errors": [
    {
      "test": "<test name or describe block>",
      "file": "<source file path if available, else omit>",
      "message": "<first line of the error message>",
      "stack": "<up to 5 lines of stack trace if available, else omit>"
    }
  ]
}
\`\`\`

Be accurate. Use 0 when you cannot determine a count. Do not run any other commands.`;
}

// AIDEV-NOTE: Mirrors the getPiInvocation pattern from pi's built-in subagent example.
// Handles node/bun runtime vs installed pi binary.
function getPiInvocation(extraArgs: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...extraArgs] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: "pi", args: extraArgs };
  }
  return { command: process.execPath, args: extraArgs };
}

function getFinalAssistantText(
  messages: Array<{ role: string; content: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content as Array<{ type: string; text?: string }>) {
          if (part.type === "text" && part.text) return part.text;
        }
      }
    }
  }
  return "";
}

// AIDEV-NOTE: Extracts structured test results from the subagent's final markdown response.
// Tries the ```json block first, then falls back to a raw JSON object scan.
function parseTestResult(
  output: string,
): Pick<TestRunResult, "passed" | "failed" | "skipped" | "errors"> {
  const jsonBlockMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    try {
      const data = JSON.parse(jsonBlockMatch[1]) as Record<string, unknown>;
      return {
        passed: Number(data.passed) || 0,
        failed: Number(data.failed) || 0,
        skipped: Number(data.skipped) || 0,
        errors: Array.isArray(data.errors) ? (data.errors as TestFailure[]) : [],
      };
    } catch {
      // fall through
    }
  }

  // Looser fallback: find a JSON object containing "passed" and "errors"
  const rawMatch = output.match(/\{[^{}]*"passed"[^{}]*"errors"[\s\S]*?\]/);
  if (rawMatch) {
    try {
      const data = JSON.parse(rawMatch[0]) as Record<string, unknown>;
      return {
        passed: Number(data.passed) || 0,
        failed: Number(data.failed) || 0,
        skipped: Number(data.skipped) || 0,
        errors: Array.isArray(data.errors) ? (data.errors as TestFailure[]) : [],
      };
    } catch {
      // fall through
    }
  }

  return { passed: 0, failed: 0, skipped: 0, errors: [] };
}

export async function runTestSubagent(options: RunnerOptions): Promise<TestRunResult> {
  const { command, cwd, supervisorTarget, signal, onUpdate } = options;

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-test-runner-"));
  const promptFile = path.join(tmpDir, "system-prompt.md");

  try {
    await fs.promises.writeFile(promptFile, buildSystemPrompt(command), {
      encoding: "utf-8",
      mode: 0o600,
    });

    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--tools", "bash",
      "--append-system-prompt", promptFile,
      "Run the test command as instructed in the system prompt.",
    ];

    // AIDEV-NOTE: PI_SUBAGENT_* env vars are read by pi-intercom on startup in the child
    // process. When present, pi-intercom registers the contact_supervisor tool so the
    // subagent can send progress_update and need_decision messages back to the supervisor.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_SUBAGENT_RUN_ID: randomUUID().slice(0, 8),
      PI_SUBAGENT_CHILD_AGENT: "test-runner",
      PI_SUBAGENT_CHILD_INDEX: "0",
    };

    if (supervisorTarget) {
      env.PI_SUBAGENT_ORCHESTRATOR_TARGET = supervisorTarget;
    }

    const messages: Array<{ role: string; content: unknown }> = [];
    let exitCode = 0;

    const invocation = getPiInvocation(args);

    exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as { role: string; content: unknown };
          messages.push(msg);

          if (msg.role === "assistant") {
            const text = getFinalAssistantText(messages);
            if (text) {
              // Emit first non-empty line as a progress hint
              const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
              if (firstLine) onUpdate?.(firstLine.slice(0, 120));
            }
          }
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });

      proc.on("close", (code: number | null) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) {
          kill();
        } else {
          signal.addEventListener("abort", kill, { once: true });
        }
      }
    });

    const rawOutput = getFinalAssistantText(messages);
    const parsed = parseTestResult(rawOutput);

    return { ...parsed, rawOutput, exitCode };
  } finally {
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch {
      /* ignore */
    }
  }
}
