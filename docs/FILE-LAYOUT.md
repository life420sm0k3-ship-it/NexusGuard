# NexusGuard file layout

```text
NexusGuard/
├── index.js                    # Render/local entry point
├── package.json                # Dependencies and scripts
├── render.yaml                 # Render blueprint (if configured)
├── .env.example                # Environment variable template
├── README.md
├── data/                       # Runtime SQLite/session data; do not commit DB files
├── docs/
│   ├── FILE-LAYOUT.md
│   └── FEATURE-MAP.md
├── src/
│   ├── app.js                  # Express app, Discord client, routes, workers, listeners
│   ├── index.js                # Backwards-compatible entry point
│   ├── commands/
│   │   ├── index.js            # Active slash-command registry
│   │   └── README.md
│   ├── database/
│   │   └── index.js            # SQLite schema and data access
│   ├── dashboard/
│   │   ├── README.md
│   │   └── public/
│   │       ├── index.html
│   │       ├── dashboard.html
│   │       ├── dashboard.js
│   │       └── style.css
│   ├── events/README.md        # Event extraction boundary
│   ├── services/README.md      # Worker/service extraction boundary
│   └── utils/README.md         # Shared utility extraction boundary
└── tests/                      # Automated tests to add/expand
```

## Current implementation boundary

The file layout is organized, but the bot/web bootstrap and event listeners remain in `src/app.js`, and slash commands remain in `src/commands/index.js`. The README files in `events`, `services`, and `utils` describe safe extraction boundaries; they are not falsely presented as completed executable modules. This arrangement keeps the current code operational while making the next refactor clearer.
