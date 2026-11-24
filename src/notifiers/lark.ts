/**
 * Lark/Feishu notifier using interactive card messages.
 * @see https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
 */

import type { CloudflareEvent } from "../types";
import type { Notifier, NotificationData } from "./base";
import {
	getBuildStatus,
	isProductionBranch,
	extractAuthorName,
	getCommitUrl,
	getDashboardUrl,
	extractBuildError,
	getRepoInfo,
	formatCommitMessage,
	formatDuration,
	formatTriggerSource,
} from "../helpers";

// =============================================================================
// TYPES
// =============================================================================

interface LarkCardElement {
	tag: string;
	[key: string]: unknown;
}

interface LarkCard {
	config?: {
		wide_screen_mode?: boolean;
	};
	header?: {
		title: {
			tag: string;
			content: string;
		};
		template?: string;
	};
	elements: LarkCardElement[];
}

export interface LarkPayload {
	msg_type: "interactive";
	card: LarkCard;
}

// =============================================================================
// ELEMENT BUILDERS
// =============================================================================

/**
 * Builds a markdown element.
 */
function buildMarkdownElement(content: string): LarkCardElement {
	return {
		tag: "markdown",
		content,
	};
}

/**
 * Builds a horizontal rule (divider).
 */
function buildDivider(): LarkCardElement {
	return {
		tag: "hr",
	};
}

/**
 * Builds an action element with buttons.
 */
function buildAction(buttons: LarkCardElement[]): LarkCardElement {
	return {
		tag: "action",
		actions: buttons,
	};
}

/**
 * Builds a button element.
 */
function buildButton(
	text: string,
	url: string,
	type: "default" | "primary" | "danger" = "default",
): LarkCardElement {
	return {
		tag: "button",
		text: {
			tag: "plain_text",
			content: text,
		},
		type,
		url,
	};
}

/**
 * Builds the worker and repository header line.
 */
function buildWorkerHeader(event: CloudflareEvent): string {
	const workerName = event.source?.workerName || "Worker";
	const repo = getRepoInfo(event);
	const parts = [`**${workerName}**`];

	if (repo) {
		parts.push(repo.url ? `[${repo.name}](${repo.url})` : repo.name);
		if (repo.rootDirectory) {
			parts.push(repo.rootDirectory);
		}
	}

	return parts.join(" · ");
}

/**
 * Builds metadata fields from event.
 */
function buildMetadataContent(event: CloudflareEvent): string {
	const meta = event.payload?.buildTriggerMetadata;
	const commitUrl = getCommitUrl(event);
	const parts: string[] = [];

	if (meta?.branch) {
		parts.push(`**Branch:** ${meta.branch}`);
	}

	if (meta?.commitHash) {
		const commitText = meta.commitHash.substring(0, 7);
		if (commitUrl) {
			parts.push(`**Commit:** [${commitText}](${commitUrl})`);
		} else {
			parts.push(`**Commit:** ${commitText}`);
		}
	}

	const authorName = extractAuthorName(meta?.author);
	if (authorName) {
		parts.push(`**Author:** ${authorName}`);
	}

	const duration = formatDuration(event);
	if (duration) {
		parts.push(`**Duration:** ${duration}`);
	}

	const trigger = formatTriggerSource(meta?.buildTriggerSource);
	if (trigger) {
		parts.push(`**Trigger:** ${trigger}`);
	}

	return parts.join("\n");
}

/**
 * Appends metadata and commit message sections to card elements.
 */
function appendMetadataAndMessage(
	elements: LarkCardElement[],
	event: CloudflareEvent,
): void {
	const metadataContent = buildMetadataContent(event);
	if (metadataContent) {
		elements.push(buildDivider(), buildMarkdownElement(metadataContent));
	}

	const commitMessage = formatCommitMessage(
		event.payload?.buildTriggerMetadata?.commitMessage,
	);
	if (commitMessage) {
		elements.push(
			buildDivider(),
			buildMarkdownElement(`**Message:** ${commitMessage}`),
		);
	}
}

// =============================================================================
// MESSAGE BUILDERS
// =============================================================================

