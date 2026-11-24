/**
 * Helper functions for processing build events.
 */

import type { CloudflareEvent, BuildStatus } from "./types";

// =============================================================================
// BUILD STATUS
// =============================================================================

/**
 * Determines the build status from a Cloudflare event.
 * Handles both "canceled" and "cancelled" spellings.
 */
export function getBuildStatus(event: CloudflareEvent): BuildStatus {
	const buildOutcome = event.payload?.buildOutcome;
	const isCancelled =
		buildOutcome === "canceled" ||
		buildOutcome === "cancelled" ||
		event.type?.includes("canceled") ||
		event.type?.includes("cancelled");
	const isFailed = event.type?.includes("failed") && !isCancelled;
	const isSucceeded = event.type?.includes("succeeded");

	return { isSucceeded, isFailed, isCancelled };
}

// =============================================================================
// BRANCH DETECTION
// =============================================================================

/**
 * Determines if a branch is a production branch.
 * Returns true for main, master, production, prod (case-insensitive).
 * Returns true for undefined (defaults to production).
 */
export function isProductionBranch(branch: string | undefined): boolean {
	if (!branch) return true;
	return ["main", "master", "production", "prod"].includes(
		branch.toLowerCase(),
	);
}

// =============================================================================
// METADATA EXTRACTION
// =============================================================================

/**
 * Extracts the author name from an email address.
 * "john.doe@example.com" -> "john.doe"
 * "johndoe" -> "johndoe"
 * "@username" -> "@username" (edge case)
 */
export function extractAuthorName(author: string | undefined): string | null {
	if (!author) return null;
	if (author.includes("@")) {
		const name = author.split("@")[0];
		return name || author; // Fallback if split yields empty string
	}
	return author;
}

/**
 * Generates a commit URL for GitHub or GitLab.
 * Returns null for unsupported providers or missing metadata.
 */
export function getCommitUrl(event: CloudflareEvent): string | null {
	const meta = event.payload?.buildTriggerMetadata;
	if (!meta?.repoName || !meta?.commitHash || !meta?.providerAccountName) {
		return null;
	}

	if (meta.providerType === "github") {
		return `https://github.com/${meta.providerAccountName}/${meta.repoName}/commit/${meta.commitHash}`;
	}
	if (meta.providerType === "gitlab") {
		return `https://gitlab.com/${meta.providerAccountName}/${meta.repoName}/-/commit/${meta.commitHash}`;
	}
	return null;
}

/**
 * Generates a Cloudflare dashboard URL for a build.
 */
export function getDashboardUrl(event: CloudflareEvent): string | null {
	const accountId = event.metadata?.accountId;
	const buildUuid = event.payload?.buildUuid;
	const workerName =
		event.source?.workerName ||
		event.payload?.buildTriggerMetadata?.repoName ||
		"worker";

	if (!accountId || !buildUuid) return null;

	return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/production/builds/${buildUuid}`;
}

export interface RepoInfo {
	name: string;
	url: string | null;
	rootDirectory: string | null;
}

/**
 * Extracts repository display name, URL, and non-root directory path.
 */
export function getRepoInfo(event: CloudflareEvent): RepoInfo | null {
	const meta = event.payload?.buildTriggerMetadata;
	if (!meta?.repoName) return null;

	const name = meta.providerAccountName
		? `${meta.providerAccountName}/${meta.repoName}`
		: meta.repoName;

	let url: string | null = null;
	if (meta.providerAccountName) {
		if (meta.providerType === "github") {
			url = `https://github.com/${meta.providerAccountName}/${meta.repoName}`;
		} else if (meta.providerType === "gitlab") {
			url = `https://gitlab.com/${meta.providerAccountName}/${meta.repoName}`;
		}
	}

	const normalizedDir = meta.rootDirectory?.trim().replace(/^\/+/, "");
	const rootDirectory = normalizedDir ? normalizedDir : null;

	return { name, url, rootDirectory };
}

/**
 * Formats a git commit message to its first non-empty line,
 * stripping backticks and truncating overly long subjects.
 */
