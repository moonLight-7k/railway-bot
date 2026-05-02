<br />
<div align="center">
  <a href="https://github.com/LaCrak27/RailwayBot">
    <img src="https://devicons.railway.app/i/railway-dark.svg" alt="Logo" width="80" height="80">
  </a>

<h1 align="center">RailwayBot</h1>

  <p align="center">
    A Sentry-style incident management Discord bot for Railway. Track deployments, manage incidents, route alerts, and get usage reports — all from Discord.
    <br />
  </p>
</div>

---

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about">About</a></li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
        <li><a href="#environment-variables">Environment Variables</a></li>
      </ul>
    </li>
    <li><a href="#deploying-to-railway">Deploying to Railway</a></li>
    <li><a href="#setting-up-discord">Setting Up Discord</a></li>
    <li><a href="#setting-up-railway-webhooks">Setting Up Railway Webhooks</a></li>
    <li>
      <a href="#using-the-bot">Using the Bot</a>
      <ul>
        <li><a href="#incident-management">Incident Management</a></li>
        <li><a href="#slash-commands">Slash Commands</a></li>
        <li><a href="#alert-routing">Alert Routing</a></li>
        <li><a href="#usage-reports">Usage Reports</a></li>
        <li><a href="#digests">Digests</a></li>
      </ul>
    </li>
    <li><a href="#how-it-works">How It Works</a></li>
    <li><a href="#architecture">Architecture</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>

---

## About

RailwayBot is a Discord bot that brings **Sentry-style incident management** to your Railway deployments. Instead of getting spammed with individual deploy notifications, it:

- **Groups** repeated crashes into a single tracked incident
- **Classifies** severity automatically (critical, error, warning, info)
- **Creates a Discord thread** per incident for discussion
- Lets you **acknowledge, resolve, and mute** incidents with buttons or slash commands
- **Auto-resolves** incidents when a successful deploy lands
- **Routes** alerts to different channels based on project, service, or severity
- Sends **daily digests** and **daily usage reports** with cost breakdowns
- Sends a **daily heartbeat** to log/alert channels so you can confirm the bot is still running

---

## Getting Started

### Prerequisites

- **Node.js 24+** and npm
- A **Discord server** where you have Manage Server permissions
- A **Railway account** with projects you want to monitor

### Installation

1. Clone the repo:
   ```sh
   git clone https://github.com/LaCrak27/RailwayBot.git
   cd RailwayBot
   ```

2. Install dependencies:
   ```sh
   npm install
   ```

3. Build:
   ```sh
   npm run build
   ```

4. Start:
   ```sh
   npm start
   ```

### Environment Variables

Create a `.env` file in the project root:

```env
# ─── Required ───────────────────────────────────────────
DISCORDTOKEN=          # Discord bot token
CLIENTID=              # Discord application client ID (for slash commands)
LOGCHANNEL=            # Channel ID for deployment logs
USAGECHANNEL=          # Channel ID for usage reports and daily digests
RAILWAYAPIKEY=         # Railway account or workspace API token

# ─── Optional ───────────────────────────────────────────
WORKSPACE_ID=          # Railway workspace ID (scoped usage to one workspace)
INCIDENTCHANNEL=       # Channel ID for incident alerts (defaults to LOGCHANNEL)
DB_PATH=               # SQLite database path (defaults to ./data/railwaybot.db)
PORT=                  # HTTP server port (defaults to 3000)
```

