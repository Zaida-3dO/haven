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
