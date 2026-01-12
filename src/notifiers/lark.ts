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
 * Builds metadata fields from event.
 */
function buildMetadataContent(event: CloudflareEvent): string {
	const meta = event.payload?.buildTriggerMetadata;
	const commitUrl = getCommitUrl(event);
	const parts: string[] = [];

	if (meta?.branch) {
		parts.push(`**Branch:** \`${meta.branch}\``);
	}

	if (meta?.commitHash) {
		const commitText = meta.commitHash.substring(0, 7);
		if (commitUrl) {
			parts.push(`**Commit:** [${commitText}](${commitUrl})`);
		} else {
			parts.push(`**Commit:** \`${commitText}\``);
		}
	}

	const authorName = extractAuthorName(meta?.author);
	if (authorName) {
		parts.push(`**Author:** ${authorName}`);
	}

	return parts.join("\n");
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
	const workerName = event.source?.workerName || "Worker";
	const dashUrl = getDashboardUrl(event);

	const title = isProduction ? "Production Deploy" : "Preview Deploy";
	const buttonText = isProduction
		? liveUrl
			? "View Worker"
			: "View Build"
		: previewUrl
			? "View Preview"
			: "View Build";
	const buttonUrl = isProduction ? liveUrl || dashUrl : previewUrl || dashUrl;

	const elements: LarkCardElement[] = [
		buildMarkdownElement(`**${workerName}**`),
	];

	const metadataContent = buildMetadataContent(event);
	if (metadataContent) {
		elements.push(buildDivider(), buildMarkdownElement(metadataContent));
	}

	if (buttonUrl) {
		elements.push(
			buildDivider(),
			buildAction([buildButton(buttonText, buttonUrl, "primary")]),
		);
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

function buildFailureMessage(
	event: CloudflareEvent,
	logs: string[],
): LarkPayload {
	const workerName = event.source?.workerName || "Worker";
	const dashUrl = getDashboardUrl(event);
	const error = extractBuildError(logs);

	const elements: LarkCardElement[] = [
		buildMarkdownElement(`**${workerName}**`),
	];

	const metadataContent = buildMetadataContent(event);
	if (metadataContent) {
		elements.push(buildDivider(), buildMarkdownElement(metadataContent));
	}

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
	const workerName = event.source?.workerName || "Worker";
	const dashUrl = getDashboardUrl(event);

	const elements: LarkCardElement[] = [
		buildMarkdownElement(`**${workerName}**`),
	];

	const metadataContent = buildMetadataContent(event);
	if (metadataContent) {
		elements.push(buildDivider(), buildMarkdownElement(metadataContent));
	}

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
			return buildFailureMessage(event, logs);
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
