# Configuration

Three places, deliberately separated. See [SECURITY.md](SECURITY.md) for why.

| | File | Committed? |
|---|---|---|
| Secrets | `.env` | No — `.env.example` ships placeholders |
| Services | `config/apps.json` | No — `config/apps.example.json` ships one fake entry |
| Preferences | `config/settings.json` | No — `config/settings.example.json` ships defaults |
| Layout & widget state | SQLite on `/data` | No |

```bash
cp .env.example .env
cp config/apps.example.json config/apps.json
cp config/settings.example.json config/settings.json
```

## Environment variables

### Server

| Variable | Default | Meaning |
|---|---|---|
| `HAVEN_HOST` | `0.0.0.0` | Bind address |
| `HAVEN_PORT` | `8080` | Bind port |
| `HAVEN_LOG_LEVEL` | `info` | `trace`…`fatal` |
| `HAVEN_DB_PATH` | `./data/haven.db` | SQLite file. `/data/haven.db` in Docker |
| `HAVEN_ICON_DIR` | `./data/icons` | Uploaded app icons. On the data volume, never the repo |
| `HAVEN_APPS_CONFIG` | `./config/apps.json` | App registry seed, read only when the registry is empty |
| `HAVEN_SECRET_KEY` | — | Encrypts widget credentials at rest. `openssl rand -base64 32` |
| `HAVEN_VERSION` | `dev` | Reported by `/api/health`; set at image build |

`HAVEN_SECRET_KEY` is not recoverable. Lose it and every connector credential
must be re-entered.

### Connectors

All optional. A connector without credentials renders a "not configured" tile
rather than failing.

| Variable | For |
|---|---|
| `HAVEN_OPENWEATHER_API_KEY` | Weather widget |
| `HAVEN_QBITTORRENT_URL` / `_USER` / `_PASS` | Torrents widget |
| `HAVEN_HA_URL` / `HAVEN_HA_TOKEN` | Home Assistant, for notices |
| `HAVEN_CALENDAR_ICS_URL` | Calendar. **A bearer credential** — anyone holding it can read the calendar |
| `HAVEN_GITHUB_TOKEN` | Releases API. Raises the rate limit; public repos work unauthenticated at a lower one |

## `config/apps.json`

The app registry. **Never commit a real one** — it maps your internal network.

```json
{
  "version": 1,
  "apps": [
    {
      "id": "example-service",
      "name": "Example Service",
      "description": "What this service is for.",
      "category": "tools",
      "icon": "example.svg",
      "urls": [
        { "title": "Open", "url": "https://example.invalid", "primary": true },
        { "title": "Open Local", "url": "https://example.local.invalid" },
        { "title": "Open via Tailscale", "url": "https://example.ts.invalid" }
      ],
      "version": {
        "latestUrl": "https://api.github.com/repos/example/example/releases/latest",
        "currentContainerId": "example-container"
      }
    }
  ]
}
```

### URLs and reachability

`urls` is **ordered by priority**. The browser probes them in order and stops at
the first that responds — that becomes the click target. This is why the
dashboard works from home, from a phone on mobile data, and over Tailscale,
without split-horizon DNS.

Probing happens **in the browser**, deliberately: a status dot then means
"reachable *from where you are*". Server-side probing gets this wrong on a split
LAN/VPN network.

Mark exactly one URL `"primary": true` — the fallback when nothing answers.
The API rejects an app with zero or more than one.

### Seeding: the file is the seed, the database is the source of truth

`config/apps.json` is read **once, on boot, and only when the registry is
empty**. After that the SQLite table is authoritative and the file is ignored.

This asymmetry is deliberate. If the file were re-read on every boot, an app
renamed or reordered in the UI would be silently reverted on the next restart.
To re-seed from the file, empty the `apps` table.

A missing `config/apps.json` is not an error — a fresh install has no registry
at all, and an empty one is a valid state.

Migrating from the old dashboard's `apps.json`:

```bash
node scripts/migrate-apps.mjs --in /path/to/old/apps.json --dry-run
node scripts/migrate-apps.mjs --in /path/to/old/apps.json --out config/apps.json
```

It reports what it mapped, skipped and did not recognise. **Never commit its
output** — `config/*.json` is gitignored precisely because the real registry
maps the internal network.

### Versions

- `latestUrl` — a GitHub releases API endpoint for the upstream version.
- `currentContainerId` — identifies the running container, for the version
  you're actually on.

The two render side by side, which is the point.

## `config/settings.json`

Non-secret preferences. Secrets belong in `.env`, never here.

```json
{
  "version": 1,
  "weather": {
    "units": "metric",
    "locationName": "Your City",
    "latitude": 0.0,
    "longitude": 0.0
  },
  "grid": {
    "breakpoints": { "mobile": 768 },
    "columns": { "desktop": 12, "mobile": 4 }
  }
}
```

## Layout

Layout is **not** a config file — it's edited in the app (edit mode) and stored
in SQLite. Desktop and mobile are edited and stored separately; there is no
auto-reflow, because a phone layout nobody chose is worse than no phone layout.

Back it up by backing up `/data`.