function buildSuccessMessage(
	event: CloudflareEvent,
	isProduction: boolean,
	previewUrl: string | null,
	liveUrl: string | null,
): LarkPayload {
	const dashUrl = getDashboardUrl(event);

	const title = isProduction ? "Production Deploy" : "Preview Deploy";
	const targetUrl = isProduction ? liveUrl : previewUrl;
	const primaryText = isProduction ? "View Worker" : "View Preview";

	const elements: LarkCardElement[] = [
		buildMarkdownElement(buildWorkerHeader(event)),
	];

	appendMetadataAndMessage(elements, event);

	const buttons: LarkCardElement[] = [];
	if (targetUrl) {
		buttons.push(buildButton(primaryText, targetUrl, "primary"));
	}
	if (dashUrl) {
		buttons.push(
			buildButton("View Build", dashUrl, targetUrl ? "default" : "primary"),
		);
	}

	if (buttons.length > 0) {
		elements.push(buildDivider(), buildAction(buttons));
	}

	return {
		msg_type: "interactive",
		card: {
			config: { wide_screen_mode: true },
			header: {
				title: {
					tag: "plain_text",
					content: `✅ ${title}`,
				},
				template: "green",
			},
			elements,
		},
	};
}

/**
 * Determines whether a failed Lark build card should mention @all.
 * Defaults to "production" (main/master/production/prod or missing branch).
 */
export function shouldMentionAllOnFailure(
	mode: string | undefined,
	branch: string | undefined,
): boolean {
	const normalized = mode?.trim().toLowerCase();
	if (normalized === "all") return true;
	if (normalized === "none" || normalized === "off") return false;
	return isProductionBranch(branch);
}

function buildFailureMessage(
	event: CloudflareEvent,
	logs: string[],
	larkFailMention?: string,
): LarkPayload {
	const dashUrl = getDashboardUrl(event);
	const error = extractBuildError(logs);
	const mentionPrefix = shouldMentionAllOnFailure(
		larkFailMention,
		event.payload?.buildTriggerMetadata?.branch,
	)
		? "<at id=all></at> "
		: "";

	const elements: LarkCardElement[] = [
		buildMarkdownElement(`${mentionPrefix}${buildWorkerHeader(event)}`),
	];

	appendMetadataAndMessage(elements, event);

	// Error message
	elements.push(
		buildDivider(),
		buildMarkdownElement(`\`\`\`\n${error}\n\`\`\``),
	);

	if (dashUrl) {
		elements.push(
			buildDivider(),
			buildAction([buildButton("View Logs", dashUrl, "danger")]),
		);
	}

	return {
		msg_type: "interactive",
		card: {
			config: { wide_screen_mode: true },
			header: {
				title: {
					tag: "plain_text",
					content: "❌ Build Failed",
				},
				template: "red",
			},
			elements,
		},
	};
}

function buildCancelledMessage(event: CloudflareEvent): LarkPayload {
	const dashUrl = getDashboardUrl(event);

	const elements: LarkCardElement[] = [
		buildMarkdownElement(buildWorkerHeader(event)),
	];

	appendMetadataAndMessage(elements, event);

	if (dashUrl) {
		elements.push(
			buildDivider(),
			buildAction([buildButton("View Build", dashUrl)]),
		);
	}

	return {
		msg_type: "interactive",
		card: {
			config: { wide_screen_mode: true },
			header: {
				title: {
					tag: "plain_text",
					content: "⚠️ Build Cancelled",
				},
				template: "yellow",
			},
			elements,
		},
	};
}

function buildFallbackMessage(event: CloudflareEvent): LarkPayload {
	return {
		msg_type: "interactive",
		card: {
			elements: [
				buildMarkdownElement(`📢 ${event.type || "Unknown event"}`),
			],
		},
	};
}

// =============================================================================
// NOTIFIER IMPLEMENTATION
// =============================================================================

export class LarkNotifier implements Notifier {
	readonly name = "Lark";

	buildPayload(data: NotificationData): LarkPayload {
		const { event, previewUrl, liveUrl, logs } = data;
		const status = getBuildStatus(event);
		const meta = event.payload?.buildTriggerMetadata;
		const isProduction = isProductionBranch(meta?.branch);

		if (status.isSucceeded) {
			return buildSuccessMessage(event, isProduction, previewUrl, liveUrl);
		}

		if (status.isFailed) {
			return buildFailureMessage(event, logs, data.larkFailMention);
		}

		if (status.isCancelled) {
			return buildCancelledMessage(event);
		}

		return buildFallbackMessage(event);
	}

	async send(webhookUrl: string, payload: LarkPayload): Promise<void> {
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Lark API error: ${response.status} ${text}`);
		}

		// Check Lark response format
		const result = (await response.json()) as { code: number; msg?: string };
		if (result.code !== 0) {
			throw new Error(`Lark API error: ${result.msg || "Unknown error"}`);
		}
	}
}