| Variable          | Required | Description                                                                                                                                                                    |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DISCORDTOKEN`    | Yes      | Bot token from the [Discord Developer Portal](https://discord.com/developers/applications)                                                                                     |
| `CLIENTID`        | Yes*     | Application client ID — needed to register slash commands. Without this, slash commands won't work but the bot still functions.                                                |
| `LOGCHANNEL`      | Yes      | Discord channel ID for deploy success/failure logs                                                                                                                             |
| `USAGECHANNEL`    | Yes      | Discord channel ID for daily usage reports and daily digests                                                                                                                   |
| `RAILWAYAPIKEY`   | Yes      | Railway API token from [railway.com/account/tokens](https://railway.com/account/tokens). Use an account token for all workspaces, or a workspace token for a single workspace. |
| `WORKSPACE_ID`    | No       | Set this to query usage for a specific Railway workspace instead of your personal account                                                                                      |
| `INCIDENTCHANNEL` | No       | Separate channel for crash incident alerts. Falls back to `LOGCHANNEL` if not set.                                                                                             |
| `DB_PATH`         | No       | Path to the SQLite database file. Defaults to `./data/railwaybot.db`.                                                                                                          |
| `PORT`            | No       | Port for the webhook HTTP server. Defaults to `3000`.                                                                                                                          |

> **How to get channel IDs:** Enable Developer Mode in Discord (Settings → Advanced), then right-click a channel → Copy Channel ID.

> **How to get your Railway workspace ID:** Run `railway list --json` and look for the `workspace.id` field, or find it in the Railway dashboard URL.

---

## Deploying to Railway

1. Push this repo to GitHub.
2. Go to [railway.com/new](https://railway.com/new) and import the repository.
3. Add the environment variables listed above in the service's Variables tab.
4. Railway will auto-detect Node.js, run `npm run build`, and start with `npm start`.
5. The bot needs a persistent volume for the SQLite database. Either:
   - Set `DB_PATH` to a path on a mounted volume, or
   - Accept that data resets on redeploy (the bot will recreate the database automatically)

---

## Setting Up Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Navigate to the **Bot** tab and click **Add Bot**.
3. Enable these **Privileged Gateway Intents**:
   - None required (the bot only uses `Guilds` intent)
4. Copy the **Bot Token** → this is your `DISCORDTOKEN`.
5. Copy the **Application ID** → this is your `CLIENTID`.
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Create Public Threads`, `Send Messages in Threads`, `Use Application Commands`
7. Open the generated URL and invite the bot to your server.
8. Create the channels you want to use (e.g., `#incidents`, `#deploys`, `#usage`) and copy their channel IDs.

---

## Setting Up Railway Webhooks

For **each Railway project** you want the bot to monitor:

1. Open the project in the Railway dashboard.
2. Go to **Settings → Webhooks**.
3. Click **Add Webhook**.
4. Set the URL to: `https://your-bot-domain.railway.app/railway`
5. Select the events you want (at minimum: **Deploy**).
6. Save.

The bot will now receive deploy events and:
- **Successful deploys** → logged to `LOGCHANNEL`
- **Crashes / failures** → creates or updates an incident in `INCIDENTCHANNEL`

---

## Using the Bot

### Incident Management

When a service crashes, RailwayBot:

1. **Fingerprints** the event based on project + service + environment + status
2. Checks if there's an **existing active incident** with the same fingerprint
3. If new → creates an incident, posts an embed with action buttons, starts a Discord thread
4. If existing → increments the event count, updates the message, posts in the thread

**Incident states:**

| State          | Color  | Meaning                                        |
| -------------- | ------ | ---------------------------------------------- |
| 🔴 Triggered    | Red    | New, unacknowledged incident                   |
| 🟡 Acknowledged | Yellow | Someone has seen it                            |
| 🟢 Resolved     | Green  | Fixed (manually or auto via successful deploy) |
| 🟠 Regressed    | Orange | Previously resolved, now happening again       |

**Auto-resolution:**
- When a successful deploy is detected for the same service, the matching crash incident is automatically resolved.
- Incidents with no new events for 24 hours are auto-resolved during the hourly cleanup.

**Severity classification:**

| Severity | Color    | When                                                |
| -------- | -------- | --------------------------------------------------- |
| Critical | Dark red | Crash on a service with "prod" or "api" in the name |
| Error    | Red      | Any other crash or build failure                    |
| Warning  | Yellow   | Restarting or deploying                             |
| Info     | Blue     | Everything else                                     |

### Slash Commands

#### Incidents

```
/incident list [limit]
```
Lists active incidents with their status, severity, event count, and last seen time. Default limit is 10.

```
/incident ack <id>
```
Acknowledge an incident. The bot updates the incident message and records who acknowledged it.

```
/incident resolve <id>
```
Manually resolve an incident. The bot updates the embed to show 🟢 Resolved.

