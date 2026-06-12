/**
 * SonarQube Analysis Extension
 *
 * Provides a `/sonarqube` command that fetches SonarCloud coverage gaps and
 * quality issues for a PR, then generates an actionable report.
 *
 * Rewrite of salaryhero/opencode/bin/sonar-* scripts as a pi extension.
 * Analysis-only — no code changes.
 *
 * Usage:
 *   /sonarqube          — auto-detect PR from current branch + config from sonar-project.properties
 *   /sonarqube 283      — explicit PR number
 *   /sonarqube 283 --severity=BLOCKER,CRITICAL
 *   /sonarqube 283 --types=BUG,VULNERABILITY
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
	type CoverageAnalysis,
	type CoverageResponse,
	type FilterOptions,
	type IssuesAnalysis,
	type IssuesResponse,
	type SonarConfig,
	type SonarIssue,
	SEVERITY_ORDER,
	SEVERITY_SYMBOLS,
	TYPE_SYMBOLS,
	sonarFetch,
	analyzeCoverage,
	analyzeIssues,
	detectSonarConfig,
	detectPrNumber,
	fetchAllIssues,
	statusIcon,
} from "../shared/sonarqube-utils.js";

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(args: string): { prNumber?: string; filter?: FilterOptions } {
	if (!args.trim()) return {};

	const parts = args.trim().split(/\s+/);
	let prNumber: string | undefined;
	const filter: FilterOptions = {};

	for (const part of parts) {
		if (/^\d+$/.test(part)) {
			prNumber = part;
		} else if (part.startsWith("--severity=")) {
			filter.severity = part.split("=")[1].split(",");
		} else if (part.startsWith("--types=")) {
			filter.types = part.split("=")[1].split(",");
		} else if (part.startsWith("--files=")) {
			filter.files = part.split("=")[1];
		}
	}

	return { prNumber, filter: Object.keys(filter).length > 0 ? filter : undefined };
}

// ── Report generation ─────────────────────────────────────────────────────────

function generateReport(
	prNumber: string,
	config: SonarConfig,
	coverage: CoverageAnalysis,
	issues: IssuesAnalysis,
): string {
	const lines: string[] = [];
	const sep = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

	// Header
	lines.push(`📊 SonarCloud Analysis — PR #${prNumber}`);
	lines.push("");
	lines.push(sep);
	lines.push("📈 COVERAGE REPORT");
	lines.push(sep);
	lines.push("");

	// Coverage metrics
	lines.push(`Overall Line Coverage: ${coverage.overallCoverage}% ${coverage.icons.overall}`);
	lines.push(`New Code Coverage: ${coverage.newCoverage}% ${coverage.icons.newCode}`);
	lines.push(`Branch Coverage: ${coverage.branchCoverage}% ${coverage.icons.branch}`);
	lines.push(`New Branch Coverage: ${coverage.newBranchCoverage}% ${coverage.icons.newBranch}`);
	lines.push("");
	lines.push(`Uncovered Lines: ${coverage.uncoveredLines} / ${coverage.linesToCover}`);
	lines.push("");
	lines.push("Coverage Thresholds (80% minimum):");
	lines.push(
		`${coverage.icons.overall} Overall: ${coverage.gaps.overall > 0 ? coverage.gaps.overall + "% to target" : "meets threshold"}`,
	);
	lines.push(
		`${coverage.icons.newCode} New Code: ${coverage.gaps.newCode > 0 ? coverage.gaps.newCode + "% to target" : "meets threshold"}`,
	);
	lines.push(
		`${coverage.icons.branch} Branch: ${coverage.gaps.branch > 0 ? coverage.gaps.branch + "% to target" : "meets threshold"}`,
	);
	lines.push(
		`${coverage.icons.newBranch} New Branch: ${coverage.gaps.newBranch > 0 ? coverage.gaps.newBranch + "% to target" : "meets threshold"}`,
	);
	lines.push("");

	// Low-coverage files from issues
	const lowCoverageFiles = issues.byFile.slice(0, 5);
	if (lowCoverageFiles.length > 0) {
		lines.push(sep);
		lines.push("🔴 FILES NEEDING ATTENTION");
		lines.push(sep);
		lines.push("");
		lowCoverageFiles.forEach((f, i) => {
			lines.push(`${i + 1}. ${f.file} — ${f.count} issues`);
		});
		lines.push("");
	}

	// Quality issues summary
	lines.push(sep);
	lines.push("⚠️ QUALITY ISSUES SUMMARY");
	lines.push(sep);
	lines.push("");

	lines.push(`Total Issues: ${issues.total}`);
	lines.push("");

	// By severity
	lines.push("By Severity:");
	const blockCrit = (issues.bySeverity["BLOCKER"] || 0) + (issues.bySeverity["CRITICAL"] || 0);
	const major = issues.bySeverity["MAJOR"] || 0;
	const minorInfo = (issues.bySeverity["MINOR"] || 0) + (issues.bySeverity["INFO"] || 0);
	lines.push(`🔴 Blocker/Critical: ${blockCrit}`);
	lines.push(`🟡 Major: ${major}`);
	lines.push(`🔵 Minor/Info: ${minorInfo}`);
	lines.push("");

	// By type
	lines.push("By Type:");
	for (const [type, count] of Object.entries(issues.byType)) {
		lines.push(`${TYPE_SYMBOLS[type] || "❓"} ${type}: ${count}`);
	}
	lines.push("");

	// Top files
	if (issues.byFile.length > 0) {
		lines.push(sep);
		lines.push("📂 TOP FILES WITH ISSUES");
		lines.push(sep);
		lines.push("");
		issues.byFile.slice(0, 10).forEach((f, i) => {
			lines.push(`${i + 1}. ${f.file} — ${f.count} issues`);
		});
		lines.push("");
	}

	// Top rules
	if (issues.byRule.length > 0) {
		lines.push(sep);
		lines.push("⚠️ TOP VIOLATED RULES");
		lines.push(sep);
		lines.push("");
		issues.byRule.forEach((r, i) => {
			lines.push(`${i + 1}. ${r.rule} (${r.severity}) — ${r.count} occurrences`);
			lines.push(`   "${r.message}"`);
			lines.push("");
		});
	}

	// Action plan
	lines.push(sep);
	lines.push("✅ ACTION PLAN");
	lines.push(sep);
	lines.push("");

	if (coverage.gaps.overall > 0 || coverage.gaps.newCode > 0) {
		const lowCovFiles = issues.byFile
			.slice(0, 5)
			.map((f) => f.file)
			.join(", ");
		lines.push("Priority 0 — COVERAGE GAPS:");
		if (lowCovFiles) lines.push(`  • Add tests for low-coverage files: ${lowCovFiles}`);
		lines.push("  • Minimum 80% coverage required before merge");
		lines.push("");
	}

	if (blockCrit > 0) {
		const topFiles = issues.byFile
			.slice(0, 3)
			.map((f) => f.file)
			.join(", ");
		lines.push(`Priority 1 — CRITICAL/BLOCKER (${blockCrit} issues):`);
		lines.push("  • Fix immediately before merge");
		if (topFiles) lines.push(`  • Focus on: ${topFiles}`);
		lines.push("");
	}

	if (major > 0) {
		lines.push(`Priority 2 — MAJOR (${major} issues):`);
		lines.push("  • Address in this PR if possible");
		lines.push("  • Consider tech debt ticket if extensive");
		lines.push("");
	}

	if (minorInfo > 0) {
		lines.push(`Priority 3 — MINOR/INFO (${minorInfo} issues):`);
		lines.push("  • Can be addressed in follow-up PR");
		lines.push("  • Add to backlog for refactoring sprint");
		lines.push("");
	}

	// Links
	lines.push(sep);
	lines.push("🔗 LINKS");
	lines.push(sep);
	lines.push("");
	lines.push("View in SonarCloud:");
	lines.push(
		`https://sonarcloud.io/project/pull_requests_list?id=${config.projectKey}&pullRequest=${prNumber}`,
	);

	return lines.join("\n");
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function sonarqube(pi: ExtensionAPI) {
	pi.registerCommand("sonarqube", {
		description: "Analyze SonarCloud coverage gaps and quality issues for a PR",
		handler: async (args, ctx) => {
			// 1. Verify token
			const token = process.env.SONARQUBE_TOKEN;
			if (!token) {
				ctx.ui.notify(
					"SONARQUBE_TOKEN not set. Run: export SONARQUBE_TOKEN=your_token",
					"error",
				);
				return;
			}

			// 2. Parse arguments
			const parsed = parseArgs(args);
			const filter = parsed.filter;

			// 3. Detect config
			let config: SonarConfig;
			try {
				config = await detectSonarConfig(ctx.cwd);
			} catch (err) {
				ctx.ui.notify(String((err as Error).message), "error");
				return;
			}

			// 4. Detect PR number
			const prNumber = parsed.prNumber || (await detectPrNumber("/sonarqube"));
			ctx.ui.notify(`Analyzing PR #${prNumber}...`, "info");

			// 5. Fetch coverage
			let coverageData: CoverageResponse;
			try {
				coverageData = (await sonarFetch(
					config.baseUrl,
					token,
					"measures/component",
					{
						component: config.projectKey,
						pullRequest: prNumber,
						metricKeys:
							"coverage,new_coverage,new_line_coverage,uncovered_lines,lines_to_cover,branch_coverage,new_branch_coverage,new_lines_to_cover",
					},
					ctx.signal,
				)) as CoverageResponse;
			} catch (err) {
				ctx.ui.notify(`Coverage fetch failed: ${(err as Error).message}`, "error");
				return;
			}

			// 6. Fetch issues (handle pagination)
			let allIssues: SonarIssue[];
			let total: number;
			try {
				({ issues: allIssues, total } = await fetchAllIssues(
					config.baseUrl,
					token,
					config.projectKey,
					prNumber,
					ctx.signal,
				));
			} catch (err) {
				ctx.ui.notify(`Issues fetch failed: ${(err as Error).message}`, "error");
				return;
			}

			// 7. Analyze
			const coverage = analyzeCoverage(coverageData);
			const issues = analyzeIssues({ total, issues: allIssues }, filter);

			// 8. Generate report
			const report = generateReport(prNumber, config, coverage, issues);

			// 9. Write report to repo root
			const reportPath = path.join(ctx.cwd, "sonarqube-report.md");
			await fs.writeFile(reportPath, report, "utf8");

			ctx.ui.notify(
				`Analysis complete: ${issues.total} issues, coverage ${coverage.overallCoverage}%. Report: ${reportPath}`,
				"info",
			);

			// Send report as user message so the agent can act on it
			pi.sendUserMessage(report);
		},
	});
}
