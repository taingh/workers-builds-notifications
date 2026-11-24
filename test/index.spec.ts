import { env, createMessageBatch } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type CloudflareEvent } from "../src/index";
import {
	extractBuildError,
	formatCommitMessage,
	formatDuration,
	formatTriggerSource,
	getRepoInfo,
} from "../src/helpers";

// =============================================================================
// UNIT TESTS: Helper Functions
// =============================================================================

describe("Helper Functions", () => {
	describe("extractBuildError", () => {
		it("should extract first error and ignore subsequent errors", () => {
			const logs = [
				"Installing dependencies...",
				'✘ [ERROR] Could not resolve "missing-module"',
				"    at /src/index.ts:10:5", // Stack trace - should be skipped
				"✘ [ERROR] Second error",
			];
			const error = extractBuildError(logs);
			expect(error).toContain("Could not resolve");
			expect(error).not.toContain("Second error");
		});

		it("should return fallback message for empty logs", () => {
			expect(extractBuildError([])).toBe("No logs available");
		});

		it("should skip metadata lines when extracting errors", () => {
			const logs = [
				"Total Upload: 100 KiB",
				"Worker Startup Time: 5ms",
				"✘ [ERROR] Actual error here",
			];
			expect(extractBuildError(logs)).toContain("Actual error here");
		});
	});

	describe("formatCommitMessage", () => {
		it("should extract first non-empty line and sanitize backticks", () => {
			expect(
				formatCommitMessage("\n  feat: handle `foo` case\n\nBody details here"),
			).toBe("feat: handle 'foo' case");
		});

		it("should truncate long messages", () => {
			const long = "a".repeat(150);
			const formatted = formatCommitMessage(long, 120);
			expect(formatted).toBe(`${"a".repeat(120)}...`);
		});

		it("should return null for empty or whitespace-only messages", () => {
			expect(formatCommitMessage(undefined)).toBeNull();
			expect(formatCommitMessage("   \n  ")).toBeNull();
		});
	});

	describe("formatDuration", () => {
		it("should format seconds, minutes, and hours", () => {
			expect(
				formatDuration(
					createMockEvent({
						payload: {
							buildUuid: "b1",
							status: "stopped",
							buildOutcome: "success",
							createdAt: "2025-05-01T02:48:00.000Z",
							stoppedAt: "2025-05-01T02:48:42.000Z",
						},
					}),
				),
			).toBe("42s");

			expect(
				formatDuration(
					createMockEvent({
						payload: {
							buildUuid: "b2",
							status: "stopped",
							buildOutcome: "success",
							createdAt: "2025-05-01T02:48:57.132Z",
							stoppedAt: "2025-05-01T02:50:15.132Z",
						},
					}),
				),
			).toBe("1m 18s");
		});

		it("should return null when stoppedAt is missing or invalid", () => {
			expect(
				formatDuration(
					createMockEvent({
						payload: {
							buildUuid: "b3",
							status: "running",
							buildOutcome: null,
							createdAt: "2025-05-01T02:48:57.132Z",
						},
					}),
				),
			).toBeNull();
		});
	});

	describe("formatTriggerSource", () => {
		it("should map known trigger sources and format unknown ones", () => {
			expect(formatTriggerSource("push_event")).toBe("Push");
			expect(formatTriggerSource("deploy_hook")).toBe("Deploy Hook");
			expect(formatTriggerSource("manual")).toBe("Manual");
			expect(formatTriggerSource("custom_event")).toBe("Custom Event");
			expect(formatTriggerSource(undefined)).toBeNull();
		});
	});

	describe("getRepoInfo", () => {
		it("should extract repo name, url, and non-root directory", () => {
			const info = getRepoInfo(
				createMockEvent({
					payload: {
						buildUuid: "b1",
						status: "stopped",
						buildOutcome: "success",
						createdAt: "2025-05-01T02:48:57.132Z",
						buildTriggerMetadata: {
							buildTriggerSource: "push_event",
							branch: "main",
							commitHash: "abc123",
							commitMessage: "msg",
							author: "dev@example.com",
							buildCommand: "npm run build",
							deployCommand: "npm run deploy",
							rootDirectory: "/apps/web",
							repoName: "monorepo",
							providerAccountName: "taingh",
							providerType: "github",
						},
					},
				}),
			);

			expect(info).toEqual({
				name: "taingh/monorepo",
				url: "https://github.com/taingh/monorepo",
				rootDirectory: "apps/web",
			});
		});

		it("should return null rootDirectory when set to /", () => {
			const info = getRepoInfo(createMockEvent());
			expect(info?.rootDirectory).toBeNull();
		});
	});
});

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockEvent(
	overrides: Partial<CloudflareEvent> = {},
): CloudflareEvent {
	return {
		type: "cf.workersBuilds.worker.build.succeeded",
		source: {
			type: "workersBuilds.worker",
			workerName: "test-worker",
		},
		payload: {
			buildUuid: "build-12345678-90ab-cdef-1234-567890abcdef",
			status: "stopped",
			buildOutcome: "success",
			createdAt: "2025-05-01T02:48:57.132Z",
			stoppedAt: "2025-05-01T02:50:15.132Z",
			buildTriggerMetadata: {
				buildTriggerSource: "push_event",
				branch: "main",
				commitHash: "abc123def456",
				commitMessage: "Fix bug in authentication",
				author: "developer@example.com",
				buildCommand: "npm run build",
				deployCommand: "npm run deploy",
				rootDirectory: "/",
				repoName: "test-worker-repo",
				providerAccountName: "cloudflare",
				providerType: "github",
			},
		},
		metadata: {
			accountId: "test-account-id",
			eventSubscriptionId: "sub-123",
			eventSchemaVersion: 1,
			eventTimestamp: "2025-05-01T02:48:57.132Z",
		},
		...overrides,
	};
}

