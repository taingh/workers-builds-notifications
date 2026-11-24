/**
 * Slack notifier using Block Kit message formatting.
 */

import type {
	SectionBlock,
	ContextBlock,
	ActionsBlock,
	KnownBlock,
	MrkdwnElement,
	Button,
} from "@slack/types";

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

export interface SlackPayload {
	blocks: KnownBlock[];
}

// =============================================================================
// BLOCK BUILDERS
// =============================================================================

/**
 * Builds a section block with optional button accessory.
 */
function buildSectionBlock(
	text: string,
	buttonText?: string,
	buttonUrl?: string | null,
	buttonStyle?: Button["style"],
): SectionBlock {
	const block: SectionBlock = {
		type: "section",
		text: { type: "mrkdwn", text },
	};

	if (buttonText && buttonUrl) {
		block.accessory = {
			type: "button",
			text: { type: "plain_text", text: buttonText },
			url: buttonUrl,
			...(buttonStyle && { style: buttonStyle }),
		};
	}

	return block;
}

/**
 * Builds a context block from mrkdwn elements.
 */
function buildContextBlock(elements: MrkdwnElement[]): ContextBlock {
	return { type: "context", elements };
}

function escapeMrkdwn(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Builds the worker and repository header line.
 */
function buildWorkerHeader(event: CloudflareEvent): string {
	const workerName = event.source?.workerName || "Worker";
	const repo = getRepoInfo(event);
	const parts = [`*${workerName}*`];

	if (repo) {
		parts.push(repo.url ? `<${repo.url}|${repo.name}>` : repo.name);
		if (repo.rootDirectory) {
			parts.push(`\`${repo.rootDirectory}\``);
		}
	}

	return parts.join(" · ");
}

/**
 * Builds context elements (branch, commit, author, duration, trigger) from event metadata.
 */
function buildContextElements(event: CloudflareEvent): MrkdwnElement[] {
	const meta = event.payload?.buildTriggerMetadata;
	const commitUrl = getCommitUrl(event);
	const elements: MrkdwnElement[] = [];

	if (meta?.branch) {
		elements.push({
			type: "mrkdwn",
			text: `*Branch:* \`${meta.branch}\``,
		});
	}

	if (meta?.commitHash) {
		const commitText = meta.commitHash.substring(0, 7);
		elements.push({
			type: "mrkdwn",
			text: `*Commit:* ${commitUrl ? `<${commitUrl}|${commitText}>` : `\`${commitText}\``}`,
		});
	}

	const authorName = extractAuthorName(meta?.author);
	if (authorName) {
		elements.push({ type: "mrkdwn", text: `*Author:* ${authorName}` });
	}

	const duration = formatDuration(event);
	if (duration) {
		elements.push({ type: "mrkdwn", text: `*Duration:* \`${duration}\`` });
	}

	const trigger = formatTriggerSource(meta?.buildTriggerSource);
	if (trigger) {
		elements.push({ type: "mrkdwn", text: `*Trigger:* ${trigger}` });
	}

	return elements;
}

/**
 * Appends metadata context and commit message blocks to the payload.
 */
function appendMetadataAndMessage(
	blocks: KnownBlock[],
	event: CloudflareEvent,
): void {
	const contextElements = buildContextElements(event);
	if (contextElements.length > 0) {
		blocks.push(buildContextBlock(contextElements));
	}

	const commitMessage = formatCommitMessage(
		event.payload?.buildTriggerMetadata?.commitMessage,
	);
	if (commitMessage) {
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Message:* ${escapeMrkdwn(commitMessage)}`,
			},
		});
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
): SlackPayload {
	const dashUrl = getDashboardUrl(event);

	const title = isProduction ? "Production Deploy" : "Preview Deploy";
	const targetUrl = isProduction ? liveUrl : previewUrl;
	const primaryText = isProduction ? "View Worker" : "View Preview";

	const blocks: KnownBlock[] = [
		buildSectionBlock(`✅  *${title}*\n${buildWorkerHeader(event)}`),
	];

	appendMetadataAndMessage(blocks, event);

	const buttons: Button[] = [];
	if (targetUrl) {
		buttons.push({
			type: "button",
			text: { type: "plain_text", text: primaryText },
			url: targetUrl,
			style: "primary",
		});
	}
	if (dashUrl) {
		buttons.push({
			type: "button",
			text: { type: "plain_text", text: "View Build" },
			url: dashUrl,
			...(!targetUrl && { style: "primary" }),
		});
	}

	if (buttons.length > 0) {
		const actionsBlock: ActionsBlock = {
			type: "actions",
			elements: buttons,
		};
		blocks.push(actionsBlock);
	}

	return { blocks };
}

function buildFailureMessage(
	event: CloudflareEvent,
	logs: string[],
): SlackPayload {
	const dashUrl = getDashboardUrl(event);
	const error = extractBuildError(logs);

	const blocks: KnownBlock[] = [
		buildSectionBlock(
			`❌  *Build Failed*\n${buildWorkerHeader(event)}`,
			dashUrl ? "View Logs" : undefined,
			dashUrl,
			"danger",
		),
	];

	appendMetadataAndMessage(blocks, event);

	// Error message in code block
	blocks.push({
		type: "section",
		text: { type: "mrkdwn", text: `\`\`\`${error}\`\`\`` },
	});

	return { blocks };
}

function buildCancelledMessage(event: CloudflareEvent): SlackPayload {
	const dashUrl = getDashboardUrl(event);

	const blocks: KnownBlock[] = [
		buildSectionBlock(
			`⚠️  *Build Cancelled*\n${buildWorkerHeader(event)}`,
			dashUrl ? "View Build" : undefined,
			dashUrl,
		),
	];

	appendMetadataAndMessage(blocks, event);

	return { blocks };
}

function buildFallbackMessage(event: CloudflareEvent): SlackPayload {
	return {
		blocks: [
			{
				type: "section",
				text: { type: "mrkdwn", text: `📢 ${event.type || "Unknown event"}` },
			},
		],
	};
}

// =============================================================================
// NOTIFIER IMPLEMENTATION
// =============================================================================

export class SlackNotifier implements Notifier {
	readonly name = "Slack";

	buildPayload(data: NotificationData): SlackPayload {
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

	async send(webhookUrl: string, payload: SlackPayload): Promise<void> {
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			throw new Error(
				`Slack API error: ${response.status} ${await response.text()}`,
			);
		}
	}
}
