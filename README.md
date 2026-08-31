# Haven

**A widget-based, self-hosted personal dashboard.**

Haven is a dashboard for the services you run yourself. It exists because the
off-the-shelf options don't do two things that turn out to matter a lot:

- **Multiple URLs per app, with a menu.** The same service reached over LAN, over
  a reverse proxy, by raw IP, or over Tailscale — one tile, all of them, and it
  picks the one that actually answers from wherever you are. The ecosystem's
  answer to this is split-horizon DNS. This is less infrastructure.
- **Dual version tracking.** The version you're *running* next to the latest
  release upstream, side by side, so you can see what's behind at a glance.

Everything is a widget on a grid you arrange yourself — separately for desktop
and mobile, because a phone layout nobody chose is worse than no phone layout.

> **Status: all widgets built; not yet deployed.** Every widget below is
> implemented and tested, and `v0.1.0` is published to GHCR. What has *not*
> happened is a real deployment — nothing has run against live services or
> been checked in a browser. See [docs/DESIGN.md](docs/DESIGN.md) for the full
> design and [the roadmap](#roadmap) for what remains.

---

## Quick start

### Docker (recommended)

```bash
# 1. Configuration
cp .env.example .env
cp config/apps.example.json config/apps.json
cp config/settings.example.json config/settings.json
#    Edit .env and config/*.json — see "Configuration" below.

# 2. Run
docker compose up -d
```

Haven is then on <http://localhost:8080>.

To run a published image directly:

```bash
docker run -d \
  --name haven \
  -p 8080:8080 \
  -v haven-data:/data \
  -v "$PWD/config:/app/config:ro" \
  --env-file .env \
  ghcr.io/zaida-3do/haven:latest
```

### From source

```bash
npm install
cp .env.example .env          # then fill it in
npm run build                 # build the web shell
npm start                     # serve on :8080
```

For development, `npm run dev` runs the server with `--watch`, and
`npm run dev --workspace=web` runs Vite with `/api` proxied to it.

---

## Configuration

Haven separates three things, and the separation is deliberate:

| What | Where | In the repo? |
|---|---|---|
| **Secrets** — API keys, tokens, passwords, ICS URLs | `.env` | Never. `.env.example` ships placeholders. |
| **Your services** — names, URLs, categories, icons | `config/apps.json` | Never. `config/apps.example.json` ships one fake entry. |
| **Preferences** — units, location, grid columns | `config/settings.json` | Never. `config/settings.example.json` ships defaults. |
| **Layout & widget state** | SQLite, on the `/data` volume | Never. |

**No credential ever reaches the browser.** The web shell only ever calls
`/api/*`; the backend holds every token and talks to qBittorrent, Home
Assistant, OpenWeatherMap and your calendar on its behalf. That is also what
makes the connectors work at all — most of them fail CORS from a browser
origin.

Widget credentials stored in SQLite are encrypted at rest with
`HAVEN_SECRET_KEY`. Generate one with `openssl rand -base64 32`.

> **Don't port-forward the backend.** Bind it to your LAN or Tailscale. It holds
> real credentials for real services.

See [docs/SECURITY.md](docs/SECURITY.md) for the full boundary, and
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) for every option.

---

## How it works

```
Browser (widget shell)
   │  fetch /api/*        ← no credentials ever reach the browser
   ▼
Haven backend  (Node + SQLite, one container)
   │
   ├── /api/layout      read/write grid layout
   ├── /api/apps        app registry (CRUD)
   ├── /api/widgets/*   one connector per data source
   └── connectors: qBittorrent · Calendar (ICS) · Home Assistant ·
                   OpenWeatherMap · GitHub releases
```

**Stack:** Node + [Fastify](https://fastify.dev), SQLite via
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3), vanilla JS and Web
Components on the front end, [GridStack.js](https://gridstackjs.com) for the
grid. No front-end framework — the widget contract provides the structure one
would.

**The shell fetches; widgets render.** Widgets are near-pure render functions.
The shell owns fetching, caching, auth, dedup, refresh and every timer — so a
bug gets fixed in one place, polling stops when the tab is hidden, and widgets
stay testable. See [docs/WIDGET-CONTRACT.md](docs/WIDGET-CONTRACT.md).

---

## Widgets

| Widget | What it shows |
|---|---|
| **Apps** | Your services. Multiple URLs each, reachability-resolved click targets, live status dots, dual version display. |
| **Hero** | Rotating featured apps or images. |
| **Weather** | Current conditions and a 4-day forecast. |
| **Greeting** | Time, date, and a greeting that adapts to time of day and weather. |
| **Torrents** | qBittorrent — name, progress, speeds, ETA, state. |
| **Calendar** | Any ICS feed; Google and Outlook via their secret iCal URLs. |
| **Notices** | Alerts, chores and reminders from any source matching one envelope. |
| **Iframe** | Any embedded page. |
| **Custom pages** | Author a page once; place it as a widget, give it its own subpage, or both. |

**Status dots are probed from your browser, not the server** — so a green dot
means "reachable *from where you are*", which is the only reading that's useful
on a split LAN/VPN network. Most dashboards probe server-side and get this
wrong.

---

## Roadmap

Built in phases, each ending somewhere usable:

| Phase | Delivers | |
|---|---|---|
| 0 | Foundations — repo, backend skeleton, SQLite schema, CI, release pipeline | ✅ |
| 1 | Shell + grid — GridStack, edit/view toggle, per-breakpoint layout persistence | ✅ |
| 2 | Apps widget — full parity, reachability, status dots, versions | ✅ |
| 3 | Supporting widgets — weather, greeting | ✅ |
| 4 | Global search across every widget | ✅ |
| 5 | Torrents | ✅ |
| 6 | Calendar | ✅ |
| 7 | Notices / alerts | ✅ |
| 8 | Hero | ✅ |
| 9 | Cutover — deploy, verify from every network path | ⏳ |

**Still to do beyond the cutover:** a settings panel (every widget declares a
`configSchema` and the host validates it, but nothing renders one yet, so
options are currently only reachable in the database), browser-level
verification (all rendering is unit-tested against a fake DOM — nothing has
been seen in a real browser), and the iframe/custom-page widgets from phase 3.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: branch off `main`, open a PR,
CI must pass. `main` is protected.

**Before you commit anything:** run `scripts/check-no-secrets.sh`. This repo is
public and the backend holds real credentials — the check exists because that
combination is only safe if it's arranged deliberately.

## License

[MIT](LICENSE)
