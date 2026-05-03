<div align="center">
  <a href="https://github.com/moonLight-7k/railway-bot">
    <img src="https://devicons.railway.app/i/railway-dark.svg" alt="Railway logo" width="80" height="80">
  </a>

# RailwayBot

A Discord bot for Railway deploy alerts, incident tracking, routing, and daily summaries.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/wide-wild?referralCode=NSNGgG&utm_medium=integration&utm_source=template&utm_campaign=generic)

[Repository](https://github.com/moonLight-7k/railway-bot) • [Issues](https://github.com/moonLight-7k/railway-bot/issues) • [Docs](./docs/README.md)
</div>

## What it does

- Tracks Railway deploy failures as incidents
- Opens Discord threads for incident discussion
- Lets responders acknowledge and resolve incidents from Discord
- Routes alerts by project, service, or severity
- Posts daily usage reports, digests, and a heartbeat

## Quick start

```sh
git clone https://github.com/moonLight-7k/railway-bot.git
cd railway-bot
npm install
npm run build
npm start
```

## Required environment variables

```env
DISCORD_TOKEN=
CLIENT_ID=
LOG_CHANNEL=
USAGE_CHANNEL=
RAILWAY_API_KEY=
```

Common optional variables:

```env
WORKSPACE_ID=
INCIDENT_CHANNEL=
WEBHOOK_SECRET=
DB_PATH=
PORT=3000
```

Full setup and all supported variables are documented in [`docs/setup.md`](./docs/setup.md).

## Docs

- [Documentation index](./docs/README.md)
- [Setup guide](./docs/setup.md)
- [Discord commands](./docs/discord-commands.md)
- [Architecture notes](./docs/architecture.md)

## License

MIT. See [`LICENSE.txt`](./LICENSE.txt).
