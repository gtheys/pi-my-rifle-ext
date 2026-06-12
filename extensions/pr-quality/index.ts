/**
 * PR Quality Extension
 *
 * Combines GitHub PR unresolved review comments with SonarCloud analysis for
 * the same PR, then sends a unified context message to the LLM so it can:
 *   - Triage each review thread (VALID / INVALID)
 *   - Auto-resolve INVALID threads via GitHub GraphQL
 *   - Cross-reference VALID comments with SonarCloud issues by file
 *   - Write a combined action plan to pr-quality-plan.md
 *
 * Prerequisites:
 *   - gh CLI installed and authenticated
 *   - SONARQUBE_TOKEN env var set (get from https://sonarcloud.io/account/security)
 *   - sonar-project.properties in repo root (or SONAR_PROJECT_KEY + SONAR_ORGANIZATION env vars)
 *
 * Usage:
 *   /pr-quality          — auto-detect PR from current branch
 *   /pr-quality 283      — explicit PR number
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type CoverageResponse,
	type IssuesAnalysis,
	type SonarConfig,
	type SonarIssue,
	SEVERITY_SYMBOLS,
	TYPE_SYMBOLS,
	sonarFetch,
	analyzeCoverage,
	analyzeIssues,
	detectSonarConfig,
	detectPrNumber,
	fetchAllIssues,
} from "../shared/sonarqube-utils.js";

// ── GitHub types ──────────────────────────────────────────────────────────────

interface GhComment {
	author: string;
	body: string;
	createdAt: string;
	url: string;
}

interface GhReviewThread {
	threadId: string;
	path: string;
	line: number | null;
	startLine: number | null;
	isOutdated: boolean;
	comments: GhComment[];
}

interface GhPrData {
	pr_title: string;
	pr_url: string;
	total_review_threads: number;
	unresolved_count: number;
	unresolved_threads: GhReviewThread[];
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(args: string): { prNumber?: string } {
	const match = args.trim().match(/^(\d+)/);
	return { prNumber: match?.[1] };
}

// ── GitHub PR comment fetching ────────────────────────────────────────────────

// AIDEV-NOTE: Uses inline GraphQL via `gh api graphql` so the extension has no
// dependency on the fetch_unresolved_comments.sh shell script. Same query as
// the gh-unresolved-comments skill.
const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $limit: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      title
      url
      reviewThreads(first: $limit) {
        totalCount
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first: 10) {
            nodes {
              body
              author { login }
              createdAt
              url
            }
          }
        }
      }
    }
  }
}
`.trim();

async function fetchUnresolvedThreads(
	exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
	prNumber: string,
): Promise<GhPrData> {
	const result = await exec(
		"gh",
		[
			"api", "graphql",
			"-f", `query=${REVIEW_THREADS_QUERY}`,
			"-F", "owner={owner}",
			"-F", "repo={repo}",
			"-F", `pr=${prNumber}`,
			"-F", "limit=100",
		],
		{ timeout: 30000 },
	);

	if (result.code !== 0) {
		throw new Error(`gh GraphQL query failed: ${result.stderr || result.stdout}`);
	}

	// AIDEV-NOTE: `gh api graphql` with `-F owner={owner}` uses the repo owner
	// inferred from the current git remote — same behaviour as the skill script.
	const raw = JSON.parse(result.stdout);
	const pr = raw?.data?.repository?.pullRequest;
	if (!pr) {
		throw new Error("GitHub GraphQL returned no pull request data. Check PR number and repo access.");
	}

	const allThreads = pr.reviewThreads?.nodes ?? [];
	const unresolved: GhReviewThread[] = allThreads
		.filter((t: { isResolved: boolean }) => !t.isResolved)
		.map((t: {
			id: string;
			path: string;
			line: number | null;
			startLine: number | null;
			isOutdated: boolean;
			comments: { nodes: Array<{ body: string; author: { login: string }; createdAt: string; url: string }> };
		}) => ({
			threadId: t.id,
			path: t.path,
			line: t.line,
			startLine: t.startLine,
			isOutdated: t.isOutdated,
			comments: (t.comments?.nodes ?? []).map((c) => ({
				author: c.author?.login ?? "unknown",
				body: c.body,
				createdAt: c.createdAt,
				url: c.url,
			})),
		}));

	return {
		pr_title: pr.title,
		pr_url: pr.url,
		total_review_threads: pr.reviewThreads?.totalCount ?? 0,
		unresolved_count: unresolved.length,
		unresolved_threads: unresolved,
	};
}

// ── Prompt construction ───────────────────────────────────────────────────────

// AIDEV-NOTE: The prompt is intentionally verbose and structured so the LLM has
// clear, step-by-step instructions for both the triage and the SonarQube fix
// tasks. The file is written to disk so the agent can read it back if it gets
// compacted mid-task.
function buildAgentPrompt(
	prNumber: string,
	prData: GhPrData,
	sonarConfig: SonarConfig,
	issues: IssuesAnalysis,
	coverageData: ReturnType<typeof analyzeCoverage>,
): string {
	const lines: string[] = [];

	lines.push(`# PR Quality Check — PR #${prNumber}: ${prData.pr_title}`);
	lines.push(`> ${prData.pr_url}`);
	lines.push("");

	// ── Section 1: instructions ─────────────────────────────────────────────
	lines.push("## Your Tasks");
	lines.push("");
	lines.push(
		"You have two data sources below. Work through them in order:",
	);
	lines.push("");
	lines.push("### Task A — Triage GitHub Review Comments");
	lines.push("");
	lines.push(
		"For each unresolved thread in **Section 2**, read the referenced file at the given line, then classify the thread:",
	);
	lines.push("");
	lines.push("**VALID** — needs action:");
	lines.push("  - Real bug, security issue, or logic error");
	lines.push("  - Meaningful improvement to quality, readability, or performance");
	lines.push("  - Legitimate architectural / design concern");
	lines.push("  - Missing error handling, edge cases, or tests");
	lines.push("");
	lines.push("**INVALID** — dismiss:");
	lines.push("  - Code already changed or fixed (outdated diff)");
	lines.push("  - Style nitpick with no functional impact");
	lines.push("  - Based on a misunderstanding of the code's intent");
	lines.push("  - Already answered elsewhere in the PR");
	lines.push("");
	lines.push("For every **INVALID** thread, auto-resolve it via:");
	lines.push("```bash");
	lines.push(`gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<THREAD_ID>"}) { thread { isResolved } } }'`);
	lines.push("```");
	lines.push("(Replace `<THREAD_ID>` with the threadId from Section 2.)");
	lines.push("");
	lines.push("### Task B — Address SonarCloud Issues");
	lines.push("");
	lines.push(
		"Using the SonarCloud data in **Section 3**, identify which files overlap with VALID review comments and prioritise fixes there first.",
	);
	lines.push("Then address remaining SonarCloud issues in severity order (BLOCKER → CRITICAL → MAJOR).");
	lines.push("");
	lines.push("### Task C — Write Action Plan");
	lines.push("");
	lines.push(
		"After triaging all comments and reviewing SonarCloud data, write a combined action plan to `pr-quality-plan.md` in the repo root.",
	);
	lines.push("Structure:");
	lines.push("```");
	lines.push(`# PR Quality Plan — PR #${prNumber}`);
	lines.push("");
	lines.push("## Review Comments (VALID)");
	lines.push("- [ ] <file>:<line> — <actionable description> (@<author>)");
	lines.push("");
	lines.push("## SonarCloud Issues");
	lines.push("- [ ] <severity> <file>:<line> — <rule>: <message>");
	lines.push("");
	lines.push("## Coverage Gaps");
	lines.push("- [ ] <file> — add tests to reach 80% coverage");
	lines.push("```");
	lines.push("");

	// ── Section 2: review threads ────────────────────────────────────────────
	lines.push("---");
	lines.push("");
	lines.push(`## Section 2 — Unresolved Review Threads (${prData.unresolved_count})`);
	lines.push("");

	if (prData.unresolved_count === 0) {
		lines.push("_No unresolved threads. Skip Task A._");
	} else {
		for (const [i, thread] of prData.unresolved_threads.entries()) {
			const loc = thread.line ? `${thread.path}:${thread.line}` : thread.path;
			const outdated = thread.isOutdated ? " _(outdated diff)_" : "";
			lines.push(`### Thread ${i + 1} — \`${loc}\`${outdated}`);
			lines.push(`**threadId:** \`${thread.threadId}\``);
			lines.push("");
			for (const c of thread.comments) {
				lines.push(`**@${c.author}** (${c.createdAt.slice(0, 10)}):`);
				lines.push(`> ${c.body.split("\n").join("\n> ")}`);
				lines.push(`[View on GitHub](${c.url})`);
				lines.push("");
			}
		}
	}

	// ── Section 3: SonarCloud ────────────────────────────────────────────────
	lines.push("---");
	lines.push("");
	lines.push("## Section 3 — SonarCloud Analysis");
	lines.push("");
	lines.push(`**Project:** \`${sonarConfig.projectKey}\``);
	lines.push("");

	// Coverage summary
	lines.push("### Coverage");
	lines.push(`| Metric | Value | Status |`);
	lines.push(`|--------|-------|--------|`);
	lines.push(`| Overall Line | ${coverageData.overallCoverage}% | ${coverageData.icons.overall} ${coverageData.status.overall} |`);
	lines.push(`| New Code | ${coverageData.newCoverage}% | ${coverageData.icons.newCode} ${coverageData.status.newCode} |`);
	lines.push(`| Branch | ${coverageData.branchCoverage}% | ${coverageData.icons.branch} ${coverageData.status.branch} |`);
	lines.push(`| New Branch | ${coverageData.newBranchCoverage}% | ${coverageData.icons.newBranch} ${coverageData.status.newBranch} |`);
	lines.push(`| Uncovered Lines | ${coverageData.uncoveredLines} / ${coverageData.linesToCover} | — |`);
	lines.push("");

	// Issues summary
	lines.push("### Issues");
	lines.push(`**Total:** ${issues.total}`);
	lines.push("");

	if (issues.total > 0) {
		lines.push("**By Severity:**");
		for (const [sev, count] of Object.entries(issues.bySeverity)) {
			lines.push(`  - ${SEVERITY_SYMBOLS[sev] ?? "❓"} ${sev}: ${count}`);
		}
		lines.push("");

		lines.push("**By Type:**");
		for (const [type, count] of Object.entries(issues.byType)) {
			lines.push(`  - ${TYPE_SYMBOLS[type] ?? "❓"} ${type}: ${count}`);
		}
		lines.push("");

		// Per-file issues (top 15)
		if (issues.byFile.length > 0) {
			lines.push("### Issues by File (top 15)");
			lines.push("");
			for (const f of issues.byFile.slice(0, 15)) {
				lines.push(`#### \`${f.file}\` — ${f.count} issue(s)`);
				for (const issue of f.issues.slice(0, 20)) {
					const loc = issue.line ? `:${issue.line}` : "";
					const sym = SEVERITY_SYMBOLS[issue.severity] ?? "❓";
					const typeSym = TYPE_SYMBOLS[issue.type] ?? "❓";
					lines.push(`- ${sym} ${typeSym} **${issue.severity}** \`${issue.rule}\`${loc} — ${issue.message}`);
				}
				lines.push("");
			}
		}

		// Top rules
		if (issues.byRule.length > 0) {
			lines.push("### Top Violated Rules");
			for (const r of issues.byRule) {
				lines.push(`- \`${r.rule}\` (${r.severity}) × ${r.count} — "${r.message}"`);
			}
			lines.push("");
		}
	}

	// SonarCloud link
	lines.push(
		`[View PR in SonarCloud](https://sonarcloud.io/project/pull_requests_list?id=${sonarConfig.projectKey}&pullRequest=${prNumber})`,
	);

	return lines.join("\n");
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function prQuality(pi: ExtensionAPI) {
	pi.registerCommand("pr-quality", {
		description:
			"Triage unresolved PR review comments + SonarCloud analysis, then write a combined action plan",
		handler: async (args, ctx) => {
			// ── 1. Guard: SONARQUBE_TOKEN ────────────────────────────────────
			const token = process.env.SONARQUBE_TOKEN;
			if (!token) {
				ctx.ui.notify(
					[
						"SONARQUBE_TOKEN is not set.",
						"Get a token at https://sonarcloud.io/account/security",
						"Then run: export SONARQUBE_TOKEN=<your_token>",
						"Add it to your shell profile (~/.bashrc / ~/.zshrc) to persist it.",
					].join("  "),
					"error",
				);
				return;
			}

			// ── 2. Detect PR number ──────────────────────────────────────────
			const parsed = parseArgs(args);
			let prNumber: string;
			try {
				prNumber = parsed.prNumber ?? (await detectPrNumber((cmd, a, opts) => ctx.exec(cmd, a, opts)));
			} catch (err) {
				ctx.ui.notify(String((err as Error).message), "error");
				return;
			}

			ctx.ui.notify(`PR Quality: analyzing PR #${prNumber}...`, "info");

			// ── 3. Detect SonarCloud config ──────────────────────────────────
			let sonarConfig: SonarConfig;
			try {
				sonarConfig = await detectSonarConfig(ctx.cwd);
			} catch (err) {
				ctx.ui.notify(
					[
						String((err as Error).message),
						"Either create sonar-project.properties with sonar.projectKey and sonar.organization,",
						"or set SONAR_PROJECT_KEY and SONAR_ORGANIZATION env vars.",
					].join("  "),
					"error",
				);
				return;
			}

			// ── 4. Fetch in parallel ─────────────────────────────────────────
			// AIDEV-NOTE: GitHub and SonarCloud calls are independent — run them
			// concurrently to reduce total wall-clock time.
			ctx.ui.setStatus("pr-quality", "Fetching GitHub threads + SonarCloud data...");

			let prData: GhPrData;
			let coverageRaw: CoverageResponse;
			let rawIssues: { issues: SonarIssue[]; total: number };

			try {
				[prData, coverageRaw, rawIssues] = await Promise.all([
					fetchUnresolvedThreads((cmd, a, opts) => ctx.exec(cmd, a, opts), prNumber),
					sonarFetch(
						sonarConfig.baseUrl,
						token,
						"measures/component",
						{
							component: sonarConfig.projectKey,
							pullRequest: prNumber,
							metricKeys:
								"coverage,new_coverage,new_line_coverage,uncovered_lines,lines_to_cover,branch_coverage,new_branch_coverage,new_lines_to_cover",
						},
						ctx.signal,
					).then((d) => d as CoverageResponse),
					fetchAllIssues(
						sonarConfig.baseUrl,
						token,
						sonarConfig.projectKey,
						prNumber,
						ctx.signal,
					),
				]);
			} catch (err) {
				ctx.ui.setStatus("pr-quality", undefined);
				ctx.ui.notify(`Fetch failed: ${(err as Error).message}`, "error");
				return;
			}

			ctx.ui.setStatus("pr-quality", undefined);

			// ── 5. Analyze ───────────────────────────────────────────────────
			const coverage = analyzeCoverage(coverageRaw);
			const issues = analyzeIssues(rawIssues);

			// ── 6. Build and send prompt ─────────────────────────────────────
			ctx.ui.notify(
				`Fetched ${prData.unresolved_count} unresolved threads, ${issues.total} SonarCloud issues. Starting triage...`,
				"info",
			);

			const prompt = buildAgentPrompt(prNumber, prData, sonarConfig, issues, coverage);
			pi.sendUserMessage(prompt);
		},
	});
}
