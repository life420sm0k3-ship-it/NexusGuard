# NexusGuard expanded feature map

## Included in this expanded build
- Discord OAuth2 login with OAuth state validation, session cookies, rate limits, and server permission filtering.
- Global owner-only diagnostics, cross-server overview, command catalog, database table counts, announcements, and test DM report action.
- Hourly private owner reports, with UTC-hour claim records to reduce duplicate scheduled reports.
- 80 unique slash-command definitions across general, moderation, server management, roles, tickets, community, levels, economy, fun, security, utility, and configuration.
- Moderation: warn/list/clear/remove warnings, timeouts, kick, ban/unban, purge, purge by user, slowmode, lock/unlock, nickname, staff notes, case history, and audit history. Discord permission checks and role hierarchy still apply.
- Server tools: server/user/role/channel information, role add/remove/create, channel create/delete, member count, channel/role lists, invite URL, settings export/reset, and custom text commands.
- Community: polls, reaction polls, suggestions and statuses, announcements, giveaways with scheduled winner selection, scheduled messages, welcome and leave messages.
- Tickets: create/close/list/stats, add a member to a ticket, and rename ticket channels. Ticket transcripts/reopen flow are not included.
- Levels/economy: XP, levels, leaderboard, profile, balance, daily reward, work, beg, coin transfer, currency leaderboard, and fun non-wager mini commands.
- Automation: message XP and level-up notices, configured welcome/leave messages, auto-roles, anti-spam timeout, invite filtering, mass-mention filtering, and custom prefix responses.
- Background workers deliver due reminders and scheduled messages, and close expired giveaways with randomly selected reaction participants. The bot must be online at delivery time.
- Dashboard APIs and controls: server selector, settings, analytics, channels/roles, warnings, tickets, scheduled-message creation/cancellation, JSON server backup, audit log, and mobile layout.
- SQLite persistence for settings, audit events, moderation cases, warnings, tickets, XP/currency, reminders, scheduled messages, custom commands, giveaways, suggestions, hourly reports, and session storage.

## Still requires configuration or future implementation
- CAPTCHA/button verification, full raid lockdown/automatic mitigation, reaction role panels, a full starboard processor, ticket transcripts and reopen/claim workflow, automation-rule builder, AI moderation, translation, music/voice playback, external integrations, multi-factor owner approval, backup restore UI, and full analytics charts.
- The verification and anti-raid settings are not a substitute for a completed CAPTCHA/raid-response system.
- Discord OAuth credentials, bot token, owner user ID, channel/role IDs, Discord intents, and correct permissions must be configured by the operator.
- Scheduled jobs are in-process. For reliable delivery during deploys or multiple independent instances, use a dedicated worker/queue and a shared persistent database.

## Validation
- JavaScript syntax checked for `src/index.js`, `src/commands.js`, `src/database.js`, and `public/dashboard.js`.
- Command names checked for duplicates. Live Discord registration and delivery must be verified after deployment.
