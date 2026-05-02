# Discord Commands Guide

This file explains how to use RailwayBot directly from Discord.

## What The Bot Posts

RailwayBot sends messages to these channels:

- `LOG_CHANNEL`: deploy logs and runtime error logs
- `INCIDENT_CHANNEL`: crash/failure incidents
- `USAGE_CHANNEL`: daily usage reports and daily digest

It also sends a daily heartbeat so you can confirm the bot is still online.

## Incident Messages

When Railway detects a failure, RailwayBot creates or updates an incident message.

Each incident message includes buttons:

- `Acknowledge`: marks the incident as seen
- `Resolve`: marks the incident as resolved
- `Info`: shows full incident details privately to you
- `Mute 1h`: silences alerts for that project for 1 hour
- `Mute 24h`: silences alerts for that project for 24 hours

The bot also opens a thread for each incident so your team can discuss it there.

## Slash Commands

```text
/help
```

- Shows a quick in-Discord help summary
- Good starting point for responders who do not know the command list yet

### Incident Commands

Use these to inspect and manage incidents.

```text
/incident list [limit]
```

- Shows active incidents
- `limit` is optional
- Default is `10`
- Max is `25`

Example:

```text
/incident list 5
```

```text
/incident ack <id>
```

- Acknowledges an incident
- Updates the incident message in Discord

Example:

```text
/incident ack 7c1c4f2a9f2d
```

```text
/incident resolve <id>
```

- Resolves an incident manually
- Updates the incident message to resolved

Example:

```text
/incident resolve 7c1c4f2a9f2d
```

```text
/incident info <id>
```

- Shows full incident details privately
- Includes project, service, environment, timestamps, commit info, ack user, and resolved user

Example:

```text
/incident info 7c1c4f2a9f2d
```

## Project Commands

Use these to mute or unmute noisy projects.

```text
/project mute <project_id> [duration]
```

- Mutes alerts for one Railway project
- `duration` is in minutes
- Default is `60`

Example:

```text
/project mute 2b4f9d5a-aaaa-bbbb-cccc-1234567890ab 180
```

```text
/project unmute <project_id>
```

- Removes the mute immediately

Example:

```text
/project unmute 2b4f9d5a-aaaa-bbbb-cccc-1234567890ab
```

## Digest Commands

Use these to get summaries in Discord.

```text
/digest hourly
```

- Shows the last 1 hour of activity

```text
/digest daily
```

- Shows the last 24 hours of activity

Digest includes:

- active incident count
- deploy success/failure counts
- success rate
- top failing services
- recent incidents

## Alert Routing Commands

Use these to route alerts to different channels.

```text
/route add <channel> [project] [service] [severity]
```

- Adds an alert route
- `channel` must be a Discord channel ID
- `project`, `service`, and `severity` are optional filters
- `severity` can be `info`, `warning`, `error`, or `critical`

Example:

```text
/route add 123456789012345678 billing api critical
```

```text
/route list
```

- Lists all configured routes

```text
/route remove <id>
```

- Removes a route by numeric route ID

## Permissions

These commands require elevated Discord permissions:

- `/project mute`
- `/project unmute`
- `/route add`
- `/route list`
- `/route remove`

The bot checks for `Manage Channels` permission before allowing those commands.

## Where To Find IDs

### Incident ID

Find it in:

- the footer of the incident embed
- `/incident list`

### Discord Channel ID

1. Enable Developer Mode in Discord
2. Right-click the channel
3. Click `Copy Channel ID`

### Railway Project ID

You can get it from:

- `railway list --json`
- the Railway dashboard project actions

## Common Workflows

### Triage A New Incident

1. Open the incident message in Discord
2. Click `Info` to inspect details
3. Click `Acknowledge` so the team knows someone owns it
4. Use the thread for discussion
5. Click `Resolve` when the issue is fixed

### Temporarily Silence A Noisy Project

1. Open the incident message
2. Click `Mute 1h` or `Mute 24h`
3. Or run `/project mute <project_id> [duration]`

### Check Overall Health

1. Run `/digest hourly` for short-term status
2. Run `/digest daily` for a 24-hour summary
3. Watch for the daily heartbeat in your log/incident channels

## Notes

- Incident button replies are private to the user who clicked them
- Usage reports and heartbeat are tracked, so they should not fire again on every redeploy
- Successful deploys are logged to `LOG_CHANNEL`
- Failed deploys create or update incidents in `INCIDENT_CHANNEL`
