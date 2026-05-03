# Discord Commands

This guide covers what RailwayBot posts and how responders use it from Discord.

## Channels used by the bot

- `LOG_CHANNEL`: deploy logs and general error logs
- `INCIDENT_CHANNEL`: incident alerts and updates
- `USAGE_CHANNEL`: daily usage reports and digests

The bot also posts a daily heartbeat so you can confirm it is still running.

## Incident message actions

Each incident message includes these buttons:

- `Acknowledge`
- `Resolve`
- `Info`
- `Mute 1h`
- `Mute 24h`

The bot also creates a Discord thread for each incident.

## Slash commands

### Help

```text
/help
```

Shows the command summary in Discord.

### Incident commands

```text
/incident list [limit]
```

- Lists active incidents
- Default `limit`: `10`
- Max `limit`: `25`

```text
/incident ack <id>
```

Marks an incident as acknowledged.

```text
/incident resolve <id>
```

Resolves an incident manually.

```text
/incident info <id>
```

Shows detailed incident information privately.

### Project commands

```text
/project mute <project_id> [duration]
```

- Mutes alerts for one Railway project
- `duration` is in minutes
- Default duration: `60`

```text
/project unmute <project_id>
```

Removes the mute immediately.

### Digest commands

```text
/digest hourly
```

Shows the last hour of activity.

```text
/digest daily
```

Shows the last 24 hours of activity.

### Route commands

```text
/route add <channel> [project] [service] [severity]
```

- Creates an alert route
- `channel` must be a Discord text channel ID
- `project`, `service`, and `severity` are optional filters
- `severity` can be `info`, `warning`, `error`, or `critical`

Example:

```text
/route add 123456789012345678 billing api critical
```

```text
/route list
```

Lists configured routes.

```text
/route remove <id>
```

Removes a route by ID.

## Permissions

These commands require `Manage Channels`:

- `/project mute`
- `/project unmute`
- `/route add`
- `/route list`
- `/route remove`

## Where to find IDs

### Incident ID

You can find it in:

- the footer of an incident embed
- `/incident list`

### Discord channel ID

1. Enable Developer Mode in Discord.
2. Right-click the channel.
3. Click `Copy Channel ID`.

### Railway project ID

You can get it from:

- `railway list --json`
- the Railway dashboard project actions

## Common workflows

### Triage a new incident

1. Open the incident message.
2. Click `Info`.
3. Click `Acknowledge`.
4. Use the thread for discussion.
5. Click `Resolve` when the issue is fixed.

### Silence a noisy project temporarily

1. Click `Mute 1h` or `Mute 24h` on the incident.
2. Or run `/project mute <project_id> [duration]`.

### Check system health

1. Run `/digest hourly` for recent status.
2. Run `/digest daily` for the full day.
3. Watch for the heartbeat in your log and incident channels.
