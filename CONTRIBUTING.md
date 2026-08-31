# Contributing to Haven

## Before anything else

**This repo is public and the backend holds real credentials.** Read
[docs/SECURITY.md](docs/SECURITY.md) first, and run the check before every
commit:

```bash
bash scripts/check-no-secrets.sh
```

No API keys, tokens, ICS URLs, LAN addresses, internal hostnames, floor plans or
photos. Example configs use `.invalid` hostnames so the check stays clean — keep
it that way.

## Setup

```bash
npm install
cp .env.example .env
cp config/apps.example.json config/apps.json
cp config/settings.example.json config/settings.json
npm run dev
```

## Workflow

1. Branch off `main` — `feat/…`, `fix/…`, `docs/…`, `chore/…`.
2. Make the change. Add tests.
3. `npm test`, `npm run lint`, `npm run format`.
4. `bash scripts/check-no-secrets.sh`.
5. Open a PR. CI must be green; `main` is protected and doesn't take direct
   pushes.

## Commit messages

Conventional commits — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
`test:`, `ci:`. Release notes are generated from them.

## Tests

Node's built-in runner:

```bash
npm run test --workspace=server
```

Server routes are tested through `app.inject()` rather than by binding a port —
see `server/test/health.test.js`.

## Writing a widget

Read [docs/WIDGET-CONTRACT.md](docs/WIDGET-CONTRACT.md) in full first. The two
things people get wrong:

- **Don't fetch in a widget.** The host fetches and pushes data via `onData()`.
- **Don't run a timer.** The host owns every timer and pauses them when the tab
  is hidden.

## Releases

Maintainers only: **Actions → Release → Run workflow**. Defaults to a minor
bump; publishes to GHCR and cuts a GitHub Release.
