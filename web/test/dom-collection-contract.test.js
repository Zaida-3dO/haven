import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

/**
 * `children` is an HTMLCollection, not an array.
 *
 * The fake DOM these tests run against backs `children` with a plain JS array
 * for simplicity — a reasonable choice that makes it silently MORE capable
 * than the real thing. A real `HTMLCollection` has no `.entries()`, `.map()`,
 * `.filter()`, `.forEach()` or `.find()`; an array has all of them.
 *
 * So `nodes.dots.children.entries()` passed every test and threw in the
 * browser, and the hero's error boundary drew "Hero failed" in place of the
 * whole carousel. The test suite could not see it, because the emulation was
 * kinder than reality.
 *
 * Rather than make the fake stricter — which would break unrelated tests that
 * legitimately treat it as an array in their own assertions — this scans the
 * source for array methods reached for directly off `.children`. Wrap it:
 * `Array.from(el.children)` first, then iterate.
 */

const ARRAY_ONLY = ['entries', 'map', 'filter', 'forEach', 'find', 'reduce', 'some', 'every'];

/** Every source file under web/src, recursively. */
function sources(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) sources(path, found);
    else if (entry.name.endsWith('.js')) found.push([path, readFileSync(path, 'utf8')]);
  }
  return found;
}

const files = sources(new URL('../src/', import.meta.url));

test('the scan actually reaches the source tree', () => {
  // A scan over zero files passes vacuously, which is the failure mode that
  // makes a guard like this worthless.
  assert.ok(files.length > 20, `expected to scan the web source, found ${files.length} files`);
});

for (const method of ARRAY_ONLY) {
  test(`no code calls .children.${method}() — HTMLCollection has no such method`, () => {
    const offenders = files
      .filter(([, src]) =>
        new RegExp(String.raw`\.children\s*\.\s*` + method + String.raw`\s*\(`).test(src)
      )
      .map(([url]) => url.pathname.split('/').slice(-2).join('/'));

    assert.deepEqual(
      offenders,
      [],
      `${offenders.join(', ')} — wrap it: Array.from(el.children).${method}(...)`
    );
  });
}
