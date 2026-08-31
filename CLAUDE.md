# CLAUDE.md — Haven

A widget-based, self-hosted personal dashboard. Replaces the static
`haven-dashboard` site. **This repo is public and the backend holds real
credentials** — read [Security](#security--the-rule-that-matters-most) before
writing a single line.

**Read first:** [`docs/DESIGN.md`](docs/DESIGN.md) — the full design, and the
reasoning behind every decision below. Don't relitigate what it settled; if you
think something in it is wrong, say so rather than quietly doing otherwise.

---

## Security — the rule that matters most

This is the one thing that must not go wrong, so it comes first.

**No PII, no credentials, no network topology in the repo. Ever.** Not in code,
not in tests, not in fixtures, not in a commit message, not in a doc example.

| Belongs in the repo | Belongs in the deployment |
|---|---|
| `.env.example` with empty placeholders | `.env` with real values |
| `config/apps.example.json` with one `.invalid` entry | `config/apps.json` with real services |
| `config/settings.example.json` with defaults | `config/settings.json` |
| Schema and migrations | The SQLite file on `/data` |

Concretely, none of these may ever be committed:

- API keys, tokens, passwords, session cookies
- **Calendar ICS URLs** — a secret iCal address is a bearer credential
- **LAN IPs, internal hostnames, port numbers** — an app registry is a map of
  the internal network
- Floor plans, photos of the flat, anything under `assets/private/`
- Real names, addresses, calendar event titles, alert contents

`scripts/check-no-secrets.sh` enforces the structural half of this and runs in
CI alongside gitleaks. **Run it before you commit.** It fails on tracked
`config/*.json`, `.env`, databases, keys, private assets, and any RFC 1918
address in a tracked file. Example configs use `.invalid` hostnames precisely so
that check stays clean.

**The reason this is stated so bluntly:** the repo this replaces has a live
OpenWeatherMap key committed and an `apps.json` mapping every service on the
network. Haven starts with fresh history specifically so none of that carries
over. Don't reintroduce it.

**Secrets never reach the browser.** The shell calls `/api/*`; the backend holds
every credential and talks to the upstream service. If you find yourself putting
a token in front-end code, the design has gone wrong — move the call to a
connector.

---

## Architecture

```
web/     the widget shell — vanilla JS + Web Components, GridStack.js
server/  Fastify + better-sqlite3; owns every credential and connector
config/  example configs only (real ones are gitignored)
docs/    proposal, widget contract, security, configuration
scripts/ check-no-secrets.sh and friends
```

**Stack:** Node 24, Fastify, better-sqlite3, vanilla JS + Web Components,
GridStack.js v13. **No React** — this is deliberate, not an oversight. The
widget contract gives the structure a framework would, and adding one would pull
in a build step the front end doesn't otherwise need.

### The two rules the whole design rests on

**1. The host fetches; widgets render.** The shell owns fetching, caching, auth,
dedup, refresh and *every timer*. Widgets are near-pure render functions that
receive data via `onData()` and draw it. This is the strongest consensus across
Home Assistant Lovelace, Grafana, Homarr and Glance, and it's what keeps widgets
testable and bugs fixable in one place.

Corollary, and it is not negotiable: **a widget never runs its own
`setInterval`.** Twenty widgets with their own timers means twenty uncoordinated
polls, no backoff, and polling that keeps running in a hidden tab. The host owns
the schedule and pauses it when the tab is hidden.

**2. Config is declared, never hand-built.** A widget's `configSchema` — a flat
array of typed field descriptors — generates its settings form *and* its
validator, from one definition. No widget writes its own settings UI. Two
sources of truth drift immediately.

Note `configSchema` is a **flat array of typed option descriptors, not JSON
Schema**. All four prior-art projects converged on this independently; it's the
strongest single signal in the study.

Full contract: [`docs/WIDGET-CONTRACT.md`](docs/WIDGET-CONTRACT.md).

---

## Conventions

- **ES modules** everywhere (`"type": "module"`). No CommonJS.
- **Node's built-in test runner** (`node --test`). No Jest, no Vitest on the
  server.
- **Prettier** for formatting — `npm run format`. CI checks it.
- **Shadow DOM per widget**, so a widget with broken markup can't corrupt the
  host layout.
- **Errors are first-class.** Every widget render is wrapped in an error
  boundary; a dead connector renders a fallback tile and never blanks the
  dashboard. Preserve the bad config on the error card so it can be *fixed*
  rather than only deleted.
- **A soft notice is not a hard error.** Stale-but-usable cached data renders
  with a marker; it does not render an error box.
- **Never re-render on every data tick** — diff and patch. Critical for the 3D
  scene: a data update must never blow away a canvas.
- **Version the config** and run it through the migration hook. It's trivial now
  and impossible to retrofit.

---

## Working on this repo

```bash
npm install
npm test                 # all workspaces
npm run lint
npm run format
npm run build            # web shell
npm run dev              # server with --watch
bash scripts/check-no-secrets.sh   # BEFORE every commit
```

### Branching and CI

- `main` is protected — no direct pushes. Branch, PR, CI green, merge.
- CI runs on every branch push and PR: secret scan, format, server tests, web
  build, workflow lint, and a Docker dry-run when Docker files change.
- Path-filtered jobs are paired with a `*-gate` job that is the *required*
  check, so a skipped job doesn't block a PR but a failed one does.

### Releasing

Releases are manual — **Actions → Release → Run workflow**. With no input it
**bumps the minor version**; pick `patch` or `major`, or give an explicit
`vX.Y.Z`. Each release tags, builds a multi-arch image, pushes it to
`ghcr.io/zaida-3do/haven` (tagged `vX.Y.Z`, `vX.Y`, `vX`, `latest`), and creates
a GitHub Release with generated notes.

---

## Task tracking

Work is tracked in **Agent Standup**, project **"Haven - app build"**
(`cc42a84c-7526-4506-ab4f-346a3ac60bb6`), not in GitHub Issues. Milestones there
map to the phases in §9 of the proposal. Check the board before starting
something — it'll usually already be a task.

---

## Deployment

One container on the QNAP alongside the existing stack, one volume for the
SQLite file and uploaded icons, NPM proxy host in front. The 3D home stays a
separate static repo and is embedded via the iframe widget.

The old dashboard stays reachable until Haven is proven — cutover is phase 8,
not a big bang.
