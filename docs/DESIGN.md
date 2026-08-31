# Haven — Design

**A widget-based, self-hosted personal dashboard.**

The design this codebase is built to. It records not just *what* was chosen but
*why*, and what was rejected — so a decision gets revisited on evidence rather
than rediscovered by accident.

> Written 2026-08-31, as the design for a replacement of an earlier static
> dashboard. Where it says "the current dashboard", that is what it means.

---

## 1. Why build this

The current dashboard (`haven-dashboard`, 23 apps, static HTML/JS on a home server) works, but is a
single hard-coded page. The wanted features — torrents, calendar, alerts, resizable
widgets — don't fit a static page, and off-the-shelf dashboards were evaluated and rejected:

| Project | Why not |
|---|---|
| **Homepage** | Multi-URL-per-app **explicitly declined** by maintainers (discussion #5532) — "handle this at the level of DNS, reverse proxy, etc." |
| **Homarr** | DB-backed config (not version-controllable); visually unappealing |
| **Dashy** | Visually unappealing |
| **Glance** | No demo exists; both hard features only *buildable*, not built |
| **Heimdall** | Was dormant ~10 months with an unauthenticated CVE unpatched |

Two requirements no off-the-shelf project meets, and they're the two that matter most here:

1. **Multiple URLs per app with a menu** — used on 20 of 23 apps today. This is what makes
   the dashboard work away from home.
2. **Dual version tracking** — running container version *vs* latest GitHub release, side by side.

The ecosystem's answer to #1 is split-horizon DNS. That's real infrastructure to run and
debug, and it doesn't solve #2 at all. So: build it.

---

## 2. The big architectural change

**The current site is static. Haven will have a backend.** This is unavoidable and should
be a deliberate decision up front, not a discovery at widget #2:

- qBittorrent needs a session login
- Google Calendar needs OAuth (or a secret ICS URL)
- Home Assistant needs a long-lived token
- Layout persistence needs somewhere to write
- Nearly all of the above will fail CORS from a browser origin

One small backend solves all five. It also fixes the existing problem that the
OpenWeatherMap API key is currently in plaintext in a repo about to go public.

```
Browser (widget shell)
   │  fetch /api/*        ← no credentials ever reach the browser
   ▼
Haven backend  (Node + SQLite, one container on the home server)
   │
   ├── /api/layout      read/write grid layout (geometry, per breakpoint)
   ├── /api/instances   widget roster — type + config per instance (CRUD)
   ├── /api/apps        app registry (CRUD)
   ├── /api/widgets/*   one connector per data source
   └── connectors: qBittorrent · Google/Outlook Cal · HA · OpenWeatherMap · GitHub releases
```

**Stack:** Node + Fastify, SQLite (via `better-sqlite3`), vanilla JS + Web Components on the
front end, GridStack.js for layout. No React — the widget contract below gives the structure
a framework would, without the dependency.

**Why SQLite:** single file, no separate service, trivially backed up, and it's the natural
home for layout + app registry + widget config. One volume mount on the home server.

---

## 3. Layout engine — GridStack.js

Researched and verified 2026-08-31. **GridStack.js** (MIT, 9.1k stars, last commit
2026-08-30, v13.2.0 released 2026-08-20, 23.3 kB gzipped, zero dependencies).

It's the only candidate that is simultaneously a real grid engine (collision + reflow),
genuinely vanilla-JS-native, and verifiably maintained.

Two independent research passes reached the same conclusion. The second checked
specifically whether anything newer displaces it: nothing does. GridStack landed **100+
commits in the last 90 days** — more than dnd-kit, react-grid-layout and Pragmatic DnD
combined.

**Strongest signal:** **Homarr — the dashboard whose widgets prompted this project — runs
on `@homarr/gridstack`, a GridStack fork.** The engine is already proven on this exact
use case.

**Rejected:**

| Library | Why not |
|---|---|
| Muuri | Dead since **Sept 2022** — GitHub's "updated" date is misleading (bot branches) |
| Isotope | Dead **and GPL-3.0** |
| Swapy | 8.5k stars but frozen since **Jan 2025**, **GPL-3.0**, and only swaps fixed slots — no resize, no reflow |
| @shopify/draggable | 18k stars, last real commit **Oct 2025** |
| Packery | 7-year release gap |
| interact.js / Sortable.js | Drag primitives, no collision engine — you'd write the hard part yourself |
| dnd-kit (`@dnd-kit/dom`) | Genuinely framework-agnostic now (v0.5.0, vanilla quickstart), but **pre-1.0 after ~2 years and has no compaction/reflow** — a code search for "compact" returns zero hits. A primitive, not a grid engine. |
| Pragmatic DnD | Excellent and active (Apache-2.0, ~4.7 kB, great a11y) — but drag primitives only |
| react-grid-layout | Better per-breakpoint support, but not worth adopting React for |

Note the pattern: **two of the most attractive-looking options (Isotope, Swapy) are
GPL-3.0**, and two more (Muuri, @shopify/draggable) look alive on GitHub but aren't. Star
counts are not a maintenance signal in this space.

**The one scenario that would change this:** if keyboard accessibility becomes a hard
requirement, `@dnd-kit/dom` + Pragmatic DnD have better a11y stories — at the cost of
writing collision, compaction and resize yourself. That's a lot of subtle code, and
GridStack's most recent commit is literally *"mobile: pause to drag/resize vs scroll
behavior"*, so touch handling is being actively worked on.

### Three things to know

**iframe drag capture — must be handled, ~10 lines.** Dragging over an iframe steals mouse
events; the iframe is a separate document. GridStack does *not* solve this (issues #1660,
#2915) and **neither does any other library** — it's inherent to iframes. Standard fix,
used by Grafana: on `dragstart`/`resizestart`, set `pointer-events: none` on every widget
iframe; restore it on `dragstop`/`resizestop`.

**Resize + WebGL is well served.** `resizestop` fires with the new geometry — hook it to
call `renderer.setSize()` + `camera.updateProjectionMatrix()` for the 3D-home widget.

**Per-breakpoint layouts need glue.** GridStack caches per-column layouts in memory but
does *not* include them in `save()` (per-breakpoint child layouts are a `// TODO` in
`types.ts`). Since `save(saveContent, saveGridOpt, saveCB, column)` takes a `column`
argument, we extract each breakpoint and persist both as `{ desktop: [...], mobile: [...] }`
— two rows in SQLite, loading the right one at the right breakpoint.

**Decision: explicit per-breakpoint layouts, not auto-reflow.** Auto-collapse produces a
mobile view nobody would choose; a hero carousel and a 3D iframe want different phone
treatment than a 6-item app grid. You arrange desktop and mobile separately, and each is
remembered.

---

## 4. The widget contract

Following prior art from Home Assistant Lovelace, Grafana, and Homarr, which converge on
the same shape.

**Host fetches, widget renders.** The strongest consensus in the prior art and the most
important decision here. Widgets are near-pure render functions; the shell owns fetching,
caching, auth, dedup and refresh. One place to fix a bug, and widgets stay testable.

Each widget is a Web Component declaring static metadata:

- `type`, `name` — registry identity
- `defaultSize`, `minSize`, `mobileSize` — grid cells; `minSize` maps to GridStack `minW`/`minH`
- `configSchema` — an array of typed field descriptors (`url`, `number`, `text`, `select`,
  `secret`) that **auto-generates the settings form**
- `refreshMs` — how often the host refetches
- `searchable` — whether it contributes to the global index

And implementing a lifecycle:

- `setConfig(config)` — validate eagerly, **throw** on bad config. May be called again at any time.
- `onData(data)` — host pushes fetched data
- `render()`
- `onResize(w, h)` — grid cells changed
- `destroy()`
- `getSearchEntries()` — returns `[{ id, title, subtitle, url, keywords }]`

**Rules:**
- **Errors are first-class.** Every widget render is wrapped in an error boundary. A dead
  qBittorrent renders a fallback tile; it never blanks the dashboard.
- **Never re-render on every data tick.** Diff and patch. Critical for the 3D scene — a
  data update must never blow away a canvas.
- **Config is declared, not hand-built.** No widget writes its own settings UI.
- **Every widget instance has a stable `id`**, and `#widget-id` in the URL scrolls to it
  (and briefly highlights it).

### Design details taken from prior art

Read at source level from Lovelace, Grafana, Homarr and Glance. Each of these is a mistake
one of them made and fixed, so they're worth copying rather than rediscovering.

**Nobody uses raw JSON Schema.** All four use a purpose-built flat list of typed option
descriptors. That's the strongest single signal in the study — so `configSchema` is a flat
array, not JSON Schema.

**Make conditional visibility declarative data, not a function.** Lovelace uses a
serialisable `visible: { field, operator, value }` condition tree; Grafana uses a
`showIf: (opts) => boolean` function. Take Lovelace's — it survives JSON round-tripping and
can be validated. Reserve a bespoke-editor escape hatch for the rare widget that needs one.

**One source of truth for form *and* validation.** Homarr derives its Zod validator from
the same option definitions that render the form. Two sources drift immediately.

**Split "should I update?" from "update".** Glance's widget interface has
`requiresUpdate(now) bool` separate from `update(ctx)` — the host asks before doing work.
Cheap to adopt, and it makes cache policy the host's business.

**Copy Grafana's `PanelData` shape for the data payload** — an explicit state enum
(`loading | done | error`), the value, errors, and a revision counter so a widget can tell
"data changed" from "shape changed" without a deep compare. It's the best-designed part of
any of these APIs.

**Version the config and ship a migration hook on day one.** Only Grafana does this
(`setMigrationHandler`). Everyone else breaks saved dashboards on a schema change. Trivial
to add now, impossible to retrofit.

**Preserve the bad config on the error card.** Lovelace keeps `origConfig` on its error
card so a misconfigured widget can still be opened and fixed rather than only deleted.

**Separate a soft notice from a hard error.** Glance distinguishes `Notice` (stale cache,
still usable) from `Error`. Showing stale data with a marker beats an error box.

**Don't flash an error at a widget that registers late.** Lovelace hides the error card for
2s and calls `customElements.whenDefined(tag)` then rebuilds — so a lazily-loaded widget
never flashes. Cheap polish.

**`getStubConfig` matters more than it looks** — it's what makes "Add widget" produce
something that works immediately instead of an error card.

**Shadow DOM per widget**, so a widget with broken markup cannot corrupt the host layout.
Glance re-renders immediately on a template failure precisely because a half-rendered
widget with unclosed tags breaks the whole page.

**The one thing not to do:** let each widget run its own `setInterval`. That's 20
uncoordinated timers, no backoff, and polling that continues in a hidden tab. The host owns
every timer, and pauses them when the tab is hidden.

---

## 5. Global search

Search spans **everything on the page**, not just apps.

Every widget optionally implements `getSearchEntries()`, returning documents to a shared
index. The shell owns the index; widgets push to it on data change. Entry shape:
`{ id, widgetId, title, subtitle, url, keywords[] }`.

- Apps contribute name + description + all URLs
- Calendar contributes each event
- Alerts contribute each notice
- Custom HTML pages contribute their title

Results group by source widget ("Apps", "Calendar", "Alerts") and jump to the widget.

> **⚠️ Privacy decision — flagged for you.** This index holds calendar event titles and
> alert contents. **It is in-memory only, never written to localStorage or the DB, and
> rebuilt each session.** Slightly slower on load; keeps personal data out of browser
> storage. Say if you'd rather trade that for persistence.

---

## 6. The widgets

### 6.1 Hero (apps + image carousel)
Rotating hero. App-driven — an app carries a `featured` block with tagline and cover.

> **Settled:** slides are **app-linked** (click → opens the app), with an optional
> free-form `image` slide type alongside. Clicking through to something is more useful
> than a decorative carousel.

**Built.** `featured` is a nullable JSON column on `apps` (migration 002) — it did not
previously exist anywhere in the schema, so the app-linked slides had nothing to read.
`GET /api/widgets/hero` returns slides carrying only what one renders, deliberately
excluding the full `urls` array. Covers upload to the data volume via
`POST /api/apps/:id/cover` (4MB, no SVG).

Rotation rides the shared `ClockTicker` rather than a widget-owned timer, with
per-widget elapsed-time accounting so two heroes can run at different rates off one
interval. `prefers-reduced-motion` disables auto-rotation and the transition; manual
navigation (keyboard, dots, swipe) still works. Pause on hover and on focus.

### 6.2 Apps
The core widget. Category tabs, sort, per-app cards.

Per app: **name · description · icon (uploadable) · primary URL · N secondary URLs each with
its own title · category · latest-version URL · current-version URL (POSTed to)**.

**Carried over from the current dashboard — do not lose these:**

- **Reachability resolution** (`reachability.js`). Probes URL variants *sequentially in
  priority order*, stops at the first that responds, and uses that as the click target.
  This is why the dashboard works from anywhere, and it's **better than probing only the
  primary URL** — port it near-verbatim. It also deliberately avoids mixed-content console
  noise at home by never probing http:// variants once the https alias answers.
- **Client-side status dots.** Probing happens *in the browser*, so a dot means "reachable
  from where you are". Nearly every off-the-shelf dashboard probes server-side and gets
  this wrong on a split LAN/Tailscale network. Keep it client-side deliberately.
- **URL hint on hover** — shows where a click will actually land.
- **Visit-count sorting** — counts kept per-app internally, not user-editable.
- **Dual version display** — current (POST endpoint) alongside latest (GitHub releases API).

**Dropped:** the Restart button (`restartUrl`) and the HA rooms list.

**Migration:** 23 apps from `apps.json` → SQLite. Field mapping:
`url`→primary; `localUrl`/`localIpUrl`/`remoteUrl`/`tailscaleUrl`→secondaries with titles
("Open Local", "Open Local via IP", "Open Remote", "Open via Tailscale"); `releasesUrl`→
latest-version URL; `containerId`→current-version lookup. Categories: personal, media,
home, ai, tools.

### 6.3 Torrents
qBittorrent connector. Name, progress, up/down speed, ETA, state. Already in the app registry, so the target is known (its address lives in the
deployment's config, not here). Backend holds the session cookie.

### 6.4 Calendar
Provider-agnostic: Google, Outlook, or any ICS.

> **Recommendation: start with the secret ICS URL** (Google Calendar → Settings → *Secret
> address in iCal format*). Read-only, no OAuth dance, just an HTTP GET and an ICS parse —
> a fraction of the work. Add OAuth later only if write access or faster sync is wanted.
> The ICS URL is a bearer credential, so it lives in the backend, never the repo.

> **Open question:** your calendar only, or merged with a second person's?

### 6.5 Iframe / embed
Arbitrary embedded pages. First use: the 3D home preview (`home3d.html?preview=true` — a
mode that already exists and is already used by the HA tablet dashboard).

Needs the pointer-events shim (§3) and `resizestop` → `renderer.setSize()`.

### 6.6 Notices / alerts
Upcoming alerts, chores, reminders.

> **Recommendation: define the envelope now, the source later.** Have the widget render
> anything matching a fixed shape, then any number of sources can feed it:
> `{ id, severity: "info|warn|urgent", title, body, due (ISO-8601), source, url, actions[] }`.
> HA, the future chores app, and anything else all feed one widget instead of you
> rebuilding it per source.

### 6.7 Weather
Port the existing widget (current + 4-day forecast, 30-min cache). **The API key moves to
the backend** — it's currently in plaintext in `config.json`.

### 6.8 Greeting / clock
Time, date, and a greeting that adapts to **time of day and weather**.

Current version is time-only with random phrasing per band. Extend using the same
time-band + tone-adaptation pattern as the Home Assistant morning digest
(`agents/first-message-digest.md`): morning / afternoon / evening / night bands, with
weather folded in ("Morning — it's grim out, working from home?").

### 6.9 Custom HTML pages
Author a page once, then either place it as a widget **or** give it its own subpage (or both).

First use: **Library Analytics**, which today is a full standalone page with its own header,
nav and refresh — so it becomes a subpage, optionally with a summary-tile widget on the home
grid.

---

## 7. Edit mode vs view mode

**Decision: an explicit toggle**, not always-on dragging.

- **View mode** (default): everything interactive, nothing moves. Click a torrent, scroll a
  calendar. No accidental drags.
- **Edit mode**: drag handles and resize grips appear, widget content dims slightly and stops
  being interactive (so clicking a widget selects rather than activates it), an "Add widget"
  panel opens, and each widget gets a settings gear + remove button.
- Layout saves on exit, with an explicit Save/Discard. Mobile and desktop layouts are edited
  separately, each in its own breakpoint.

---

## 8. Security & secrets

**This repo is going public. The backend holds real credentials.** Both facts are fine
together, but only if arranged deliberately from commit one.

| Rule | Detail |
|---|---|
| Secrets never reach the browser | The shell calls `/api/*`; the backend holds every credential |
| Gitignored from commit one | `*.db`, `.env`, `data/secrets.json`, `certs/` |
| Repo ships examples only | `config.example.json`, `.env.example` |
| Encrypted at rest | Widget credentials in SQLite encrypted with a key from `.env` |
| Backend not public | Bound to LAN/Tailscale, never port-forwarded |

> **⚠️ Pre-public audit required — a blocker, not a nicety.** The existing repo has
> `data/config.json` (containing a live OpenWeatherMap key) **committed and not gitignored**,
> so it is in git *history* — and history is readable once public. `apps.json` also maps the
> entire internal network (LAN IPs, ports, every service). Decide before flipping visibility:
> scrub history, or start the new repo with fresh history. **Recommendation: fresh history**
> — simpler and safer than rewriting, and Haven is a new codebase anyway.
>
> Also flagged: `assets/floor plan/` and `assets/home images/` are floor plans and photos of
> the actual flat. Those belong in a private repo or a non-public assets store regardless of
> what happens to the rest.

---

## 9. Build order

Each phase ends somewhere usable, so nothing is a big-bang cutover.

| Phase | Delivers | Notes |
|---|---|---|
| **0. Foundations** | Repo, backend skeleton, SQLite schema, `.gitignore`, examples | Secrets story settled first |
| **1. Shell + grid** | GridStack, edit/view toggle, layout persistence, per-breakpoint layouts, `#widget-id` deep links | The riskiest part — do it early |
| **2. Apps widget** | Full parity + 23-app migration, reachability, status dots, versions, config UI | Parity milestone: Haven replaces the old dashboard |
| **3. Supporting widgets** | Weather, greeting, iframe (3D home), custom pages (Library Analytics) | Mostly ports of working code |
| **4. Global search** | Index + UI across all widget types | Needs ≥2 widget types to be meaningful |
| **5. Torrents** | qBittorrent connector | First genuinely new capability |
| **6. Calendar** | ICS first; OAuth only if needed | |
| **7. Notices/alerts** | Envelope + widget; sources as they arrive | Format decided in §6.6 |
| **8. Cutover** | the reverse proxy points your dashboard domain at Haven; old dashboard archived | Old site stays reachable until Haven is proven |

**Deployment:** one container on the home server alongside the existing stack, one volume for the
SQLite file and uploaded icons, NPM proxy host in front. The 3D home stays a separate static
repo (per the earlier split plan) and is embedded via the iframe widget.

---

## 10. Open questions

Everything else above is decided. These four are deliberately left open:

1. **Search index privacy** (§5) — in-memory only, or persisted for speed? *Proposed:
   in-memory.*
2. **Calendar scope** (§6.4) — one calendar, or several merged?
3. **Hero slides** (§6.1) — app-linked, or generic images? *Proposed: app-linked, with an
   optional free-form slide type.*
4. **Public-repo history** (§8) — scrub the old history, or start fresh? *Proposed: fresh.*
   And separately: do floor plans and home photos go public at all? *Proposed: no.*