export function formatCommitMessage(
	message: string | undefined,
	maxLength = 120,
): string | null {
	if (!message) return null;

	const firstLine = message
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);

	if (!firstLine) return null;

	const sanitized = firstLine.replace(/`/g, "'").replace(/\s+/g, " ");
	return truncate(sanitized, maxLength);
}

/**
 * Calculates and formats total build duration from createdAt to stoppedAt.
 */
export function formatDuration(event: CloudflareEvent): string | null {
	const createdAt = event.payload?.createdAt;
	const stoppedAt = event.payload?.stoppedAt;
	if (!createdAt || !stoppedAt) return null;

	const startMs = Date.parse(createdAt);
	const endMs = Date.parse(stoppedAt);
	if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
		return null;
	}

	const totalSeconds = Math.round((endMs - startMs) / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		const parts = [`${hours}h`];
		if (minutes > 0) parts.push(`${minutes}m`);
		if (seconds > 0) parts.push(`${seconds}s`);
		return parts.join(" ");
	}

	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

const TRIGGER_SOURCE_LABELS: Record<string, string> = {
	push_event: "Push",
	pull_request: "Pull Request",
	pull_request_event: "Pull Request",
	deploy_hook: "Deploy Hook",
	manual: "Manual",
	manual_trigger: "Manual",
	api: "API",
	schedule: "Schedule",
	scheduled: "Schedule",
};

/**
 * Formats a build trigger source into a readable short label.
 */
export function formatTriggerSource(source: string | undefined): string | null {
	const trimmed = source?.trim();
	if (!trimmed) return null;

	const mapped = TRIGGER_SOURCE_LABELS[trimmed.toLowerCase()];
	if (mapped) return mapped;

	return trimmed
		.replace(/_/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

// =============================================================================
// ERROR EXTRACTION
// =============================================================================

// Lines to ignore - these are build metadata, not errors
const IGNORE_PATTERNS = [
	/^Total Upload:/i,
	/^Total Size:/i,
	/\/\s*gzip:/i,
	/^\d+\.\d+\s*(KiB|MiB|B)/i,
	/^Uploaded/i,
	/^Published/i,
	/^Worker Startup Time:/i,
	/^🌀/,
];

// Primary error patterns (most specific first)
const ERROR_PATTERNS = [
	/^✘\s*\[ERROR\]/i, // ✘ [ERROR] ...
	/^\[ERROR\]/i, // [ERROR] ...
	/^ERROR:/i, // ERROR: ...
	/^Error:/, // Error: ...
	/^❌/, // ❌ ...
];

// Fallback error keywords
const ERROR_KEYWORDS = [
	"Module not found",
	"Cannot find module",
	"Compilation failed",
	"Build failed",
	"SyntaxError:",
	"TypeError:",
	"ReferenceError:",
	"failed to",
	"Failed to",
];

/**
 * Extracts the most relevant error message from build logs.
 * Looks for the FIRST error (root cause) rather than the last.
 * Truncates long errors to 500 characters.
 */
export function extractBuildError(logs: string[]): string {
	if (!logs || logs.length === 0) {
		return "No logs available";
	}

	// Look for the FIRST error (not last) - it's usually the root cause
	for (let i = 0; i < logs.length; i++) {
		const line = logs[i];
		if (!line?.trim()) continue;
		if (line.trim().startsWith("at ")) continue; // Skip stack traces
		if (IGNORE_PATTERNS.some((pattern) => pattern.test(line))) continue;

		if (ERROR_PATTERNS.some((pattern) => pattern.test(line))) {
			let errorMsg = line.trim();

			// Include next line as context if it's not a stack trace or metadata
			if (logs[i + 1]) {
				const nextLine = logs[i + 1].trim();
				if (
					nextLine &&
					!nextLine.startsWith("at ") &&
					!IGNORE_PATTERNS.some((pattern) => pattern.test(nextLine))
				) {
					errorMsg += "\n" + nextLine;
				}
			}

			return truncate(errorMsg, 500);
		}
	}

	// Fallback: look for common error keywords
	for (let i = 0; i < logs.length; i++) {
		const line = logs[i];
		if (!line?.trim()) continue;
		if (IGNORE_PATTERNS.some((pattern) => pattern.test(line))) continue;

		if (ERROR_KEYWORDS.some((keyword) => line.includes(keyword))) {
			return truncate(line.trim(), 500);
		}
	}

	// Last resort: return last non-empty, non-metadata line
	for (let i = logs.length - 1; i >= 0; i--) {
		const line = logs[i]?.trim();
		if (line && !IGNORE_PATTERNS.some((pattern) => pattern.test(line))) {
			return truncate(line, 500);
		}
	}

	return "Build failed";
}

function truncate(str: string, maxLength: number): string {
	return str.length > maxLength ? str.substring(0, maxLength) + "..." : str;
}
