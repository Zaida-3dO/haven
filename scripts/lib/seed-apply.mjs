/**
 * `apply` and `export` — the two halves of the round trip.
 *
 * Both live here rather than in the CLI entry point so they can be tested
 * against an in-process server with no argv, no stdout and no process exit.
 *
 * ── Order is not arbitrary ───────────────────────────────────────────────
 * apps → icons → instances → layout.
 *
 * Layout nodes name instance ids, so instances must exist first — otherwise a
 * file that creates a widget and places it in one run would fail on a
 * reference to something it is about to create. Icons go after apps because
 * `POST /api/apps/:id/icon` 404s on an app that does not exist yet.
 *
 * ── Partial failure is reported, never hidden ────────────────────────────
 * An item that fails is recorded as `failed` with its error and the run
 * CONTINUES to the next item within the same section. What it does not do is
 * push on to the NEXT SECTION after a failure, because the sections have a
 * dependency order: applying layout after instances failed would produce a
 * second, confusing error about a dangling reference that is really just the
 * first failure wearing a different hat. So a failed section stops the run,
 * and everything already applied is listed by name — the caller can fix the
 * one item and re-run, which is safe precisely because apply is idempotent.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { migrateRegistry } from '../migrate-apps.mjs';
import { planApps, planInstances, planLayout } from './seed-plan.mjs';
import {
  SECRET_SET,
  SEED_VERSION,
  SeedValidationError,
  layoutReferences,
  stripAnnotations,
  stripServerOwned,
  validateSeed,
} from './seed-schema.mjs';

/**
 * Reads a seed file and returns the desired state, with the app section
 * already mapped out of the old dashboard's shape where needed.
 *
 * `migrateRegistry` is doing the mapping — NOT a copy of it. It passes an
 * already-migrated entry (one with a `urls` array) straight through, which is
 * what lets one file mix both shapes and what makes export → apply a no-op.
 *
 * `iconFile` is carried around the migration and reattached: it is a
 * seed-file-only field that `migrateRegistry` would report as unknown.
 */
export function resolveSeed(doc) {
  const { apps, instances, layout } = validateSeed(doc);

  const iconFiles = new Map();
  const forMigration = apps.map((app) => {
    // `$comment` is stripped BEFORE the migration rather than after, so a file
    // that documents itself does not get its own prose reported back as an
    // unmapped unknown field.
    const { iconFile, ...rest } = stripAnnotations(app);
    if (iconFile) iconFiles.set(app.id, iconFile);
    return rest;
  });

  const { output, report } = migrateRegistry({ version: 1, apps: forMigration });

  const resolvedApps = output.apps.map((app) => ({
    ...app,
    ...(iconFiles.has(app.id) ? { iconFile: iconFiles.get(app.id) } : {}),
  }));

  return {
    apps: resolvedApps,
    instances: instances.map(stripAnnotations),
    layout,
    migration: report,
  };
}

/**
 * Computes the whole plan against live server state.
 *
 * Exported so `--dry-run` and a real run share one derivation — a dry run that
 * predicts by a different route than the one that executes is a dry run that
 * can be wrong.
 */
export async function buildPlan(client, desired) {
  const [liveApps, liveInstances, liveLayout] = await Promise.all([
    client.listApps(),
    client.listInstances(),
    client.getLayout(),
  ]);

  const appActions = planApps(desired.apps, liveApps);
  const instanceActions = planInstances(desired.instances, liveInstances);

  // What will exist by the time the layout PUT goes out: everything the file
  // declares, plus everything already on the server.
  const knownInstanceIds = new Set([
    ...desired.instances.map((i) => i.id),
    ...liveInstances.map((i) => i.id),
  ]);

  const { actions: layoutActions, dangling } = planLayout(
    desired.layout,
    liveLayout,
    knownInstanceIds
  );

  return { appActions, instanceActions, layoutActions, dangling };
}

