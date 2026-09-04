/**
 * The URL allowlist and sandbox policy.
 *
 * This is the security-critical half of the iframe widget: an embed URL is
 * user-supplied config that ends up in `iframe[src]`, which is a script-
 * execution sink. These tests are the allowlist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_PROTOCOLS,
  DEFAULT_SANDBOX,
  EmbedUrlError,
  defeatsSandbox,
  isSafeEmbedUrl,
  parseEmbedUrl,
  sandboxTokens,
} from '../src/widgets/iframe/embed-url.js';

test('accepts http and https embeds', () => {
  assert.equal(parseEmbedUrl('https://example.invalid/page'), 'https://example.invalid/page');
  assert.equal(parseEmbedUrl('http://example.invalid/page'), 'http://example.invalid/page');
});

test('accepts a relative path and returns it unchanged', () => {
  // A relative path must not be rewritten to an absolute one — the stored
  // config and the live src would then disagree the moment the dashboard
  // changed host. (The 3D home has moved to an absolute public URL, but any
  // page Haven serves itself is still embeddable by path.)
  assert.equal(parseEmbedUrl('/home3d.html?preview=true'), '/home3d.html?preview=true');
});

test('refuses a javascript: URL', () => {
  // The whole reason this module exists: `javascript:` in an iframe src runs
  // in the DASHBOARD's origin, sandbox or no sandbox.
  assert.throws(() => parseEmbedUrl('javascript:alert(1)'), EmbedUrlError);
});

test('refuses a javascript: URL however it is cased or padded', () => {
  assert.throws(() => parseEmbedUrl('  JaVaScRiPt:alert(1)  '), EmbedUrlError);
});

test('refuses a data: URL', () => {
  assert.throws(() => parseEmbedUrl('data:text/html,<script>alert(1)</script>'), EmbedUrlError);
});

test('refuses other schemes an allowlist catches but a blocklist would not', () => {
  for (const bad of ['blob:https://example.invalid/x', 'vbscript:msgbox', 'file:///etc/passwd']) {
    assert.throws(() => parseEmbedUrl(bad), EmbedUrlError, `expected ${bad} to be refused`);
  }
});

test('refuses an empty or missing URL', () => {
  assert.throws(() => parseEmbedUrl(''), EmbedUrlError);
  assert.throws(() => parseEmbedUrl('   '), EmbedUrlError);
  assert.throws(() => parseEmbedUrl(undefined), EmbedUrlError);
});

test('the allowlist is http and https only', () => {
  assert.deepEqual([...ALLOWED_PROTOCOLS], ['http:', 'https:']);
});

test('isSafeEmbedUrl answers without throwing', () => {
  assert.equal(isSafeEmbedUrl('https://example.invalid/'), true);
  assert.equal(isSafeEmbedUrl('javascript:alert(1)'), false);
});

test('the default sandbox does NOT include allow-same-origin', () => {
  // The decision this widget is most likely to be got wrong by a later edit:
  // allow-scripts + allow-same-origin on a same-origin page is no sandbox at
  // all. If someone adds it to the defaults, this test is what stops them.
  assert.ok(!DEFAULT_SANDBOX.includes('allow-same-origin'));
  assert.equal(sandboxTokens({}), 'allow-scripts');
});

test('optional sandbox tokens are added only when opted into', () => {
  assert.equal(sandboxTokens({ allowForms: 'yes' }), 'allow-forms allow-scripts');
  assert.equal(sandboxTokens({ allowPopups: 'yes' }), 'allow-popups allow-scripts');
  assert.equal(sandboxTokens({ allowForms: 'no', allowPopups: 'no' }), 'allow-scripts');
});

test('an arbitrary config key cannot inject a sandbox token', () => {
  // The token list is closed on purpose: free text would let a stored config
  // write allow-same-origin in and bypass the deliberate opt-in.
  assert.equal(
    sandboxTokens({ 'allow-top-navigation': 'yes', evil: 'allow-same-origin' }),
    'allow-scripts'
  );
});

test('defeatsSandbox flags the allow-scripts + allow-same-origin pairing', () => {
  assert.equal(defeatsSandbox({}), false);
  assert.equal(defeatsSandbox({ allowForms: 'yes' }), false);
  assert.equal(defeatsSandbox({ allowSameOrigin: 'yes' }), true);
});
