# NexusGuard

NexusGuard is a multi-server Discord bot and responsive web dashboard with separate regular-user and private owner experiences.

## Requirements
- Node.js 22
- A Discord application and bot token
- A PostgreSQL database
- Discord OAuth2 client credentials

## Environment variables

Configure these in Render (do not commit secrets):

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` (recommended: `https://nexusguard-rxkr.onrender.com/auth/callback`)
- `SESSION_SECRET` (use a long random value, at least 32 characters)
- `DATABASE_URL`
- `OWNER_DISCORD_ID` (your Discord user ID)
- `NODE_ENV=production`

Never commit credentials to this repository.

## Deployment

Deploy this repository as a Render Web Service. The `index.js` and `package.json` files must be at the repository root.

- Build command: `npm install`
- Start command: `npm start`

In the Discord Developer Portal, add the exact deployed callback URL to OAuth2 Redirects. Ensure the bot is invited to each server you want it to manage.

## Dashboard access

- Regular users can see only servers returned by Discord OAuth where they have Administrator, Manage Server, or server-owner permission and NexusGuard is installed.
- The configured `OWNER_DISCORD_ID` gets a private Owner HQ and can manage any server NexusGuard is connected to, even if the owner is not a member of that Discord server.
- Owner-only API endpoints enforce access on the server. Do not change `OWNER_DISCORD_ID` to a public or shared value.

## Important

The dashboard is a visual and access-control upgrade to the existing app. Review it in a staging deployment before replacing a production instance, and verify OAuth, PostgreSQL connectivity, and the bot's Discord permissions.
