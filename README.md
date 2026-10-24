# NexusGuard — fresh multi-server Discord bot + dashboard

An expanded Node.js/Discord.js multi-server platform with a responsive dashboard, Discord OAuth2 sign-in, granular server access checks, SQLite persistence, 80 slash commands, background delivery workers, scheduled announcements, giveaway closeout, server backup export, and a global owner console.

## Included modules

- **Discord bot:** slash-command registration, moderation (warn, warnings, clear warnings, timeout, untimeout, kick, ban, unban, purge, slowmode, lock/unlock), role/channel management, server info, polls, suggestions, announcements, tickets, ticket stats/close, giveaways, reminders, custom text commands, level/XP, leaderboard, profile, balance/daily, settings export, and audit queries.
- **Automation:** message XP, level-up messages, welcome/leave messages, configured auto-roles, anti-spam timeout, invite filtering, mass-mention filtering, and custom prefix responses. Background workers deliver due reminders and scheduled messages and automatically close expired giveaways with randomly selected entrants.
- **Owner reports:** private Discord DM status reports, sent on startup and then at most once per UTC hour. Includes uptime, server/member counts, warning/ticket totals, audit activity, and recent runtime errors. Requires a valid `OWNER_DISCORD_ID`; the bot must be able to DM the owner. Set `HOURLY_OWNER_REPORTS=false` to disable. The owner-only `POST /api/owner/report-test` endpoint sends a test report while signed in to the dashboard.
- **Website:** mobile-responsive landing page, OAuth2 sign-in, server picker, settings forms, audit table, analytics endpoints, channel/role lookup, warnings and tickets endpoints, scheduled-message queue UI, server JSON backup download, global owner command catalog, owner report test, database diagnostics, global announcements, runtime errors, and health endpoint.
- **Persistence:** SQLite tables for settings, warnings, cases, tickets, XP/currency, reminders, scheduled messages, custom commands, giveaways, suggestions, audit records, and sessions.

The application bootstrap is `src/app.js`, the active slash-command registry is `src/commands/index.js`, the SQLite layer is `src/database/index.js`, and dashboard assets are under `src/dashboard/public/`. See `docs/FILE-LAYOUT.md` for the complete directory tree.

The project intentionally documents features that are still future work, including CAPTCHA verification, full raid lockdown, starboard processing, ticket transcripts/reopen, automation-rule builder, AI moderation, music/voice, integrations, and backup restore. See `docs/FEATURE-MAP.md` for the precise boundary between included and future functionality.

## Local setup

1. Install Node.js 20.11+ (Node 22 recommended).
2. Copy `.env.example` to `.env` and fill in values from the Discord Developer Portal.
3. In the Discord Developer Portal, enable **Server Members Intent** and **Message Content Intent** for the bot. Use the bot token only in the environment, never in browser code.
4. In OAuth2, add the exact redirect URI from `DISCORD_REDIRECT_URI`, e.g. `https://your-service.onrender.com/auth/callback`.
5. Install and run:
   ```bash
   npm install
   npm start
   ```
6. Open `http://localhost:10000` or your deployed `DASHBOARD_URL`.

## Render setup

- Create a **Web Service** from the repository.
- Runtime: Node.
- Build command: `npm install`
- Start command: `npm start`
- Add all required environment variables from `.env.example` in Render's Environment tab.
- Set `DASHBOARD_URL` to the public service URL and `DISCORD_REDIRECT_URI` to `${DASHBOARD_URL}/auth/callback` (enter the literal full URL in Render).
- Add that same callback URL under Discord Developer Portal → OAuth2 → Redirects.
- Set `OWNER_DISCORD_ID` to your numeric Discord user ID. This is also the destination for hourly private status reports. Keep DMs open to the bot so reports can be delivered.
- Set `HOURLY_OWNER_REPORTS=true` to enable hourly reports (default behavior unless explicitly set to `false`).
- Set a random `SESSION_SECRET` of at least 32 characters.
- Keep the SQLite database on a persistent disk if your Render plan/service supports it; mount it to a directory and set `DATABASE_PATH` there. Without persistent storage, local SQLite data may be lost on redeploy/restart.

## Permissions and security notes

- Invite with `bot` and `applications.commands` scopes. Grant only the permissions you actually need; the invite link in the dashboard is a placeholder until you configure `DISCORD_CLIENT_ID` in the page or replace `SET_CLIENT_ID` in `dashboard.js`. Avoid granting Administrator to the bot unless you consciously accept the risk.
- The dashboard filters to servers where the logged-in user has Manage Server/Administrator or is owner, and where the bot is present. The configured `OWNER_DISCORD_ID` bypasses that bot-present filter for diagnostics; the global owner endpoints still require exact ID match.
- OAuth state is validated, session cookies are HTTP-only and SameSite=Lax, OAuth/API routes are rate-limited, and dashboard updates use an allowlist.
- Never share `.env`, bot tokens, client secrets, session secrets, or database files publicly.
- Discord role hierarchy still applies. A slash command can only affect members/roles the bot is allowed to manage.

## Notes

The bot and web app run in one process for straightforward Render deployment. For larger scale, split worker and web processes, add migrations/backups, and use an external durable database. The `/health` endpoint returns runtime status. `/api/guild/:guildId/export` downloads a JSON backup for an authorized server manager. Scheduled jobs are in-process and the service must remain online for delivery. Check Render logs if bot login or command registration fails.
