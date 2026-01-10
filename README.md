# Workers Builds Notifications

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/workers-builds-notifications-template)

<!-- dash-content-start -->

Get notified when your Workers Builds complete, fail, or are cancelled. This template uses [Queue Event Subscriptions](https://developers.cloudflare.com/queues/event-subscriptions/) to consume Workers Builds events and forward them to **Slack, Lark/Feishu, Discord**, or any combination of these platforms.

## Features

- 🔔 Real-time notifications for build success, failure, and cancellation
- 🔗 Multi-platform support: **Slack**, **Lark/Feishu**, and **Discord**
- 🎯 Flexible configuration: use one or all platforms simultaneously
- 📋 Includes build details: project name, branch, commit, and author
- 📜 Smart error extraction for failed builds, preview URL and live deployment URL for successful builds
- 🎨 Platform-optimized message formats (Block Kit for Slack, Interactive Cards for Lark, Embeds for Discord)

## How It Works

1. Workers Builds emits events to a Cloudflare Queue
2. This Worker consumes those events via Queue Event Subscriptions
3. Build details are formatted and sent to your configured webhook

<!-- dash-content-end -->

## Getting Started

Outside of this repo, you can start a new project with this template using [C3](https://developers.cloudflare.com/pages/get-started/c3/) (the `create-cloudflare` CLI):

```bash
npm create cloudflare@latest -- --template=cloudflare/templates/workers-builds-notifications-template
```

---

## Setup

> **Important:** The queue must be created before deploying the worker.

### 1. Create a Queue

#### Option A: Via Dashboard

1. Go to [Queues](https://dash.cloudflare.com/?to=/:account/workers/queues)
2. Click **Create Queue**
3. Name it `builds-event-subscriptions` (or your preferred name)
4. Click **Create**

#### Option B: Via CLI

```bash
wrangler queues create builds-event-subscriptions
```

> **Note:** The queue name must match what's in `wrangler.jsonc`:
>
> ```jsonc
> "queues": {
>   "consumers": [
>     {
>       "queue": "builds-event-subscriptions",  // ← Must match your queue name
>       ...
>     }
>   ]
> }
> ```
>
> If you use a different queue name, update `wrangler.jsonc` before deploying.

---

### 2. Deploy the Worker

#### Option A: Via Dashboard

1. Go to [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → **Create** → **Import a repository**
2. Connect your GitHub/GitLab and select this repository
3. Deploy

#### Option B: Via CLI

```bash
git clone https://github.com/cloudflare/templates.git
cd templates/workers-builds-notifications-template
npm install
wrangler deploy
```

---

### 3. Create Webhooks

Configure one or more platforms below. You can use all three simultaneously!

#### Slack

1. Go to [Slack Apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g., "Workers Builds Notifications") and select your workspace
3. Go to **Incoming Webhooks** → Toggle **On**
4. Click **Add New Webhook to Workspace** → Select your channel
5. Copy the webhook URL (starts with `https://hooks.slack.com/services/...`)

#### Lark/Feishu

1. Open your Lark/Feishu group chat
2. Click on **Group Settings** (top right) → **Bots** → **Add Bot**
3. Select **Custom Bot** → Enter a name and description
4. Copy the webhook URL (starts with `https://open.feishu.cn/open-apis/bot/v2/hook/...`)
5. Click **Finish**

#### Discord

1. Go to your Discord server → **Server Settings** → **Integrations** → **Webhooks**
2. Click **New Webhook** → Name it and select your channel
3. Copy the webhook URL (starts with `https://discord.com/api/webhooks/...`)
4. Click **Save**

---

### 4. Create a Cloudflare API Token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token** → **Create Custom Token**
3. Add the following permissions:
   - **Workers Builds Configuration**: Read
   - **Workers Scripts**: Read
4. Click **Continue to summary** → **Create Token**
5. Copy the token

---

### 5. Set Environment Variables

Configure at least one webhook URL. You can add all three to send notifications to multiple platforms!

> **💡 Tip**: When deploying via the "Deploy to Cloudflare Workers" button or dashboard, these environment variables will be automatically shown in the deployment interface for easy configuration.

#### Option A: Via Dashboard (Deployment Interface)

When deploying through the dashboard, you'll be prompted to fill in:
   - `SLACK_WEBHOOK_URL` → Your Slack webhook URL (optional)
   - `LARK_WEBHOOK_URL` → Your Lark/Feishu webhook URL (optional)
   - `DISCORD_WEBHOOK_URL` → Your Discord webhook URL (optional)
   - `CLOUDFLARE_API_TOKEN` → Your API token (required)

#### Option B: Via Dashboard (After Deployment)

1. Go to [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. Select your deployed worker
3. Go to **Settings** → **Variables and Secrets**
4. Update the environment variables as needed

#### Option C: Via CLI (For Advanced Users)

```bash
# Add at least one webhook
wrangler secret put SLACK_WEBHOOK_URL
# Paste your Slack webhook URL (or skip)

wrangler secret put LARK_WEBHOOK_URL
# Paste your Lark webhook URL (or skip)

wrangler secret put DISCORD_WEBHOOK_URL
# Paste your Discord webhook URL (or skip)

# Required: Cloudflare API token
wrangler secret put CLOUDFLARE_API_TOKEN
# Paste your API token
```

---

### 6. Create an Event Subscription

Subscribe your queue to Workers Builds events.

#### Option A: Via Dashboard

1. Go to [Queues](https://dash.cloudflare.com/?to=/:account/workers/queues)
2. Select your queue (`builds-event-subscriptions`)
3. Go to the **Subscriptions** tab
4. Click **Subscribe to events**
5. Select source: **Workers Builds**
6. Select events: All (or specific ones)
7. Click **Subscribe**

#### Option B: Via CLI

```bash
wrangler queues subscription create builds-event-subscriptions \
  --source workersBuilds.worker \
  --events build.succeeded,build.failed \
  --worker-name <YOUR_CONSUMER_WORKER_NAME>
```

> For more details, see [Event Subscriptions Documentation](https://developers.cloudflare.com/queues/event-subscriptions/)

---

### 7. Test It!

Trigger a build on any worker in your account. You should see a notification in your channel within seconds!

---

## Architecture

```
┌─────────────────┐     ┌─────────────┐     ┌──────────────────┐     ┌─────────┐
│ Workers Builds  │────▶│   Queue     │────▶│ This Consumer    │────▶│ Webhook │
│ (any worker)    │     │             │     │ Worker           │     │         │
└─────────────────┘     └─────────────┘     └──────────────────┘     └─────────┘
```

1. **Any worker** in your account triggers a build
2. **Workers Builds** publishes an event to your **Queue**
3. **This consumer worker** processes the event and sends a notification to your **webhook**

---

## Event Types

| Event                           | Notification      |
| ------------------------------- | ----------------- |
| ✅ Build succeeded (production) | Live Worker URL   |
| ✅ Build succeeded (preview)    | Preview URL       |
| ❌ Build failed                 | Error message     |
| ⚠️ Build cancelled              | Cancellation note |

> **Note:** Build started/queued events are acknowledged but do not send notifications.

---

## Event Schema

```json
{
	"type": "cf.workersBuilds.worker.build.succeeded",
	"source": {
		"type": "workersBuilds.worker",
		"workerName": "my-worker"
	},
	"payload": {
		"buildUuid": "build-12345678-90ab-cdef-1234-567890abcdef",
		"status": "stopped",
		"buildOutcome": "success",
		"createdAt": "2025-05-01T02:48:57.132Z",
		"stoppedAt": "2025-05-01T02:50:15.132Z",
		"buildTriggerMetadata": {
			"buildTriggerSource": "push_event",
			"branch": "main",
			"commitHash": "abc123def456",
			"commitMessage": "Fix bug in authentication",
			"author": "developer@example.com",
			"repoName": "my-worker-repo",
			"providerType": "github"
		}
	},
	"metadata": {
		"accountId": "your-account-id",
		"eventTimestamp": "2025-05-01T02:48:57.132Z"
	}
}
```

### Event Types Reference

| Event Type                                                           | Description                  |
| -------------------------------------------------------------------- | ---------------------------- |
| `cf.workersBuilds.worker.build.started`                              | Build has started            |
| `cf.workersBuilds.worker.build.succeeded`                            | Build completed successfully |
| `cf.workersBuilds.worker.build.failed`                               | Build failed                 |
| `cf.workersBuilds.worker.build.failed` + `buildOutcome: "cancelled"` | Build was cancelled          |

---

## Configuration

### Environment Variables

| Variable                | Required | Description                                                                  |
| ----------------------- | -------- | ---------------------------------------------------------------------------- |
| `SLACK_WEBHOOK_URL`     | No*      | Slack incoming webhook URL                                                   |
| `LARK_WEBHOOK_URL`      | No*      | Lark/Feishu webhook URL                                                      |
| `DISCORD_WEBHOOK_URL`   | No*      | Discord webhook URL                                                          |
| `CLOUDFLARE_API_TOKEN`  | Yes      | API token with Workers Builds Configuration: Read and Workers Scripts: Read |

\* At least one webhook URL must be configured

### Queue Settings (wrangler.jsonc)

| Setting             | Default | Description                          |
| ------------------- | ------- | ------------------------------------ |
| `max_batch_size`    | 10      | Messages per batch                   |
| `max_batch_timeout` | 30      | Seconds to wait for full batch       |
| `max_retries`       | 3       | Retry attempts for failed processing |

---

## Troubleshooting

### Deploy fails with "Queue does not exist"

The queue must be created before deploying. See [Step 1: Create a Queue](#1-create-a-queue).

### No notifications appearing

1. **Check the queue**: Dashboard → Queues → Your queue (are messages arriving?)
2. **Check worker logs**: Dashboard → Workers → Your consumer worker → Logs
3. **Verify subscription**: Dashboard → Queues → Your queue → Subscriptions tab

### "Invalid token" error in logs

- Verify `CLOUDFLARE_API_TOKEN` is set in worker settings
- Ensure token has correct permissions (Workers Builds Configuration: Read, Workers Scripts: Read)

### URLs not appearing

- **Preview URL missing**: Build was for main/master branch (shows Live URL instead)
- **Live URL missing**: Check token has correct permissions

### Notifications not appearing in some platforms

- Verify webhook URLs are correctly configured for each platform
- Check worker logs for platform-specific errors
- Test webhook URLs manually:
  - **Slack**: Use `curl` to send a test message
  - **Lark**: Verify webhook is not rate limited
  - **Discord**: Ensure webhook URL is complete and valid

---

## Learn More

- [Queue Event Subscriptions](https://developers.cloudflare.com/queues/event-subscriptions/)
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
