# Architecture Notes

## High-level flow

```text
Railway webhook -> /railway endpoint
                 -> incident processing
                 -> Discord message or update
                 -> optional thread activity
```

Successful deploys are logged and can auto-resolve related incidents.
Failures are fingerprinted and grouped into incidents.

## Main files

```text
src/
|- railwaybot.ts   Main process, Express app, Discord client, cron jobs
|- commands.ts     Slash commands, buttons, embeds, thread actions
|- incidents.ts    Incident state, fingerprinting, severity, cleanup
|- store.ts        SQLite access and prepared statements
|- types.ts        Shared types and webhook validation helpers
```

## Runtime pieces

### HTTP server

- `POST /railway` receives Railway webhook events
- `GET /health` reports readiness

### Discord integration

- Registers slash commands on startup
- Handles button interactions and command replies
- Posts incident messages and digest embeds

### Storage

- SQLite database
- Default path: `./data/railwaybot.db`
- WAL mode is used in the database layer

### Scheduled jobs

- Usage report job
- Daily heartbeat job
- Daily digest job
- Stale incident cleanup
- Expired project mute cleanup

## Data tracked by the bot

The bot stores:

- incidents
- deploy history
- alert routes
- muted projects
- internal bot state

## Behavior summary

### Incidents

- Failures are fingerprinted so repeat failures are grouped
- Existing incidents are updated instead of recreated
- A successful deploy can auto-resolve a matching incident

### Routing

Alerts can be routed by:

- project
- service
- severity

### Reporting

- Usage reporting pulls data from Railway GraphQL
- Digests summarize incident and deploy activity
