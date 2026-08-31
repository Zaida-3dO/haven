# Security

Haven is a **public repository** whose backend holds **real credentials** for
real services. Both facts are fine together — but only if the boundary is
arranged deliberately, from the first commit.

## The boundary

```
Browser  ──fetch /api/*──►  Haven backend  ──►  qBittorrent, HA, OpenWeatherMap,
                            (holds every           your calendar, GitHub
                             credential)
```

**No credential ever reaches the browser.** The shell only ever calls `/api/*`.
The backend authenticates to upstream services on its behalf. If a token would
have to be in front-end code for something to work, move that call into a
connector instead.

This also happens to be what makes the connectors work at all: most of them fail
CORS from a browser origin.

## What must never be committed

| Category | Examples |
|---|---|
| Credentials | API keys, tokens, passwords, session cookies |
| Bearer URLs | **Calendar ICS "secret address" URLs** — holding one is holding read access |
| Network topology | LAN IPs, internal hostnames, port numbers, the app registry |
| Private assets | Floor plans, photos of the home, anything under `assets/private/` |
| Personal data | Real names, addresses, calendar event titles, alert contents |
| State | `*.db`, `data/`, `certs/`, `uploads/` |

The app registry deserves its own line: **`apps.json` is a map of your internal
network.** Every service, every port, every internal hostname. It is arguably
more sensitive than any single API key, and it's the one people forget.

## What the repo does ship

Examples only, with placeholder values:

- `.env.example` — every variable, all empty
- `config/apps.example.json` — one fake app on `.invalid` hostnames
- `config/settings.example.json` — non-secret defaults

`.invalid` is a reserved TLD that can never resolve ([RFC 2606]). Using it in
examples means the secret check can flag *any* real address without false
positives.

[RFC 2606]: https://www.rfc-editor.org/rfc/rfc2606

## Enforcement

Two layers, both in CI on every branch and PR:

1. **gitleaks** — scans full history for credential-shaped strings.
2. **`scripts/check-no-secrets.sh`** — a structural check. Fails on tracked
   `config/*.json` (except examples), `.env*` (except the example), `*.db`,
   `*.pem`, `*.key`, `certs/`, `assets/private/`, `uploads/`, and any RFC 1918
   address in a tracked file.

Run it locally before every commit:

```bash
bash scripts/check-no-secrets.sh
```

## Encryption at rest

Widget credentials stored in SQLite are encrypted with `HAVEN_SECRET_KEY`:

```bash
openssl rand -base64 32
```

Losing the key means re-entering every connector credential. It is not
recoverable from the database.

## Deployment

**Do not port-forward the backend.** Bind it to your LAN or Tailscale. It holds
working credentials for everything it connects to; exposing it to the internet
exposes all of them at once.

The container runs as a non-root user, and the only writable path is the `/data`
volume.

## Why this document is so firm

The static dashboard Haven replaces has a live OpenWeatherMap API key committed
in `data/config.json` — not gitignored, and therefore in git *history*, which is
readable the moment a repo goes public. Its `apps.json` maps the entire internal
network. Both were committed because nothing said they shouldn't be.

Haven starts with **fresh history** so none of that carries over, and this
document plus the CI check exist so it doesn't happen again.

## Reporting a vulnerability

Open a GitHub security advisory rather than a public issue.
