# Commands

`index.js` is the active slash-command registry. It exports the command objects consumed by `src/app.js` for command registration and interaction dispatch. Each command carries a category label used by the owner dashboard.

## Categories currently represented in the registry

- general
- moderation
- security
- tickets
- roles
- community
- economy
- fun
- levels
- configuration
- utility
- server management
- owner

The command registry is kept in one executable module for this build so command registration and shared helper behavior remain consistent. Do not create a second registration list without updating `src/app.js`.
