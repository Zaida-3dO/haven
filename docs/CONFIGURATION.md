# Configuration

Three places, deliberately separated. See [SECURITY.md](SECURITY.md) for why.

| | File | Committed? |
|---|---|---|
| Secrets | `.env` | No — `.env.example` ships placeholders |
| Services | `config/apps.json` | No — `config/apps.example.json` ships one fake entry |
| Preferences | `config/settings.json` | No — `config/settings.example.json` ships defaults |
| Running versions | `config/container-versions.json` | No — written by a refresher, not by hand |
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
| `HAVEN_INSTANCES_CONFIG` | `./config/instances.json` | Widget roster seed, read only when the roster is empty. Absent falls back to a built-in default roster |
| `HAVEN_SECRET_KEY` | — | Encrypts widget credentials at rest. `openssl rand -base64 32` |
| `HAVEN_VERSION` | `dev` | Reported by `/api/health`; set at image build |
| `HAVEN_CONTAINER_VERSIONS_FILE` | `./config/container-versions.json` | Running container versions, re-read at request time. See below |

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

## `config/container-versions.json`

Where the **running** version of each container comes from. Optional: with no
file, the `HAVEN_CONTAINER_VERSIONS` environment map is used instead, and with
neither the card simply shows no current version.

Haven does not, and will not, mount the Docker socket to discover these —
giving a web-facing container root-equivalent access to the host is a bad trade
for displaying a string. Something *else* looks at the containers and writes
this file; Haven only reads it, off the existing read-only `./config` mount.

Two shapes are accepted:

```json
{
  "generatedAt": "2026-08-30T09:00:00.000Z",
  "versions": { "example-container": "1.4.2" }
}
```

```json
{ "example-container": "1.4.2" }
```

The first is preferred, because it carries its own age. The bare map is
accepted because the old dashboard's version-collection script already emits
exactly that shape, so it can be pointed at the mount without a translation
step; its age is then taken from the file's modification time.

### It is re-read while running, not at boot

The file is read **at request time**, behind a short (60s) cache. A file read
once at startup would freeze until the container restarted, which is the drift
that `HAVEN_CONTAINER_VERSIONS` already suffers from and the whole reason this
file exists. Write the file and the dashboard reflects it within a minute — no
restart, no redeploy.

### Age is shown, because a dead writer fails silently

Every response carries `currentAsOf`, and the widget renders it beside the
version. This is not decoration. If whatever writes the file stops running, the
file simply stops changing and Haven goes on showing a version that was true
last month as though it were true now — the same lie as a hand-edited map, only
automated and harder to spot. Past 24 hours the age renders as a **stale**
warning.

A version with no timestamp (i.e. one from the environment map) shows no age,
because the map's real age — whenever someone last edited it — is not knowable
from here, and claiming otherwise would be worse than saying nothing.

### Failure is always quiet

Missing, unreadable, malformed, or the wrong shape: all fall back to the
environment map and then to "unknown". None of them can fail a request or stop
the server booting. A malformed file is logged once, not once per request.

**Never commit this file** — `config/*.json` is gitignored because a real one
names the containers running on the host.

## `config/settings.json`

Non-secret preferences. Secrets belong in `.env`, never here.

```json
{
  "version": 1,
  "weather": {
    "units": "metric",
    "locationName": null,
    "latitude": null,
    "longitude": null
  },
  "grid": {
    "breakpoints": { "mobile": 768 },
    "columns": { "desktop": 12, "mobile": 4 }
  }
}
```

### Weather

`units` is `metric`, `imperial` or `standard`.

`latitude` and `longitude` ship as `null` and are only used as a pair: set one
without the other, or set either out of range, and the widget treats the
location as unconfigured rather than sending it upstream. They are **not**
defaulted to `0.0`, because 0,0 is a real place in the Atlantic — a copied
example should say "set your location", not show you the weather at null
island.

`locationName` is only a label; it overrides the name OpenWeatherMap returns so
the tile says what you call where you live.

The API key is **not** here — it is `HAVEN_OPENWEATHER_API_KEY` in the
environment, and it never reaches the browser. Without it the widget renders a
"not configured" tile naming the variable to set.

## Layout

Layout is **not** a config file — it's edited in the app (edit mode) and stored
in SQLite. Desktop and mobile are edited and stored separately; there is no
auto-reflow, because a phone layout nobody chose is worse than no phone layout.

Back it up by backing up `/data`.
