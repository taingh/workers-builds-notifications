/**
 * Notification manager that handles sending notifications to multiple platforms.
 */

import type { Env } from "./types";
import type { Notifier, NotificationData } from "./notifiers/base";
import { SlackNotifier } from "./notifiers/slack";
import { LarkNotifier } from "./notifiers/lark";
import { DiscordNotifier } from "./notifiers/discord";

// =============================================================================
// NOTIFIER REGISTRY
// =============================================================================

interface NotifierConfig {
	notifier: Notifier;
	webhookUrlKey: keyof Env;
}

/**
 * Registry of all available notifiers with their environment variable keys.
 */
const NOTIFIERS: NotifierConfig[] = [
	{ notifier: new SlackNotifier(), webhookUrlKey: "SLACK_WEBHOOK_URL" },
	{ notifier: new LarkNotifier(), webhookUrlKey: "LARK_WEBHOOK_URL" },
	{ notifier: new DiscordNotifier(), webhookUrlKey: "DISCORD_WEBHOOK_URL" },
];

// =============================================================================
// NOTIFICATION MANAGER
// =============================================================================

/**
 * Sends notifications to all configured platforms.
 */
export async function sendNotifications(
	data: NotificationData,
	env: Env,
): Promise<void> {
	const promises: Promise<void>[] = [];

	for (const { notifier, webhookUrlKey } of NOTIFIERS) {
		const webhookUrl = env[webhookUrlKey];

		if (!webhookUrl) {
			continue; // Skip if webhook URL is not configured
		}

		const promise = (async () => {
			try {
				const payload = notifier.buildPayload({
					...data,
					larkFailMention: data.larkFailMention ?? env.LARK_FAIL_MENTION,
				});
				await notifier.send(webhookUrl, payload);
				// eslint-disable-next-line no-console
				console.log(`✓ Sent notification to ${notifier.name}`);
			} catch (error) {
				// eslint-disable-next-line no-console
				console.error(`✗ Failed to send to ${notifier.name}:`, error);
			}
		})();

		promises.push(promise);
	}

	if (promises.length === 0) {
		// eslint-disable-next-line no-console
		console.warn(
			"No notification webhooks configured. Set SLACK_WEBHOOK_URL, LARK_WEBHOOK_URL, or DISCORD_WEBHOOK_URL.",
		);
		return;
	}

	// Send to all platforms in parallel
	await Promise.all(promises);
}