```
/incident info <id>
```
Show full details for an incident: project, service, environment, first/last seen, event count, commit info, who acked/resolved it.

> **Tip:** Incident IDs are shown in the footer of incident embeds and in `/incident list`. They're short hex strings (e.g., `a1b2c3d4e5f6...`).

#### Projects

```
/project mute <project_id> [duration_minutes]
```
Mute all alerts for a Railway project. Defaults to 60 minutes. Set a long duration to effectively mute indefinitely.

```
/project unmute <project_id>
```
Immediately unmute a project.

> **How to get project IDs:** Use `railway list --json` or press `Cmd/Ctrl + K` in the Railway dashboard and search "Copy Project ID".

#### Digests

```
/digest hourly
```
Shows a summary of the last hour: active incidents, deploy stats, top failing services.

```
/digest daily
```
Shows a summary of the last 24 hours. A daily digest is also automatically posted to `USAGECHANNEL` at 9 AM.

#### Alert Routing

```
/route add <channel_id> [project] [service] [severity]
```
Create an alert route. All parameters except `channel_id` are optional. Wildcard matches are used for unset fields.

Examples:
```
/route add 123456789                                → all alerts go to this channel
/route add 123456789 project:supergames              → alerts for "supergames" project
/route add 123456789 project:supergames service:api  → alerts for the api service in supergames
/route add 123456789 severity:critical               → all critical alerts go to this channel
```

```
/route list
```
Shows all configured alert routes with their IDs.

```
/route remove <id>
```
Delete an alert route by its ID.

**Routing priority:** The bot checks routes in this order and uses the first match:
1. Exact match (project + service + severity)
2. Project + severity
3. Project only
4. Severity only
5. Global (no filters)
6. Fallback to `INCIDENTCHANNEL`

### Usage Reports

Every 24 hours, the bot posts a usage report to `USAGECHANNEL` with:

- Per-project breakdown of CPU, memory, and egress usage
- Current cost and estimated end-of-month cost
- Calculated using Railway's per-unit pricing

### Heartbeat

Every 24 hours, the bot posts a heartbeat to `LOG_CHANNEL` and, if different, `INCIDENT_CHANNEL` to confirm the bot is online and webhook processing is active.

### Digests

**Hourly** (via `/digest hourly` or cron):
- Active incident count
- Deploy stats (total, succeeded, failed, success rate)
- Top 5 failing services

**Daily** (auto-posted at 9 AM + `/digest daily`):
- Same as hourly plus:
- Number of auto-resolved stale incidents
- Full 24h window

---

## How It Works

```
Railway Webhook → /railway endpoint
                   │
                   ├── Deploy Success → Log to #deploys channel
                   │                    Auto-resolve matching incident
                   │
                   └── Crash/Failure → Fingerprint the event
                                       │
                                       ├── New fingerprint → Create incident
                                       │                     Post embed + buttons
                                       │                     Start Discord thread
                                       │
                                       └── Known fingerprint → Update existing incident
                                                               Increment event count
                                                               Post update in thread
```

**Fingerprinting:** `SHA-256(projectId:serviceId:environment:status)[:16]`

This means:
- A service crashing repeatedly in the same environment creates **one** incident
- A service crashing in staging and production creates **two** separate incidents
- A build failure and a runtime crash on the same service create **two** separate incidents

---

## Architecture

```
src/
├── railwaybot.ts    # Main entry: Express server, Discord client, webhooks, usage reports
├── store.ts         # SQLite database layer (schema, prepared statements, queries)
├── incidents.ts     # Incident engine (fingerprinting, severity, state, dedup)
└── commands.ts      # Discord slash commands, buttons, embeds, thread management
```

**Database:** SQLite with WAL mode. Auto-creates on first run. No external database required.

**Tables:**
| Table            | Purpose                             |
| ---------------- | ----------------------------------- |
| `incidents`      | Active and historical incidents     |
| `deploy_history` | Record of all deploy events         |
| `alert_routes`   | Channel routing rules               |
| `muted_projects` | Temporary project mutes with expiry |
| `bot_state`      | Key-value store for internal state  |

---

## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

Distributed under the MIT License. See `LICENSE.txt` for more information.
