/**
 * Turning a seed document plus the live server state into a PLAN — an ordered
 * list of actions with a create/update/skip verdict already decided.
 *
 * ── Why a plan is a separate thing from applying one ─────────────────────
 * `--dry-run` must print exactly what a real run would do. The only way to
 * guarantee that is for both to compute the same plan and differ solely in
 * whether they execute it. A dry run that re-derives its predictions by a
 * second code path is a dry run that lies, which is worse than not having one.
 *
 * ── Idempotency lives here ───────────────────────────────────────────────
 * Every action is decided by comparing the DESIRED entry against what the
 * server currently holds:
 *
 *   absent on the server        → create
 *   present and equal           → skip
 *   present and different       → update
 *
 * "Equal" is a comparison of the fields the seed file can actually set, after
 * both sides have been normalised through the same function. Comparing raw API
 * responses instead would mark everything as changed forever, because the
 * server fills in `visitCount`, timestamps and defaults the file never states.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────
 * `stripUntouchedSecrets` is the load-bearing one. The instances API returns
 * `SECRET_SET` where a credential is stored, never the credential. So:
 *
 *   - a seed value equal to `SECRET_SET` means "whatever is already there" and
 *     is REMOVED from the payload — `splitSecrets` server-side reads an absent
 *     key as untouched and preserves the stored credential. Sending the
 *     sentinel back as a literal would store the string `__haven_secret_set__`
 *     AS the credential.
 *   - a real value is sent through and re-encrypted.
 *   - an explicit `""` is a deliberate clear and IS sent, because that is the
 *     documented way to remove one.
 *
 * This is the same line `web/src/shell/settings-panel.js` holds from the
 * browser side (its rule 2): an untouched secret is omitted from the patch,
 * never sent as a blank.
 */

import { SECRET_SET, layoutReferences, stripServerOwned } from './seed-schema.mjs';

/**
 * The config keys of an instance that hold a secret, as far as anyone outside
 * the widget definition can tell.
 *
 * The server has no copy of a widget's `configSchema` — `instances-store.js`
 * says so explicitly and refuses to duplicate it — so neither does this CLI.
 * A key is treated as a secret when the seed file declares it in
 * `secretKeys`, or when the live value is the sentinel (which is proof the
 * server encrypted something under that key).
 */
export function secretKeysOf(desired, live) {
  const keys = new Set(desired?.secretKeys ?? []);
  for (const [key, value] of Object.entries(live?.config ?? {})) {
    if (value === SECRET_SET) keys.add(key);
  }
  return keys;
}

/**
 * Removes untouched secrets from a config about to be sent.
 *
 * @returns {{ config: object, omitted: string[] }} `omitted` is reported so a
 *   dry run can say "kept the stored value for X" rather than staying silent
 *   about the one field a reader is most likely to worry about.
 */
export function stripUntouchedSecrets(config, secretKeys) {
  const out = {};
  const omitted = [];

  for (const [key, value] of Object.entries(config ?? {})) {
    if (secretKeys.has(key) && value === SECRET_SET) {
      // The sentinel came from the server. Sending it back would store the
      // sentinel string itself as the credential.
      omitted.push(key);
      continue;
    }
    out[key] = value;
  }

  return { config: out, omitted };
}

/**
 * The comparable form of an app — only what the seed file can set, with the
 * server's defaults applied so a file that omits an optional field does not
 * read as a change forever.
 */
export function normaliseApp(app) {
  return {
    name: app.name ?? '',
    description: app.description ?? '',
    category: app.category ?? 'tools',
    icon: app.icon ?? null,
    urls: (app.urls ?? []).map((u) => ({
      title: u.title,
      url: u.url,
      primary: u.primary === true,
    })),
    version: app.version ?? null,
    featured: app.featured
      ? { tagline: app.featured.tagline, cover: app.featured.cover ?? null }
      : null,
    sortOrder: app.sortOrder ?? 0,
  };
}

/**
 * The comparable form of an instance.
 *
 * A config key holding the sentinel on EITHER side is normalised to the
 * sentinel on both, so "a secret is set" compares equal to "a secret is set"
 * — which is the only thing that can be known about it. Without this, a file
 * exported from a server with a stored secret would show that instance as
 * changed on every single apply, forever.
 *
 * `fallbackSortOrder` matters as much. A file that says nothing about
 * placement is not asking for position 0 — `create` assigns the next free
 * slot and `update` explicitly keeps the existing one, so an unstated
 * `sortOrder` means "wherever it already is". Defaulting it to 0 here instead
 * made every instance in a file that omits it compare unequal to a server that
 * had assigned 1, 2, 3 — three of the four instances in the example file
 * re-PUT themselves on every single run before this was fixed.
 */
