# NexusGuard Complete Bundle

This is the consolidated NexusGuard project bundle. It combines the latest command-directory build with the multi-role moderator selector and expanded command handlers in one project ZIP.

## Files
- `index.js` — bot, dashboard/API, OAuth routes, settings, command directory, category separator commands, and command handlers.
- `package.json` — Node dependencies and `npm start` script.
- `.gitignore` — excludes local secrets and generated files.

## Command directory and separators
Use `/commands` or `/help` to view the categorized command directory. Category-only commands such as `/general`, `/server-tools`, `/moderation-tools`, `/roles`, `/tickets`, `/community`, `/automod`, `/levels`, `/economy`, `/fun`, `/configuration`, and `/owner` are intended as no-action labels in Discord's slash-command picker. Discord does not support decorative headings inside the command picker, so these are real commands that acknowledge the selection and do not perform category actions.

## Deploy
1. Back up your current repository.
2. Extract this ZIP and put `index.js` and `package.json` at the repository root.
3. Preserve your existing Render environment variables and database configuration. Do not paste secrets into source code.
4. Install dependencies with `npm install` and start with `npm start` (Render can use the same start command).
5. Commit and push the files, then wait for Render to redeploy.
6. Test `/commands` and each category label in a test server, then test normal moderation and dashboard sign-in.

## Important
- The multi-role selector stores a list of selected moderator role IDs and retains the first role in the legacy `moderatorRole` field for compatibility. Any command that relies on moderator-role authorization should be reviewed to ensure it checks every entry in `moderatorRoles`.
- Reminder timers that use process memory are not persistent across restarts.
- A successful syntax check does not prove every feature works against your live Discord application. Review Render logs and test in a private test server before production use.
- Keep your Discord bot token, OAuth client secret, session secret, and database credentials in Render environment variables.


## /setupserver fix

The global slash-command list is registered only by `index.js`; `setupServer.js` no longer overwrites the global command list. The setup handler acknowledges the interaction before fetching the guild or creating roles/channels, and uses `guildId` even when Discord.js has not populated `interaction.guild`. Ensure only one Render service (and no local process) is running the same `DISCORD_TOKEN`.