/** One result row in the report. */
const record = (kind, id, action, detail) => ({ kind, id, action, ...(detail ? { detail } : {}) });

/**
 * Applies a seed document.
 *
 * @param {object} options
 * @param {object} options.client        from `createClient`
 * @param {object} options.doc           the parsed seed file
 * @param {string} [options.baseDir]     directory `iconFile` paths resolve against
 * @param {boolean} [options.dryRun]
 * @param {(path: string) => Promise<Buffer>} [options.readFileImpl]
 * @returns {Promise<{ ok: boolean, results: object[], dryRun: boolean, migration: object }>}
 */
export async function applySeed({
  client,
  doc,
  baseDir = '.',
  dryRun = false,
  readFileImpl = readFile,
}) {
  const desired = resolveSeed(doc);
  const plan = await buildPlan(client, desired);
  const results = [];

  // A dangling layout reference is fatal BEFORE anything is written. The
  // alternative — write the apps and instances, then fail on layout — leaves
  // the dashboard half-arranged for a mistake that was visible up front.
  if (plan.dangling.length) {
    throw new SeedValidationError(
      `layout references instance id(s) that neither the seed file nor the server defines: ${plan.dangling.join(', ')}. ` +
        `Add them to \`instances\`, or remove the node(s).`
    );
  }

  let failed = false;

  /** Runs one section; returns false if anything in it failed. */
  const runSection = async (actions, execute) => {
    let sectionOk = true;
    for (const action of actions) {
      if (action.action === 'skip') {
        results.push(record(action.kind, action.id, 'skipped'));
        continue;
      }
      if (dryRun) {
        results.push(record(action.kind, action.id, `would ${action.action}`, describe(action)));
        continue;
      }
      try {
        await execute(action);
        results.push(record(action.kind, action.id, `${action.action}d`, describe(action)));
      } catch (err) {
        results.push(record(action.kind, action.id, 'failed', err.message));
        sectionOk = false;
        failed = true;
      }
    }
    return sectionOk;
  };

  const appsOk = await runSection(plan.appActions, async (action) =>
    action.action === 'create'
      ? client.createApp({ id: action.id, ...action.payload })
      : client.updateApp(action.id, action.payload)
  );

  if (!appsOk) return finish();

  // ── Icons ──────────────────────────────────────────────────────────────
  // A missing icon file is a SKIP, not a failure: the brief's "skip
  // gracefully when the file is absent". A seed file is routinely shared
  // without the image assets beside it, and refusing to seed a dashboard over
  // a missing decoration would be the wrong trade. A file that exists but
  // cannot be uploaded (wrong type, too large) IS a failure — that is a
  // stated intention that did not happen.
  for (const action of plan.appActions) {
    if (!action.iconFile) continue;
    const path = resolve(baseDir, action.iconFile);

    let bytes;
    try {
      bytes = await readFileImpl(path);
    } catch (err) {
      if (err.code === 'ENOENT') {
        results.push(record('icon', action.id, 'skipped', `no file at ${action.iconFile}`));
        continue;
      }
      results.push(record('icon', action.id, 'failed', err.message));
      failed = true;
      continue;
    }

    if (dryRun) {
      results.push(record('icon', action.id, 'would upload', action.iconFile));
      continue;
    }

    try {
      await client.uploadIcon(action.id, action.iconFile, bytes);
      results.push(record('icon', action.id, 'uploaded', action.iconFile));
    } catch (err) {
      results.push(record('icon', action.id, 'failed', err.message));
      failed = true;
    }
  }

  if (failed) return finish();

  const instancesOk = await runSection(plan.instanceActions, async (action) =>
    action.action === 'create'
      ? client.createInstance({ id: action.id, ...action.payload })
      : client.updateInstance(action.id, action.payload)
  );

  if (!instancesOk) return finish();

  // Layout is one PUT for all changed breakpoints — `store.save` writes them
  // in a single transaction, so a two-breakpoint save cannot land half
  // applied. Sending one request per breakpoint would give up that guarantee
  // for nothing.
  const changedLayout = plan.layoutActions.filter((a) => a.action !== 'skip');
  for (const action of plan.layoutActions.filter((a) => a.action === 'skip')) {
    results.push(record('layout', action.id, 'skipped'));
  }

  if (changedLayout.length) {
    if (dryRun) {
      for (const action of changedLayout) {
        results.push(
          record('layout', action.id, `would ${action.action}`, `${action.payload.length} node(s)`)
        );
      }
    } else {
      const payload = Object.fromEntries(changedLayout.map((a) => [a.id, a.payload]));
      try {
        await client.saveLayout(payload);
        for (const action of changedLayout) {
          results.push(
            record('layout', action.id, `${action.action}d`, `${action.payload.length} node(s)`)
          );
        }
      } catch (err) {
        for (const action of changedLayout) {
          results.push(record('layout', action.id, 'failed', err.message));
        }
        failed = true;
      }
    }
  }

  return finish();

  function finish() {
    return { ok: !failed, results, dryRun, migration: desired.migration };
  }
}

