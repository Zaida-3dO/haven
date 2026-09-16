/**
 * `widgets.height` — a sidebar card's pixel height.
 *
 * Added by migration 007 for Ope's "reduce the height of the calendar widget"
 * (2026-09-13). It sits on the ROSTER beside `sort_order` and `zone` because
 * it is a property of one card, not of the layout — see migration 007 and
 * DESIGN §3.1.
 *
 * ── The distinction these tests exist to pin ─────────────────────────────
 * `undefined` and `null` are DIFFERENT here, and conflating them breaks the
 * feature in one of two opposite ways:
 *
 *  - `undefined` means "say nothing, keep what is stored". The settings panel
 *    sends a full replace of the mutable fields and says nothing about height,
 *    so without this a config save would wipe a resize.
 *  - `null` means "clear the height, go back to content sizing". It is how a
 *    user undoes a resize, and a `??` fallback would make it inexpressible.
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import {
  MAX_CARD_HEIGHT,
  MIN_CARD_HEIGHT,
  createInstanceStore,
  validateInstance,
} from '../src/db/instances-store.js';

/** A store on a private in-memory DB, with credentials stubbed out. */
function freshStore(t) {
  const db = new Database(':memory:');
  migrate(db);
  t.after(() => db.close());

  return createInstanceStore(db, {
    credentials: { set: () => {}, get: () => null, delete: () => false },
  });
}

const instance = (over = {}) => ({ id: 'card', type: 'calendar', config: {}, ...over });

/* ── the validator ───────────────────────────────────────────────────────── */

test('a height below the floor is refused', () => {
  // A card shorter than its own heading is a label with a scrollbar: the
  // title row alone is ~34px, so below the floor there is no body to scroll.
  assert.throws(
    () => validateInstance(instance({ height: 10 })),
    new RegExp(
      `height must be null or an integer between ${MIN_CARD_HEIGHT} and ${MAX_CARD_HEIGHT}`
    )
  );
});

test('a height above the ceiling is refused', () => {
  // The client-side drag clamp (`sidebar-size.js`'s MAX_CARD_HEIGHT) never
  // reaches the API — a direct PUT/POST bypasses it entirely, so the
  // validator needs its own ceiling rather than trusting the UI's.
  assert.throws(
    () => validateInstance(instance({ height: MAX_CARD_HEIGHT + 1 })),
    new RegExp(
      `height must be null or an integer between ${MIN_CARD_HEIGHT} and ${MAX_CARD_HEIGHT}`
    )
  );
});

test('a non-integer height is refused', () => {
  assert.throws(() => validateInstance(instance({ height: '200px' })), /height must be null/);
  assert.throws(() => validateInstance(instance({ height: 200.5 })), /height must be null/);
});

test('null is an ALLOWED height — it is how a resize is undone', () => {
  const clean = validateInstance(instance({ height: null }));
  assert.equal(clean.height, null, 'null must survive validation, not be stripped');
});

test('an omitted height is absent from the clean payload, not null', () => {
  // The two must stay distinguishable all the way to the UPDATE, or "say
  // nothing" and "clear it" collapse into one.
  const clean = validateInstance(instance());
  assert.equal('height' in clean, false);
});

/* ── the store ───────────────────────────────────────────────────────────── */

test('a card with no height stored reads back null, meaning content-sized', (t) => {
  const store = freshStore(t);

  store.create(validateInstance(instance({ zone: 'sidebar' })));

  assert.equal(store.get('card').height, null);
});

test('a height round-trips', (t) => {
  const store = freshStore(t);

  store.create(validateInstance(instance({ zone: 'sidebar', height: 240 })));

  assert.equal(store.get('card').height, 240);
});

test('an update that says NOTHING about height keeps the stored one', (t) => {
  // THE regression this guards. The settings panel sends a full replace of the
  // mutable fields and never mentions height, so a `?? null` here would make
  // saving a widget's config silently undo a resize.
  const store = freshStore(t);
  store.create(validateInstance(instance({ zone: 'sidebar', height: 240 })));

  store.update('card', validateInstance(instance({ config: { title: 'Changed' } })));

  assert.equal(store.get('card').height, 240, 'a config save must not wipe a height');
});

test('an explicit null CLEARS a stored height', (t) => {
  // The other half. If `undefined` and `null` were treated alike, this would
  // keep 240 and a user could never undo a resize from the UI.
  const store = freshStore(t);
  store.create(validateInstance(instance({ zone: 'sidebar', height: 240 })));

  store.update('card', validateInstance(instance({ height: null })));

  assert.equal(store.get('card').height, null);
});

test('a height does not disturb zone or sort order', (t) => {
  // `update` falls back to the previous zone and sortOrder when a payload
  // omits them; adding a third such field is a chance to break the other two.
  const store = freshStore(t);
  store.create(validateInstance(instance({ zone: 'sidebar', sortOrder: 3 })));

  store.update('card', validateInstance(instance({ height: 200 })));

  const updated = store.get('card');
  assert.equal(updated.zone, 'sidebar');
  assert.equal(updated.sortOrder, 3);
  assert.equal(updated.height, 200);
});
