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

// ── Types ─────────────────────────────────────────────────────────────────────

interface CoverageMeasure {
	metric: string;
	value?: string;
	periods?: Array<{ index: number; value: string }>;
}

interface CoverageResponse {
	component?: {
		measures: CoverageMeasure[];
	};
}

interface SonarIssue {
	key: string;
	rule: string;
	severity: string;
	type: string;
	message: string;
	component: string;
	line?: number;
	textRange?: { startLine: number; endLine: number };
	effort?: string;
	debt?: string;
}

interface IssuesResponse {
	total?: number;
	issues: SonarIssue[];
	p?: number;
	ps?: number;
}

interface CoverageAnalysis {
	overallCoverage: number;
	newCoverage: number;
	branchCoverage: number;
	newBranchCoverage: number;
	uncoveredLines: number;
	linesToCover: number;
	gaps: { overall: number; newCode: number; branch: number; newBranch: number };
	status: { overall: string; newCode: string; branch: string; newBranch: string };
	icons: { overall: string; newCode: string; branch: string; newBranch: string };
}

interface IssuesAnalysis {
	total: number;
	bySeverity: Record<string, number>;
	byType: Record<string, number>;
	byFile: Array<{ file: string; count: number; issues: SonarIssue[] }>;
	byRule: Array<{ rule: string; count: number; severity: string; message: string }>;
	issues: SonarIssue[];
}

interface FilterOptions {
	severity?: string[];
	types?: string[];
	files?: string;
}

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
	BLOCKER: 0,
	CRITICAL: 1,
	MAJOR: 2,
	MINOR: 3,
	INFO: 4,
};

// AIDEV-NOTE: Emojis used intentionally here for terminal report readability (severity/type
// indicators in the generated sonarqube-report.md). Coding-standards "no emojis" rule applies
// to code comments and logic, not to user-facing report output.
const SEVERITY_SYMBOLS: Record<string, string> = {
	BLOCKER: "🔴",
	CRITICAL: "🔴",
	MAJOR: "🟡",
	MINOR: "🔵",
	INFO: "🔵",
};

const TYPE_SYMBOLS: Record<string, string> = {
	BUG: "🐛",
	VULNERABILITY: "🛡️",
	CODE_SMELL: "🧹",
	SECURITY_HOTSPOT: "🔒",
};

// ── SonarCloud API calls ─────────────────────────────────────────────────────

async function sonarFetch(
	baseUrl: string,
	token: string,
	endpoint: string,
	params: Record<string, string>,
	signal?: AbortSignal,
): Promise<unknown> {
	const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
	const url = new URL(endpoint, base);
	for (const [k, v] of Object.entries(params)) {
		url.searchParams.set(k, v);
	}

	const resp = await fetch(url.toString(), {
		headers: {
			Authorization: "Basic " + Buffer.from(token + ":").toString("base64"),
		},
		signal,
	});

	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new Error(`SonarCloud API ${resp.status}: ${resp.statusText}${body ? " — " + body.slice(0, 200) : ""}`);
	}

	return resp.json();
}

// ── Coverage analysis ─────────────────────────────────────────────────────────

function statusIcon(val: number, threshold = 80): string {
	if (val >= threshold) return "✅";
	if (val >= threshold - 10) return "⚠️";
	return "❌";
}

function analyzeCoverage(data: CoverageResponse): CoverageAnalysis {
	const measures = data.component?.measures ?? [];
	const metrics: Record<string, number> = {};

	for (const m of measures) {
		if (m.periods && m.periods.length > 0) {
			metrics[m.metric] = parseFloat(m.periods[0].value) || 0;
		} else if (m.value !== undefined) {
			metrics[m.metric] = parseFloat(m.value) || 0;
		}
	}

	const overallCoverage = metrics["coverage"] || 0;
	const newCoverage = metrics["new_coverage"] || metrics["new_line_coverage"] || 0;
	const branchCoverage = metrics["branch_coverage"] || 0;
	const newBranchCoverage = metrics["new_branch_coverage"] || 0;
	const uncoveredLines = Math.round(metrics["uncovered_lines"] || 0);
	const linesToCover = Math.round(metrics["lines_to_cover"] || 0);

	return {
		overallCoverage,
		newCoverage,
		branchCoverage,
		newBranchCoverage,
		uncoveredLines,
		linesToCover,
		gaps: {
			overall: Math.max(0, 80 - overallCoverage),
			newCode: Math.max(0, 80 - newCoverage),
			branch: Math.max(0, 80 - branchCoverage),
			newBranch: Math.max(0, 80 - newBranchCoverage),
		},
		status: {
			overall: overallCoverage >= 80 ? "PASS" : "FAIL",
			newCode: newCoverage >= 80 ? "PASS" : "FAIL",
			branch: branchCoverage >= 80 ? "PASS" : "FAIL",
			newBranch: newBranchCoverage >= 80 ? "PASS" : "FAIL",
		},
		icons: {
			overall: statusIcon(overallCoverage),
			newCode: statusIcon(newCoverage),
			branch: statusIcon(branchCoverage),
			newBranch: statusIcon(newBranchCoverage),
		},
	};
}

