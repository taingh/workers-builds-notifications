/**
 * Base interfaces and types for notification adapters.
 */

import type { CloudflareEvent } from "../types";

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Data required to build a notification payload.
 */
export interface NotificationData {
	event: CloudflareEvent;
	previewUrl: string | null;
	liveUrl: string | null;
	logs: string[];
	larkFailMention?: string;
}

/**
 * Base interface that all notification adapters must implement.
 */
export interface Notifier {
	/** The name of the notifier (for logging purposes) */
	readonly name: string;

	/**
	 * Builds a platform-specific payload from the notification data.
	 */
	buildPayload(data: NotificationData): unknown;

	/**
	 * Sends the payload to the platform's webhook URL.
	 */
	send(webhookUrl: string, payload: unknown): Promise<void>;
}
