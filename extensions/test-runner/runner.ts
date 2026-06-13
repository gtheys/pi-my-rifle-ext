/**
 * Subagent runner for test execution.
 *
 * Spawns a fully detached pi subprocess with a pre-assigned session file.
 * All communication back to the main session is via pi-intercom
 * contact_supervisor — no stdout pipe is maintained.
 *
 * The session file can be switched to via ctx.switchSession() so the user
 * can inspect the live transcript while tests are running.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SpawnOptions {
  command: string;
  cwd: string;
  runId: string;
  /** Pre-generated session file path passed via --session to the subprocess. */
  sessionFile: string;
  /** Intercom target so contact_supervisor can reach the main session. */
  supervisorTarget?: string;
  model?: string;
}

// AIDEV-NOTE: System prompt makes contact_supervisor MANDATORY.
// Since stdout is ignored (fully detached), intercom is the only result channel.
// The JSON block fallback covers the transcript for human reading even if
// contact_supervisor is unavailable (e.g., pi-intercom broker down).
function buildSystemPrompt(command: string): string {
  return `You are a test runner assistant. Run the specified test command and report results back to the supervisor session via pi-intercom.

## Task

Run this exact command in the working directory:
\`\`\`
${command}
\`\`\`

## Instructions

1. Run the command using the bash tool with a 120-second timeout.
2. Parse the output to extract: tests passed, failed, skipped, and per-failure details (test name, file, error message, stack trace).
3. **REQUIRED** — call \`contact_supervisor\` with reason \`"progress_update"\` to deliver results. Use this exact message format:

   > Test run complete: X passed, Y failed, Z skipped
   >
   > \`\`\`json
   > {
   >   "passed": 0,
   >   "failed": 0,
   >   "skipped": 0,
   >   "errors": [
   >     {
   >       "test": "<name>",
   >       "file": "<path>",
   >       "message": "<first line>",
   >       "stack": "<up to 5 lines>"
   >     }
   >   ]
   > }
   > \`\`\`

4. If \`contact_supervisor\` is not available, include the JSON block in your final response as a fallback.

Do not run any other commands. Be accurate with counts.`;
}

// AIDEV-NOTE: Mirrors getPiInvocation from pi's built-in subagent example.
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

/**
 * Spawn the test subagent fully detached.
 *
 * Returns immediately — the process runs independently.
 * Results are delivered back via pi-intercom contact_supervisor.
 * The session file receives the full transcript and can be switched to.
 */
export function spawnTestSubagent(options: SpawnOptions): void {
  // Write system prompt to a temp file; subprocess reads it during startup.
  // AIDEV-NOTE: We use a sync write here because spawnTestSubagent is called
  // from a command handler (not inside an async tool execute), and we need the
  // file to exist before spawn() is called in the same tick.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-runner-"));
  const promptFile = path.join(tmpDir, "system-prompt.md");
  fs.writeFileSync(promptFile, buildSystemPrompt(options.command), {
    encoding: "utf-8",
    mode: 0o600,
  });

  // Ensure the sessions directory exists
  fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true });

  const scriptName = options.command.split(" ").pop() ?? options.command;
  const cwdBase = path.basename(options.cwd);

  const args = [
    "--mode", "json",
    "-p",
    "--session", options.sessionFile,
    "--name", `test: ${cwdBase} › ${scriptName}`,
    "--tools", "bash",
    "--append-system-prompt", promptFile,
    "Run the test command as instructed in the system prompt.",
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  // AIDEV-NOTE: PI_SUBAGENT_* env vars activate contact_supervisor in the child.
  // The child reads these on extension startup (pi-intercom extension).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_SUBAGENT_RUN_ID: options.runId,
    PI_SUBAGENT_CHILD_AGENT: "test-runner",
    PI_SUBAGENT_CHILD_INDEX: "0",
  };

  if (options.supervisorTarget) {
    env.PI_SUBAGENT_ORCHESTRATOR_TARGET = options.supervisorTarget;
  }

  const invocation = getPiInvocation(args);

  const proc = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env,
    shell: false,
    // AIDEV-NOTE: detached + stdio:ignore + proc.unref() fully decouples the child.
    // No stdout pipe = no event loop reference = main session stays truly idle.
    detached: true,
    stdio: "ignore",
  });

  proc.unref();

  // Clean up the temp prompt file after 15 s — more than enough for pi startup.
  setTimeout(() => {
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }, 15_000);
}

/**
 * Generate a session file path for a test run.
 * Placed in ~/.pi/agent/sessions/ so it appears in /resume.
 */
export function generateSessionFile(agentDir: string, runId: string): string {
  return path.join(agentDir, "sessions", `test-runner-${runId}.jsonl`);
}