export function normaliseInstance(instance, secretKeys = new Set(), fallbackSortOrder = 0) {
  const config = {};
  for (const [key, value] of Object.entries(instance.config ?? {})) {
    config[key] = secretKeys.has(key) ? SECRET_SET : value;
  }

  return {
    type: instance.type,
    config,
    configVersion: instance.configVersion ?? 1,
    sortOrder: instance.sortOrder ?? fallbackSortOrder,
  };
}

/** Layout nodes, normalised to the five fields the validator keeps. */
export function normaliseNodes(nodes) {
  return (nodes ?? []).map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    ...(n.widgetId !== undefined ? { widgetId: n.widgetId } : {}),
  }));
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Plans the app section.
 *
 * `desiredApps` are already through the migration mapping, so every entry here
 * is in the current Haven shape.
 */
export function planApps(desiredApps, liveApps) {
  const byId = new Map(liveApps.map((a) => [a.id, a]));

  return desiredApps.map((app) => {
    const { iconFile, ...payload } = app;
    const live = byId.get(app.id);
    const clean = stripServerOwned(payload);

    // A file that says `iconFile` but not `icon` is describing an upload, not
    // a removal. Without this the PUT would send `icon: null` and blank the
    // stored filename a moment before the upload endpoint set it again —
    // visible as a flash of missing icon, and as a permanent `update` verdict
    // on an app that never actually changes.
    if (iconFile && clean.icon === undefined && live?.icon) clean.icon = live.icon;

    // Both sides go through the SAME normaliser, which applies the defaults
    // the server would apply anyway. That is what makes a file omitting
    // `description` compare equal to a server holding `''`, rather than
    // reading as changed on every run forever.
    //
    // An icon upload is deliberately NOT part of this comparison: it is its
    // own action, so an app whose only pending work is an icon still compares
    // equal on what a PUT would send.
    const action = !live
      ? 'create'
      : sameJson(normaliseApp(clean), normaliseApp(live))
        ? 'skip'
        : 'update';

    return { kind: 'app', id: app.id, action, payload: clean, iconFile: iconFile ?? null };
  });
}

/**
 * Plans the instance section.
 *
 * Note the payload carries `secretKeys` through to the server: that array is
 * what tells `splitSecrets` which config keys to route to the credential
 * store rather than the config blob.
 */
export function planInstances(desiredInstances, liveInstances) {
  const byId = new Map(liveInstances.map((i) => [i.id, i]));

  return desiredInstances.map((instance) => {
    const live = byId.get(instance.id);
    const secretKeys = secretKeysOf(instance, live);
    const { config, omitted } = stripUntouchedSecrets(instance.config ?? {}, secretKeys);

    const payload = stripServerOwned({ ...instance, config });

    const action = !live
      ? 'create'
      : sameJson(
            normaliseInstance(instance, secretKeys, live.sortOrder),
            normaliseInstance(live, secretKeys, live.sortOrder)
          )
        ? 'skip'
        : 'update';

    return {
      kind: 'instance',
      id: instance.id,
      action,
      payload,
      keptSecrets: omitted,
    };
  });
}

/**
 * Plans the layout section, and checks every node against the instances that
 * will exist once the instance actions above have run.
 *
 * The check is against desired ∪ live rather than live alone, because the
 * normal case is a file that creates an instance AND places it in the same
 * run — the instance does not exist yet when the plan is computed, but it
 * will by the time the layout PUT goes out. Instances are applied before
 * layout for exactly this reason.
 */
export function planLayout(desiredLayout, liveLayout, knownInstanceIds) {
  const dangling = [];
  for (const ref of layoutReferences(desiredLayout)) {
    if (!knownInstanceIds.has(ref)) dangling.push(ref);
  }

  const actions = Object.keys(desiredLayout).map((breakpoint) => {
    const desired = normaliseNodes(desiredLayout[breakpoint]);
    const live = normaliseNodes(liveLayout?.[breakpoint]);
    return {
      kind: 'layout',
      id: breakpoint,
      action: sameJson(desired, live)
        ? 'skip'
        : desired.length && !live.length
          ? 'create'
          : 'update',
      payload: desired,
    };
  });

  return { actions, dangling };
}
