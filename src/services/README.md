# Services

Reusable domain services belong here as they are separated from the current application bootstrap. Background reminder, scheduled-message, giveaway-closeout, and hourly owner-report workers are currently wired into `src/app.js` and share the SQLite database in `src/database/index.js`. Move a worker here only together with its imports, lifecycle start/stop, and tests so it is not started twice.
