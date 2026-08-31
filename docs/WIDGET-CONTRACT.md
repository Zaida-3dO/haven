# The widget contract

Derived from reading Home Assistant Lovelace, Grafana, Homarr and Glance at
source level. Where those four converge, Haven follows; where one of them fixed
a mistake the others still have, Haven copies the fix. Each rule below is one of
those.

## The central split: the host fetches, the widget renders

The strongest consensus in the prior art, and the most important decision here.

**The shell owns** fetching, caching, auth, dedup, refresh scheduling, and every
timer. **The widget owns** turning data into DOM. Widgets are near-pure render
functions.

Why: one place to fix a fetching bug, one place to implement backoff, one place
to pause polling in a hidden tab — and widgets that can be tested by calling
`onData()` with a fixture.

> **A widget must never call `setInterval`.** Twenty widgets with their own
> timers is twenty uncoordinated polls with no backoff that keep running when
> the tab is hidden. This is the single easiest way to get this design wrong.

## Static metadata

Every widget is a Web Component declaring:

| Field | Meaning |
|---|---|
| `type` | Registry identity — stable, used in saved layouts |
| `name` | Human label in the "Add widget" panel |
| `defaultSize` | Grid cells on insert |
| `minSize` | Grid cells minimum — maps to GridStack `minW`/`minH` |
| `mobileSize` | Grid cells in the mobile breakpoint |
| `configSchema` | Flat array of typed option descriptors |
| `configVersion` | Schema version, for the migration hook. Defaults to `1` |
| `refreshMs` | How often the **host** refetches. `null` means never on a timer |
| `searchable` | Whether it contributes to the global index |
| `dataSource` | `(config) => ({ key, url, options })` — how a config becomes a request |

### `dataSource`

The host fetches; this is how it knows *what* to fetch. It returns a request
descriptor, not data:

```js
dataSource: (config) => ({ key: WEATHER_FETCH_KEY, url: WEATHER_ENDPOINT }),
```

`key` is the dedup key — two widgets returning the same `key` produce **one**
request. `options` is optional and passed through to `fetch`.

**A widget with no natural endpoint declares no `dataSource`** and sets
`refreshMs: null`. The clock is the worked example: there is no time endpoint,
and inventing one would be server territory. Its tick is a host-owned scheduler
task instead, so the widget still owns no timer and still inherits
pause-on-hidden.

## Lifecycle

```js
setConfig(config)   // validate eagerly, THROW on bad config. May be recalled.
onData(data)        // host pushes fetched data
render()
onResize(w, h)      // grid cells changed
destroy()
getSearchEntries()  // → [{ id, title, subtitle, url, keywords }]
```

`setConfig` throwing is the contract, not a suggestion: it's what lets the shell
render an error card instead of a half-broken widget.

## `configSchema` — declared, not hand-built

A **flat array of typed option descriptors**. Types: `url`, `number`, `text`,
`select`, `secret`.

**Not JSON Schema.** All four prior-art projects independently built a
purpose-made flat option list instead of using JSON Schema. That's the strongest
single signal in the study.

The same array generates **both** the settings form and the validator — Homarr
derives its Zod validator from its option definitions for exactly this reason.
Two sources of truth drift immediately.

**No widget writes its own settings UI.**

Each descriptor is keyed by **`key`**, unique within the schema:

```js
{ key: 'refreshMs', type: 'number', label: 'Refresh interval (ms)' }
```

### Conditional visibility is data, not a function

```js
{ key: 'apiKey', visible: { field: 'mode', operator: 'eq', value: 'api' } }
```

Note the asymmetry, which is deliberate: the descriptor names itself with
`key`, while the `visible` clause refers to *another* descriptor by `field`.
A descriptor with no `visible` clause is always visible.

**A hidden field keeps its value.** It is neither validated nor required while
hidden, but its typed value is retained, so flipping the condition back does
not silently lose what the user typed.

Lovelace uses a serialisable condition tree; Grafana uses a `showIf: (opts) =>
boolean` function. Take Lovelace's — it survives JSON round-tripping and can be
validated. A bespoke-editor escape hatch is reserved for the rare widget that
genuinely needs one.

### `getStubConfig` matters more than it looks

It's what makes "Add widget" produce something that *works immediately* rather
than an error card. Cheap, and the difference between a good and a bad first
impression of every widget.

## The data payload

Modelled on Grafana's `PanelData` — the best-designed part of any of these APIs:

```js
{
  state: 'loading' | 'done' | 'error',
  value: <the data>,
  errors: [],
  notices: [],    // soft notices — stale but usable
  revision: 42,   // increments on change
}
```

The revision counter lets a widget tell "data changed" from "shape changed"
without a deep compare.

**`revision` only bumps when the fetched value actually differs**, and the host
skips a redraw when it hasn't. That rule protects the 3D canvas — but it also
means **a widget cannot be driven by data alone if its display changes with
time**. Weather at 10:00:01 equals weather at 10:00:00, so a data-driven clock
would render once and freeze. Time-driven widgets use a host-owned ticker
instead; see `dataSource` above.

**A soft notice is not an error.** `notices` stays in state `done`: the widget
draws its data and the host marks it stale. Only an unusable failure is
`error`.

## Errors are first-class

- Every widget render is wrapped in an **error boundary**. A dead qBittorrent
  renders a fallback tile; it never blanks the dashboard.
- **Preserve the bad config on the error card** (Lovelace keeps `origConfig`) so
  a misconfigured widget can be *opened and fixed*, not only deleted.
- **A soft notice is not a hard error.** Glance distinguishes `Notice` (stale
  cache, still usable) from `Error`. Stale data with a marker beats an error box.
- **Don't flash an error at a widget that registers late.** Hide the error card
  for 2s and call `customElements.whenDefined(tag)`, then rebuild — so a lazily
  loaded widget never flashes.

## Rendering rules

- **Shadow DOM per widget**, so broken markup can't corrupt the host layout.
- **Never re-render on every data tick — diff and patch.** Critical for the 3D
  scene: a data update must never blow away a canvas.
- **Stable `id` per instance**, and `#widget-id` in the URL scrolls to it and
  briefly highlights it.

## Update scheduling

Glance splits `requiresUpdate(now) → bool` from `update(ctx)`: the host *asks*
before doing work. Cheap to adopt, and it makes cache policy the host's business
rather than each widget's.

## Config versioning

Every widget config carries a version, and every widget ships a migration hook —
from day one.

Only Grafana does this (`setMigrationHandler`). Everyone else breaks saved
dashboards on a schema change. **Trivial to add now, impossible to retrofit.**

## Search

`getSearchEntries()` returns documents for the shared index:

```js
{ id, widgetId, title, subtitle, url, keywords: [] }
```

The shell owns the index; widgets push on data change. Results group by source
widget and jump to it.

> The index holds calendar event titles and alert contents, so it is
> **in-memory only** — never written to `localStorage` or the database, and
> rebuilt each session.

## Grid notes

- **iframe drag capture must be handled** (~10 lines). Dragging over an iframe
  steals mouse events — inherent to iframes; no library solves it. On
  `dragstart`/`resizestart` set `pointer-events: none` on every widget iframe,
  and restore on `dragstop`/`resizestop`. This is what Grafana does.
- **Resize + WebGL:** hook `resizestop` to `renderer.setSize()` and
  `camera.updateProjectionMatrix()`.
- **Per-breakpoint layouts need glue.** GridStack caches per-column layouts in
  memory but doesn't include them in `save()`. Since `save(…, column)` takes a
  column argument, extract each breakpoint and persist both as
  `{ desktop: [...], mobile: [...] }`.
