/**
 * Shared SonarQube/SonarCloud utilities.
 *
 * Used by both the sonarqube and pr-quality extensions.
 * Keep this module pure (no pi API imports, no side effects).
 */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

// ── Shell exec helper ─────────────────────────────────────────────────────────

// AIDEV-NOTE: ExtensionCommandContext does not expose an exec helper, so we
// use node:child_process directly. Extensions run with full system permissions.
export async function localExec(
	cmd: string,
	args: string[],
	opts?: { timeout?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, {
			timeout: opts?.timeout,
			maxBuffer: 10 * 1024 * 1024, // 10 MB — GraphQL responses can be large
		});
		return { code: 0, stdout, stderr };
	} catch (err: unknown) {
		const e = err as { code?: number; stdout?: string; stderr?: string };
		return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CoverageMeasure {
	metric: string;
	value?: string;
	periods?: Array<{ index: number; value: string }>;
}

export interface CoverageResponse {
	component?: {
		measures: CoverageMeasure[];
	};
}

export interface SonarIssue {
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

export interface IssuesResponse {
	total?: number;
	issues: SonarIssue[];
	p?: number;
	ps?: number;
}

export interface CoverageAnalysis {
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

export interface IssuesAnalysis {
	total: number;
	bySeverity: Record<string, number>;
	byType: Record<string, number>;
	byFile: Array<{ file: string; count: number; issues: SonarIssue[] }>;
	byRule: Array<{ rule: string; count: number; severity: string; message: string }>;
	issues: SonarIssue[];
}

export interface FilterOptions {
	severity?: string[];
	types?: string[];
	files?: string;
}

export interface SonarConfig {
	projectKey: string;
	organization: string;
	baseUrl: string;
}

// ── Severity helpers ──────────────────────────────────────────────────────────

export const SEVERITY_ORDER: Record<string, number> = {
	BLOCKER: 0,
	CRITICAL: 1,
	MAJOR: 2,
	MINOR: 3,
	INFO: 4,
};

// AIDEV-NOTE: Emojis used intentionally here for terminal report readability (severity/type
// indicators in the generated sonarqube-report.md). Coding-standards "no emojis" rule applies
// to code comments and logic, not to user-facing report output.
export const SEVERITY_SYMBOLS: Record<string, string> = {
	BLOCKER: "🔴",
	CRITICAL: "🔴",
	MAJOR: "🟡",
	MINOR: "🔵",
	INFO: "🔵",
};

export const TYPE_SYMBOLS: Record<string, string> = {
	BUG: "🐛",
	VULNERABILITY: "🛡️",
	CODE_SMELL: "🧹",
	SECURITY_HOTSPOT: "🔒",
};

// ── SonarCloud API ────────────────────────────────────────────────────────────

export async function sonarFetch(
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
		throw new Error(
			`SonarCloud API ${resp.status}: ${resp.statusText}${body ? " — " + body.slice(0, 200) : ""}`,
		);
	}

	return resp.json();
}

// ── Coverage analysis ─────────────────────────────────────────────────────────

export function statusIcon(val: number, threshold = 80): string {
	if (val >= threshold) return "✅";
	if (val >= threshold - 10) return "⚠️";
	return "❌";
}

export function analyzeCoverage(data: CoverageResponse): CoverageAnalysis {
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

export function analyzeIssues(data: IssuesResponse, filter?: FilterOptions): IssuesAnalysis {
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

export async function detectSonarConfig(cwd: string): Promise<SonarConfig> {
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

// ── PR number detection via gh CLI ────────────────────────────────────────────

export async function detectPrNumber(fallbackHint = "/pr-quality"): Promise<string> {
	const result = await localExec("gh", ["pr", "view", "--json", "number", "-q", ".number"], {
		timeout: 10000,
	});
	if (result.code === 0 && result.stdout.trim()) {
		return result.stdout.trim();
	}
	throw new Error(`Could not detect PR number. Provide it as argument: ${fallbackHint} <PR_NUMBER>`);
}

// ── Issue pagination ──────────────────────────────────────────────────────────

export async function fetchAllIssues(
	baseUrl: string,
	token: string,
	projectKey: string,
	prNumber: string,
	signal?: AbortSignal,
): Promise<{ issues: SonarIssue[]; total: number }> {
	let allIssues: SonarIssue[] = [];
	let total = 0;
	let page = 1;

	while (true) {
		const data = (await sonarFetch(baseUrl, token, "issues/search", {
			componentKeys: projectKey,
			pullRequest: prNumber,
			issueStatuses: "OPEN,CONFIRMED",
			sinceLeakPeriod: "true",
			ps: "500",
			p: String(page),
		}, signal)) as IssuesResponse;

		allIssues = allIssues.concat(data.issues ?? []);
		total = data.total ?? allIssues.length;

		if (allIssues.length >= total || (data.issues ?? []).length < 500) break;
		page++;
	}

	return { issues: allIssues, total };
}
