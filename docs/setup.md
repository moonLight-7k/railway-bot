# Setup Guide

## Requirements

- Node.js `24.x`
- npm
- A Discord server where you can add a bot
- A Railway account with projects and webhook access

## 1. Clone and install

```sh
git clone https://github.com/moonLight-7k/railway-bot.git
cd railway-bot
npm install
```

## 2. Build and run

```sh
npm run build
npm start
```

The app builds TypeScript into `dist/` and starts `dist/railwaybot.js`.

## 3. Environment variables

Create a `.env` file in the project root.

### Required

```env
DISCORD_TOKEN=
CLIENT_ID=
LOG_CHANNEL=
USAGE_CHANNEL=
RAILWAY_API_KEY=
```

### Optional

```env
WORKSPACE_ID=
INCIDENT_CHANNEL=
WEBHOOK_SECRET=
DB_PATH=./data/railwaybot.db
PORT=3000
RAILWAY_ENDPOINT=https://backboard.railway.com/graphql/v2
DIGEST_HOUR=9
USAGE_CRON=0 9 * * *
CPU_COST=0.000463
MEM_COST=0.000231
EGRESS_COST=0.1
```

## Variable reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `CLIENT_ID` | Yes | Discord application ID used to register slash commands |
| `LOG_CHANNEL` | Yes | Channel for deploy logs and general errors |
| `USAGE_CHANNEL` | Yes | Channel for usage reports and daily digest messages |
| `RAILWAY_API_KEY` | Yes | Railway API key used for usage queries |
| `WORKSPACE_ID` | No | Limits usage reporting to one Railway workspace |
| `INCIDENT_CHANNEL` | No | Channel for incidents. Falls back to `LOG_CHANNEL` |
| `WEBHOOK_SECRET` | No | Verifies the `x-railway-signature` header |
| `DB_PATH` | No | SQLite file path |
| `PORT` | No | HTTP port for the webhook server |
| `RAILWAY_ENDPOINT` | No | Railway GraphQL endpoint override |
| `DIGEST_HOUR` | No | Hour for the daily digest schedule |
| `USAGE_CRON` | No | Cron expression for usage and heartbeat jobs |
| `CPU_COST` | No | CPU pricing override for usage estimates |
| `MEM_COST` | No | Memory pricing override for usage estimates |
| `EGRESS_COST` | No | Egress pricing override for usage estimates |

## 4. Create the Discord app

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Create a new application.
3. Add a bot under the **Bot** tab.
4. Copy the bot token into `DISCORD_TOKEN`.
5. Copy the application ID into `CLIENT_ID`.
6. Generate an invite URL with these scopes:
   - `bot`
   - `applications.commands`
7. Give the bot these permissions:
   - `Send Messages`
   - `Embed Links`
   - `Create Public Threads`
   - `Send Messages in Threads`
   - `Use Application Commands`

## 5. Get Discord channel IDs

1. Enable Developer Mode in Discord.
2. Right-click a channel.
3. Click `Copy Channel ID`.

Suggested channels:

- `LOG_CHANNEL` for deploy logs
- `INCIDENT_CHANNEL` for failures and incidents
- `USAGE_CHANNEL` for usage and digest posts

## 6. Configure Railway webhooks

For each Railway project you want to monitor:

1. Open the project in Railway.
2. Go to `Settings -> Webhooks`.
3. Add a webhook pointing to:

```text
https://your-domain/railway
```

4. Enable at least deploy-related events.
5. If you use `WEBHOOK_SECRET`, configure the same secret in Railway.

## 7. Health endpoint

RailwayBot exposes:

```text
GET /health
```

It returns `200` when Discord and the database are both ready, otherwise `503`.

## 8. Deploying on Railway

1. Push the repository to GitHub.
2. Import `moonLight-7k/railway-bot` into Railway or import your fork.
3. Add the environment variables.
4. Make sure the service runs `npm run build` and `npm start`.
5. Mount persistent storage if you want SQLite data to survive redeploys.

## Troubleshooting

### Slash commands are missing

Check these first:

- `CLIENT_ID` is set
- `DISCORD_TOKEN` is valid
- The bot was reinvited after permission changes if needed

### No webhook events arrive

Check these first:

- Railway webhook URL points to `/railway`
- The deployed service is publicly reachable
- `WEBHOOK_SECRET` matches on both sides if enabled

### Usage reports do not post

Check these first:

- `WORKSPACE_ID` is set
- `RAILWAY_API_KEY` has access to the workspace
- `USAGE_CHANNEL` is a valid text channel ID