// ── Issues analysis ───────────────────────────────────────────────────────────

function analyzeIssues(data: IssuesResponse, filter?: FilterOptions): IssuesAnalysis {
	let issues = data.issues ?? [];

	if (filter?.severity?.length) {
		issues = issues.filter((i) => filter.severity!.includes(i.severity));
	}
	if (filter?.types?.length) {
		issues = issues.filter((i) => filter.types!.includes(i.type));
	}
	if (filter?.files) {
		const pattern = new RegExp(filter.files.replace(/\*/g, ".*"));
		issues = issues.filter((i) => {
			const file = i.component.split(":")[1] || i.component;
			return pattern.test(file);
		});
	}

	const bySeverity: Record<string, number> = {};
	const byType: Record<string, number> = {};

	for (const i of issues) {
		bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
		byType[i.type] = (byType[i.type] || 0) + 1;
	}

	const byFileMap: Record<string, { count: number; issues: SonarIssue[] }> = {};
	for (const i of issues) {
		const file = i.component.split(":")[1] || i.component;
		if (!byFileMap[file]) byFileMap[file] = { count: 0, issues: [] };
		byFileMap[file].count++;
		byFileMap[file].issues.push(i);
	}

	const byRuleMap: Record<string, { count: number; severity: string; message: string }> = {};
	for (const i of issues) {
		if (!byRuleMap[i.rule]) {
			byRuleMap[i.rule] = { count: 0, severity: i.severity, message: i.message };
		}
		byRuleMap[i.rule].count++;
	}

	return {
		total: issues.length,
		bySeverity,
		byType,
		byFile: Object.entries(byFileMap)
			.sort(([, a], [, b]) => b.count - a.count)
			.slice(0, 10)
			.map(([file, d]) => ({ file, count: d.count, issues: d.issues })),
		byRule: Object.entries(byRuleMap)
			.map(([rule, d]) => ({ rule, ...d }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 5),
		issues: [...issues].sort(
			(a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
		),
	};
}

// ── Config detection ──────────────────────────────────────────────────────────

interface SonarConfig {
	projectKey: string;
	organization: string;
	baseUrl: string;
}

async function detectConfig(cwd: string): Promise<SonarConfig> {
	const propPath = path.join(cwd, "sonar-project.properties");

	try {
		const content = await fs.readFile(propPath, "utf8");
		const getProp = (key: string): string | undefined => {
			const line = content.split("\n").find((l) => l.startsWith(`sonar.${key}=`));
			return line?.split("=").slice(1).join("=").trim();
		};

		const projectKey = getProp("projectKey");
		const organization = getProp("organization");

		if (projectKey && organization) {
			return { projectKey, organization, baseUrl: "https://sonarcloud.io/api" };
		}
	} catch {
		// No properties file — fall through
	}

	// Fallback to env vars
	const envProjectKey = process.env.SONAR_PROJECT_KEY;
	const envOrg = process.env.SONAR_ORGANIZATION;
	if (envProjectKey && envOrg) {
		return {
			projectKey: envProjectKey,
			organization: envOrg,
			baseUrl: process.env.SONAR_BASE_URL || "https://sonarcloud.io/api",
		};
	}

	throw new Error(
		"No SonarCloud config found. Create sonar-project.properties or set SONAR_PROJECT_KEY + SONAR_ORGANIZATION env vars.",
	);
}

// ── PR number detection ───────────────────────────────────────────────────────

// AIDEV-NOTE: exec lives on ExtensionAPI (pi), not on ExtensionCommandContext (ctx).
async function detectPrNumber(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("gh", ["pr", "view", "--json", "number", "-q", ".number"], {
		timeout: 10000,
	});
	if (result.code === 0 && result.stdout.trim()) {
		return result.stdout.trim();
	}
	throw new Error("Could not detect PR number. Provide it as argument: /sonarqube 283");
}

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
				config = await detectConfig(ctx.cwd);
			} catch (err) {
				ctx.ui.notify(String((err as Error).message), "error");
				return;
			}

			// 4. Detect PR number
			const prNumber = parsed.prNumber || (await detectPrNumber(pi));
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
			let allIssues: SonarIssue[] = [];
			let total = 0;
			let page = 1;
			try {
				while (true) {
					const data = (await sonarFetch(config.baseUrl, token, "issues/search", {
						componentKeys: config.projectKey,
						pullRequest: prNumber,
						issueStatuses: "OPEN,CONFIRMED",
						sinceLeakPeriod: "true",
						ps: "500",
						p: String(page),
					})) as IssuesResponse;

					allIssues = allIssues.concat(data.issues ?? []);
					total = data.total ?? allIssues.length;

					if (allIssues.length >= total || (data.issues ?? []).length < 500) break;
					page++;
				}
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
