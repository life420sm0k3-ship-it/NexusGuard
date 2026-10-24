
# NexusGuard

NexusGuard is a multi-server Discord bot and web dashboard.

## Requirements
- Node.js 22
- A Discord application and bot token
- A PostgreSQL database
- Discord OAuth2 client credentials

## Environment variables

Set these in your hosting provider:

- DISCORD_TOKEN
- DISCORD_CLIENT_ID
- DISCORD_CLIENT_SECRET
- DISCORD_REDIRECT_URI
- SESSION_SECRET
- DATABASE_URL
- OWNER_DISCORD_ID
- NODE_ENV=production

Never commit credentials to this repository.

## Commands

- /ping
- /serverinfo
- /userinfo
- /warn
- /timeout
- /settings

## Deployment

Deploy the repository as a Render Web Service.
Use `npm install` as the build command and `npm start` as the start command.

Register slash commands with `npm run register` after setting the environment variables.

Configure the Discord OAuth2 redirect URI to match the deployed website.