function createQueueMessage(
	event: CloudflareEvent,
): ServiceBindingQueueMessage<CloudflareEvent> {
	return {
		id: crypto.randomUUID(),
		timestamp: new Date(),
		attempts: 1,
		body: event,
	};
}

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe("Workers Builds Notifications", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; init?: RequestInit }>;
	let slackPayloads: any[];
	let larkPayloads: any[];
	let discordPayloads: any[];

	beforeEach(() => {
		fetchCalls = [];
		slackPayloads = [];
		larkPayloads = [];
		discordPayloads = [];
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	function mockFetch(
		handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
	) {
		globalThis.fetch = async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = input.toString();
			fetchCalls.push({ url, init });

			// Capture webhook payloads for assertions
			if (url.includes("hooks.slack.com") && init?.body) {
				slackPayloads.push(JSON.parse(init.body as string));
			}
			if (url.includes("open.feishu.cn") && init?.body) {
				larkPayloads.push(JSON.parse(init.body as string));
			}
			if (url.includes("discord.com/api/webhooks") && init?.body) {
				discordPayloads.push(JSON.parse(init.body as string));
			}

			return handler(url, init);
		};
	}

	// =========================================================================
	// SUCCESS EVENTS
	// =========================================================================

	describe("Successful Builds", () => {
		it("should send production deploy notification with live URL", async () => {
			mockFetch((url) => {
				if (url.includes("/builds/builds/") && !url.includes("/logs")) {
					return new Response(JSON.stringify({ result: {} }));
				}
				if (url.includes("/subdomain")) {
					return new Response(
						JSON.stringify({ result: { subdomain: "my-account" } }),
					);
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent({
				type: "cf.workersBuilds.worker.build.succeeded",
				payload: {
					buildUuid: "build-123",
					status: "stopped",
					buildOutcome: "success",
					createdAt: "2025-05-01T02:48:57.132Z",
					buildTriggerMetadata: {
						buildTriggerSource: "push_event",
						branch: "main",
						commitHash: "abc123def456",
						commitMessage: "Deploy to production",
						author: "dev@example.com",
						buildCommand: "npm run build",
						deployCommand: "npm run deploy",
						rootDirectory: "/",
						repoName: "my-worker",
						providerAccountName: "cloudflare",
						providerType: "github",
					},
				},
			});

			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			await worker.queue(batch, env);

			expect(slackPayloads).toHaveLength(1);
			const payload = slackPayloads[0];
			expect(payload.blocks).toBeDefined();
			expect(payload.blocks[0].text.text).toContain("Production Deploy");
			expect(payload.blocks[0].text.text).toContain("test-worker");
		});

		it("should send preview deploy notification for feature branch", async () => {
			mockFetch((url) => {
				if (url.includes("/builds/builds/") && !url.includes("/logs")) {
					return new Response(
						JSON.stringify({
							result: { preview_url: "https://preview-abc123.workers.dev" },
						}),
					);
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent({
				type: "cf.workersBuilds.worker.build.succeeded",
				payload: {
					buildUuid: "build-123",
					status: "stopped",
					buildOutcome: "success",
					createdAt: "2025-05-01T02:48:57.132Z",
					buildTriggerMetadata: {
						buildTriggerSource: "push_event",
						branch: "feature/new-feature",
						commitHash: "def456abc789",
						commitMessage: "Add new feature",
						author: "dev@example.com",
						buildCommand: "npm run build",
						deployCommand: "npm run deploy",
						rootDirectory: "/",
						repoName: "my-worker",
						providerAccountName: "cloudflare",
						providerType: "github",
					},
				},
			});

			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			await worker.queue(batch, env);

			expect(slackPayloads).toHaveLength(1);
			const payload = slackPayloads[0];
			expect(payload.blocks[0].text.text).toContain("Preview Deploy");
		});
	});

	// =========================================================================
	// FAILED BUILDS
	// =========================================================================

	describe("Failed Builds", () => {
		it("should send failure notification with error message", async () => {
			mockFetch((url) => {
				if (url.includes("/logs")) {
					return new Response(
						JSON.stringify({
							result: {
								lines: [
									[1, "Installing dependencies..."],
									[2, "Building worker..."],
									[3, '✘ [ERROR] Could not resolve "missing-module"'],
									[4, "Build failed"],
								],
								truncated: false,
							},
						}),
					);
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent({
				type: "cf.workersBuilds.worker.build.failed",
				payload: {
					buildUuid: "build-failed-123",
					status: "stopped",
					buildOutcome: "failure",
					createdAt: "2025-05-01T02:48:57.132Z",
					stoppedAt: "2025-05-01T02:49:30.132Z",
					buildTriggerMetadata: {
						buildTriggerSource: "push_event",
						branch: "feature/broken",
						commitHash: "broken123",
						commitMessage: "This will fail",
						author: "dev@example.com",
						buildCommand: "npm run build",
						deployCommand: "npm run deploy",
						rootDirectory: "/",
						repoName: "my-worker",
						providerAccountName: "cloudflare",
						providerType: "github",
					},
				},
			});

			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			await worker.queue(batch, env);

			expect(slackPayloads).toHaveLength(1);
			const payload = slackPayloads[0];
			expect(payload.blocks[0].text.text).toContain("Build Failed");

			// Should have error in code block
			const errorBlock = payload.blocks.find((b: any) =>
				b.text?.text?.includes("```"),
			);
			expect(errorBlock).toBeDefined();
			expect(errorBlock.text.text).toContain("ERROR");
		});

		it("should extract first error from logs, not last", async () => {
			mockFetch((url) => {
				if (url.includes("/logs")) {
					return new Response(
						JSON.stringify({
							result: {
								lines: [
									[1, "Starting build..."],
									[2, "✘ [ERROR] First error - this is the root cause"],
									[3, "✘ [ERROR] Second error - cascading failure"],
									[4, "✘ [ERROR] Third error - another cascade"],
								],
								truncated: false,
							},
						}),
					);
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent({
				type: "cf.workersBuilds.worker.build.failed",
				payload: {
					buildUuid: "build-123",
					status: "stopped",
					buildOutcome: "failure",
					createdAt: "2025-05-01T02:48:57.132Z",
				},
			});

			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			await worker.queue(batch, env);

			const errorBlock = slackPayloads[0].blocks.find((b: any) =>
				b.text?.text?.includes("```"),
			);
			expect(errorBlock.text.text).toContain("First error");
		});

		it("should include View Logs button with dashboard URL", async () => {
			mockFetch((url) => {
				if (url.includes("/logs")) {
					return new Response(
						JSON.stringify({
							result: { lines: [[1, "Error: Build failed"]], truncated: false },
						}),
					);
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent({
				type: "cf.workersBuilds.worker.build.failed",
				payload: {
					buildUuid: "build-uuid-123",
					status: "stopped",
					buildOutcome: "failure",
					createdAt: "2025-05-01T02:48:57.132Z",
				},
				metadata: {
					accountId: "account-xyz",
					eventSubscriptionId: "sub-123",
					eventSchemaVersion: 1,
					eventTimestamp: "2025-05-01T02:48:57.132Z",
				},
			});

			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			await worker.queue(batch, env);

			const payload = slackPayloads[0];
			expect(payload.blocks[0].accessory).toBeDefined();
			expect(payload.blocks[0].accessory.text.text).toBe("View Logs");
			expect(payload.blocks[0].accessory.url).toContain("dash.cloudflare.com");
			expect(payload.blocks[0].accessory.url).toContain("account-xyz");
		});
	});

	// =========================================================================
	// CANCELLED BUILDS
	// =========================================================================

	describe("Cancelled Builds", () => {
		it("should send cancellation notification (cancelled spelling)", async () => {
			mockFetch((url) => {
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent({
				type: "cf.workersBuilds.worker.build.failed",
				payload: {
					buildUuid: "build-cancelled-123",
					status: "stopped",
					buildOutcome: "cancelled",
					createdAt: "2025-05-01T02:48:57.132Z",
				},
			});

			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			await worker.queue(batch, env);

			expect(slackPayloads).toHaveLength(1);
			expect(slackPayloads[0].blocks[0].text.text).toContain("Build Cancelled");
		});

		it("should not fetch logs for cancelled builds", async () => {
			mockFetch((url) => {
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent({
				type: "cf.workersBuilds.worker.build.failed",
				payload: {
					buildUuid: "build-123",
					status: "stopped",
					buildOutcome: "cancelled",
					createdAt: "2025-05-01T02:48:57.132Z",
				},
			});

			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			await worker.queue(batch, env);

			const logsCall = fetchCalls.find((call) => call.url.includes("/logs"));
			expect(logsCall).toBeUndefined();
		});
	});

	// =========================================================================
	// ERROR HANDLING
	// =========================================================================

	describe("Error Handling", () => {
		it("should handle missing all webhook URLs gracefully", async () => {
			const event = createMockEvent();
			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			const envWithoutWebhooks = {
				...env,
				SLACK_WEBHOOK_URL: "",
				LARK_WEBHOOK_URL: "",
				DISCORD_WEBHOOK_URL: "",
			};

			// Should not throw
			await worker.queue(batch, envWithoutWebhooks as typeof env);
		});

		it("should handle API errors gracefully and still send notification", async () => {
			mockFetch((url) => {
				if (url.includes("api.cloudflare.com")) {
					throw new Error("Network error");
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent();
			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			// Should not throw and should still send notification
			await worker.queue(batch, env);
			expect(slackPayloads).toHaveLength(1);
		});
	});

	// =========================================================================
	// BATCH PROCESSING
	// =========================================================================

	describe("Batch Processing", () => {
		it("should process multiple messages and skip started/queued events", async () => {
			mockFetch((url) => {
				if (url.includes("/builds/builds/") && !url.includes("/logs")) {
					return new Response(JSON.stringify({ result: {} }));
				}
				if (url.includes("/subdomain")) {
					return new Response(
						JSON.stringify({ result: { subdomain: "test" } }),
					);
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const events = [
				createMockEvent({
					type: "cf.workersBuilds.worker.build.started",
					payload: {
						buildUuid: "build-1",
						status: "running",
						buildOutcome: null,
						createdAt: "2025-05-01T02:48:57.132Z",
					},
				}),
				createMockEvent({ type: "cf.workersBuilds.worker.build.succeeded" }),
			];

			const messages = events.map(createQueueMessage);
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			await worker.queue(batch, env);

			// Only the succeeded event should trigger a notification
			expect(slackPayloads).toHaveLength(1);
			expect(slackPayloads[0].blocks[0].text.text).toContain(
				"Production Deploy",
			);
		});
	});

	// =========================================================================
	// METADATA HANDLING
	// =========================================================================

	describe("Metadata Handling", () => {
		it("should handle missing buildTriggerMetadata gracefully", async () => {
			mockFetch((url) => {
				if (url.includes("/builds/builds/") && !url.includes("/logs")) {
					return new Response(JSON.stringify({ result: {} }));
				}
				if (url.includes("/subdomain")) {
					return new Response(
						JSON.stringify({ result: { subdomain: "test" } }),
					);
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent({
				payload: {
					buildUuid: "build-123",
					status: "stopped",
					buildOutcome: "success",
					createdAt: "2025-05-01T02:48:57.132Z",
					buildTriggerMetadata: undefined,
				},
			});

			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			// Should not throw
			await worker.queue(batch, env);
			expect(slackPayloads).toHaveLength(1);
		});
	});

	// =========================================================================
	// MULTI-PLATFORM SUPPORT
	// =========================================================================

	describe("Multi-Platform Support", () => {
		it("should send to multiple platforms simultaneously", async () => {
			mockFetch((url) => {
				if (url.includes("/builds/builds/") && !url.includes("/logs")) {
					return new Response(JSON.stringify({ result: {} }));
				}
				if (url.includes("/subdomain")) {
					return new Response(
						JSON.stringify({ result: { subdomain: "test" } }),
					);
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				if (url.includes("open.feishu.cn")) {
					return new Response(JSON.stringify({ code: 0, msg: "success" }));
				}
				if (url.includes("discord.com/api/webhooks")) {
					return new Response("", { status: 204 });
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent();
			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			const multiPlatformEnv = {
				...env,
				LARK_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
				DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/test",
			};

			await worker.queue(batch, multiPlatformEnv as typeof env);

			// Should send to all three platforms
			expect(slackPayloads).toHaveLength(1);
			expect(larkPayloads).toHaveLength(1);
			expect(discordPayloads).toHaveLength(1);

			// Verify Slack format
			expect(slackPayloads[0].blocks).toBeDefined();
			expect(slackPayloads[0].blocks[0].text.text).toContain(
				"Production Deploy",
			);
			expect(slackPayloads[0].blocks[0].text.text).toContain(
				"cloudflare/test-worker-repo",
			);
			const slackText = JSON.stringify(slackPayloads[0]);
			expect(slackText).toContain("Fix bug in authentication");
			expect(slackText).toContain("1m 18s");
			expect(slackText).toContain("Push");
			const slackActions = slackPayloads[0].blocks.find(
				(b: any) => b.type === "actions",
			);
			expect(slackActions?.elements).toHaveLength(2);
			expect(slackActions.elements[0].text.text).toBe("View Worker");
			expect(slackActions.elements[1].text.text).toBe("View Build");

			// Verify Lark format
			expect(larkPayloads[0].msg_type).toBe("interactive");
			expect(larkPayloads[0].card).toBeDefined();
			expect(larkPayloads[0].card.header.title.content).toContain(
				"Production Deploy",
			);
			const larkText = JSON.stringify(larkPayloads[0]);
			expect(larkText).toContain("cloudflare/test-worker-repo");
			expect(larkText).toContain("Fix bug in authentication");
			expect(larkText).toContain("1m 18s");
			expect(larkText).toContain("Push");
			expect(larkText).not.toContain("`main`");
			expect(larkText).not.toContain("`1m 18s`");
			const larkActions = larkPayloads[0].card.elements.find(
				(e: any) => e.tag === "action",
			);
			expect(larkActions?.actions).toHaveLength(2);
			expect(larkActions.actions[0].text.content).toBe("View Worker");
			expect(larkActions.actions[1].text.content).toBe("View Build");

			// Verify Discord format
			expect(discordPayloads[0].embeds).toBeDefined();
			expect(discordPayloads[0].embeds[0].title).toContain("Production Deploy");
			expect(discordPayloads[0].embeds[0].description).toContain(
				"cloudflare/test-worker-repo",
			);
			const discordFields = discordPayloads[0].embeds[0].fields;
			expect(discordFields).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "Duration", value: "`1m 18s`" }),
					expect.objectContaining({ name: "Trigger", value: "Push" }),
					expect.objectContaining({
						name: "Commit Message",
						value: "Fix bug in authentication",
						inline: false,
					}),
					expect.objectContaining({
						name: "Links",
						value: expect.stringContaining("View Build"),
					}),
				]),
			);
		});

		it("should work with only Lark configured", async () => {
			mockFetch((url) => {
				if (url.includes("/builds/builds/") && !url.includes("/logs")) {
					return new Response(JSON.stringify({ result: {} }));
				}
				if (url.includes("/subdomain")) {
					return new Response(
						JSON.stringify({ result: { subdomain: "test" } }),
					);
				}
				if (url.includes("open.feishu.cn")) {
					return new Response(JSON.stringify({ code: 0, msg: "success" }));
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent();
			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			const larkOnlyEnv = {
				...env,
				SLACK_WEBHOOK_URL: "",
				LARK_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
			};

			await worker.queue(batch, larkOnlyEnv as typeof env);

			expect(slackPayloads).toHaveLength(0);
			expect(larkPayloads).toHaveLength(1);
			expect(discordPayloads).toHaveLength(0);
		});

		it("should work with only Discord configured", async () => {
			mockFetch((url) => {
				if (url.includes("/builds/builds/") && !url.includes("/logs")) {
					return new Response(JSON.stringify({ result: {} }));
				}
				if (url.includes("/subdomain")) {
					return new Response(
						JSON.stringify({ result: { subdomain: "test" } }),
					);
				}
				if (url.includes("discord.com/api/webhooks")) {
					return new Response("", { status: 204 });
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent();
			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			const discordOnlyEnv = {
				...env,
				SLACK_WEBHOOK_URL: "",
				DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/test",
			};

			await worker.queue(batch, discordOnlyEnv as typeof env);

			expect(slackPayloads).toHaveLength(0);
			expect(larkPayloads).toHaveLength(0);
			expect(discordPayloads).toHaveLength(1);
		});

		it("should continue sending to other platforms if one fails", async () => {
			mockFetch((url) => {
				if (url.includes("/builds/builds/") && !url.includes("/logs")) {
					return new Response(JSON.stringify({ result: {} }));
				}
				if (url.includes("/subdomain")) {
					return new Response(
						JSON.stringify({ result: { subdomain: "test" } }),
					);
				}
				if (url.includes("hooks.slack.com")) {
					return new Response("Error", { status: 500 }); // Slack fails
				}
				if (url.includes("open.feishu.cn")) {
					return new Response(JSON.stringify({ code: 0, msg: "success" }));
				}
				if (url.includes("discord.com/api/webhooks")) {
					return new Response("", { status: 204 });
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent();
			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			const multiPlatformEnv = {
				...env,
				LARK_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
				DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/test",
			};

			// Should not throw even if Slack fails
			await worker.queue(batch, multiPlatformEnv as typeof env);

			// Lark and Discord should still receive notifications
			expect(larkPayloads).toHaveLength(1);
			expect(discordPayloads).toHaveLength(1);
		});
	});

	// =========================================================================
	// FALLBACK HANDLING
	// =========================================================================

	describe("Fallback Handling", () => {
		it("should send notification without URLs when CLOUDFLARE_API_TOKEN is missing", async () => {
			mockFetch((url) => {
				if (url.includes("hooks.slack.com")) {
					return new Response("ok");
				}
				if (url.includes("api.cloudflare.com")) {
					throw new Error("Should not call Cloudflare API without token");
				}
				return new Response("Not found", { status: 404 });
			});

			const event = createMockEvent();
			const messages = [createQueueMessage(event)];
			const batch = createMessageBatch("builds-event-subscriptions", messages);

			const envWithoutToken = { ...env, CLOUDFLARE_API_TOKEN: "" };
			await worker.queue(batch, envWithoutToken as typeof env);

			// Should still send notification without API token
			expect(slackPayloads).toHaveLength(1);
			expect(slackPayloads[0].blocks[0].text.text).toContain(
				"Production Deploy",
			);
		});
	});
});