/** A short human note about what an action carries, for the report. */
function describe(action) {
  if (action.kind === 'instance' && action.keptSecrets?.length) {
    return `kept stored secret(s): ${action.keptSecrets.join(', ')}`;
  }
  return null;
}

/**
 * Reads a live Haven back out into the seed format.
 *
 * The output is deliberately re-appliable with no editing. Two things make
 * that true:
 *
 *   - server-owned fields are stripped (`visitCount` would be REJECTED by
 *     `apps-schema.js`, not ignored, so leaving it in would fail every app)
 *   - a stored secret comes back as the sentinel, which `apply` then omits
 *     rather than sending. Export never invents a value it cannot see, and
 *     never writes a placeholder that would overwrite a real credential.
 *
 * `iconFile` is not emitted: a live server has no local path to offer, only
 * the stored filename, which is what `icon` already carries.
 */
export async function exportSeed(client) {
  const [apps, instances, layout] = await Promise.all([
    client.listApps(),
    client.listInstances(),
    client.getLayout(),
  ]);

  const doc = {
    version: SEED_VERSION,
    apps: apps.map((app) => {
      const clean = stripServerOwned(app);
      // Drop the nulls the API always sends, so a hand-edited file and an
      // exported one look like the same document rather than differing by a
      // wall of `"version": null`.
      if (clean.version === null) delete clean.version;
      if (clean.featured === null) delete clean.featured;
      if (clean.icon === null) delete clean.icon;
      return clean;
    }),
    instances: instances.map((instance) => {
      const clean = stripServerOwned(instance);

      // Re-declare `secretKeys` from the sentinels the API returned.
      //
      // This is not cosmetic. `secretKeys` is what tells the server which
      // config keys to route to the credential store; without it a later
      // update treats the key as an ordinary field, and since `apply` strips
      // the sentinel from the payload the key simply vanishes from the config
      // blob. The credential itself survives in the store, orphaned, while the
      // widget stops knowing a secret is set at all — a silent
      // de-configuration that an exported-then-edited file would cause on the
      // first unrelated change.
      const secretKeys = Object.entries(clean.config ?? {})
        .filter(([, value]) => value === SECRET_SET)
        .map(([key]) => key);

      return secretKeys.length ? { ...clean, secretKeys } : clean;
    }),
    layout: {},
  };

  for (const [breakpoint, nodes] of Object.entries(layout)) {
    doc.layout[breakpoint] = nodes;
  }

  return doc;
}

/** Which instance ids a document's layout points at — re-exported for the CLI. */
export { layoutReferences };

/** Resolves `iconFile` paths against the seed file's own directory. */
export const baseDirOf = (filePath) => dirname(resolve(filePath));
