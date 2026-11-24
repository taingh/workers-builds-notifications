/**
 * Discord notifier using webhook embeds.
 * @see https://discord.com/developers/docs/resources/webhook
 * @see https://discord.com/developers/docs/resources/channel#embed-object
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

interface DiscordEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

interface DiscordEmbed {
	title?: string;
	description?: string;
	color?: number;
	fields?: DiscordEmbedField[];
	timestamp?: string;
	url?: string;
}

export interface DiscordPayload {
	embeds: DiscordEmbed[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Discord embed colors (decimal values) */
const COLORS = {
	SUCCESS: 0x28a745, // Green
	FAILURE: 0xdc3545, // Red
	CANCELLED: 0xffc107, // Yellow
	DEFAULT: 0x0366d6, // Blue
};

// =============================================================================
// FIELD BUILDERS
// =============================================================================

/**
 * Builds embed description with worker name, repository, and optional subdirectory.
 */
function buildDescription(event: CloudflareEvent): string {
	const workerName = event.source?.workerName || "Worker";
	const repo = getRepoInfo(event);
	const parts = [`**${workerName}**`];

	if (repo) {
		parts.push(repo.url ? `[${repo.name}](${repo.url})` : repo.name);
		if (repo.rootDirectory) {
			parts.push(`\`${repo.rootDirectory}\``);
		}
	}

	return parts.join(" · ");
}

/**
 * Builds embed fields from event metadata.
 */
function buildMetadataFields(event: CloudflareEvent): DiscordEmbedField[] {
	const meta = event.payload?.buildTriggerMetadata;
	const commitUrl = getCommitUrl(event);
	const fields: DiscordEmbedField[] = [];

	if (meta?.branch) {
		fields.push({
			name: "Branch",
			value: `\`${meta.branch}\``,
			inline: true,
		});
	}

	if (meta?.commitHash) {
		const commitText = meta.commitHash.substring(0, 7);
		const value = commitUrl
			? `[\`${commitText}\`](${commitUrl})`
			: `\`${commitText}\``;
		fields.push({
			name: "Commit",
			value,
			inline: true,
		});
	}

	const authorName = extractAuthorName(meta?.author);
	if (authorName) {
		fields.push({
			name: "Author",
			value: authorName,
			inline: true,
		});
	}

	const duration = formatDuration(event);
	if (duration) {
		fields.push({
			name: "Duration",
			value: `\`${duration}\``,
			inline: true,
		});
	}

	const trigger = formatTriggerSource(meta?.buildTriggerSource);
	if (trigger) {
		fields.push({
			name: "Trigger",
			value: trigger,
			inline: true,
		});
	}

	const commitMessage = formatCommitMessage(meta?.commitMessage);
	if (commitMessage) {
		fields.push({
			name: "Commit Message",
			value: commitMessage,
			inline: false,
		});
	}

	return fields;
}

// =============================================================================
// MESSAGE BUILDERS
// =============================================================================

function buildSuccessMessage(
	event: CloudflareEvent,
	isProduction: boolean,
	previewUrl: string | null,
	liveUrl: string | null,
): DiscordPayload {
	const dashUrl = getDashboardUrl(event);

	const title = isProduction ? "Production Deploy" : "Preview Deploy";
	const url = isProduction ? liveUrl || dashUrl : previewUrl || dashUrl;

	const fields = buildMetadataFields(event);

	const links: string[] = [];
	if (isProduction && liveUrl) {
		links.push(`[View Worker](${liveUrl})`);
	} else if (!isProduction && previewUrl) {
		links.push(`[View Preview](${previewUrl})`);
	}
	if (dashUrl) {
		links.push(`[View Build](${dashUrl})`);
	}

	if (links.length > 0) {
		fields.push({
			name: "Links",
			value: links.join(" · "),
			inline: false,
		});
	}

	const embed: DiscordEmbed = {
		title: `✅ ${title}`,
		description: buildDescription(event),
		color: COLORS.SUCCESS,
		fields,
		timestamp: event.payload.stoppedAt || event.metadata.eventTimestamp,
		...(url && { url }),
	};

	return { embeds: [embed] };
}

function buildFailureMessage(
	event: CloudflareEvent,
	logs: string[],
): DiscordPayload {
	const dashUrl = getDashboardUrl(event);
	const error = extractBuildError(logs);

	const fields = buildMetadataFields(event);

	// Add error field
	fields.push({
		name: "Error",
		value: `\`\`\`\n${error.substring(0, 1000)}\n\`\`\``,
		inline: false,
	});

	if (dashUrl) {
		fields.push({
			name: "Logs",
			value: `[View Full Logs](${dashUrl})`,
			inline: false,
		});
	}

	const embed: DiscordEmbed = {
		title: "❌ Build Failed",
		description: buildDescription(event),
		color: COLORS.FAILURE,
		fields,
		timestamp: event.payload.stoppedAt || event.metadata.eventTimestamp,
	};

	return { embeds: [embed] };
}

function buildCancelledMessage(event: CloudflareEvent): DiscordPayload {
	const dashUrl = getDashboardUrl(event);

	const fields = buildMetadataFields(event);

	if (dashUrl) {
		fields.push({
			name: "Build Details",
			value: `[View Build](${dashUrl})`,
			inline: false,
		});
	}

	const embed: DiscordEmbed = {
		title: "⚠️ Build Cancelled",
		description: buildDescription(event),
		color: COLORS.CANCELLED,
		fields,
		timestamp: event.payload.stoppedAt || event.metadata.eventTimestamp,
	};

	return { embeds: [embed] };
}

function buildFallbackMessage(event: CloudflareEvent): DiscordPayload {
	const embed: DiscordEmbed = {
		title: "📢 Build Event",
		description: event.type || "Unknown event",
		color: COLORS.DEFAULT,
		timestamp: event.metadata.eventTimestamp,
	};

	return { embeds: [embed] };
}

// =============================================================================
// NOTIFIER IMPLEMENTATION
// =============================================================================

export class DiscordNotifier implements Notifier {
	readonly name = "Discord";

	buildPayload(data: NotificationData): DiscordPayload {
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

	async send(webhookUrl: string, payload: DiscordPayload): Promise<void> {
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Discord API error: ${response.status} ${text}`);
		}
	}
}
