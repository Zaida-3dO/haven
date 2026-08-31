/**
 * Forwarding geometry into an embedded frame.
 *
 * Pure module, so no DOM double is needed beyond an object with a
 * `contentWindow`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESIZE_MESSAGE_TYPE,
  frameOrigin,
  postGeometry,
  resizeMessage,
} from '../src/widgets/iframe/geometry.js';

function fakeFrame(src, { withWindow = true } = {}) {
  const posted = [];
  return {
    posted,
    getAttribute: (name) => (name === 'src' ? src : null),
    contentWindow: withWindow
      ? { postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin }) }
      : undefined,
  };
}

test('the message carries pixels and cells under a namespaced type', () => {
  const message = resizeMessage({ width: 640.4, height: 480.6, cells: { w: 6, h: 4 } });

  assert.equal(message.type, RESIZE_MESSAGE_TYPE);
  assert.equal(message.type, 'haven:resize');
  // Rounded: renderer.setSize wants integers.
  assert.equal(message.width, 640);
  assert.equal(message.height, 481);
  assert.deepEqual(message.cells, { w: 6, h: 4 });
});

test('negative or missing geometry clamps to zero rather than going out negative', () => {
  assert.deepEqual(resizeMessage({ width: -10, height: undefined }), {
    type: RESIZE_MESSAGE_TYPE,
    width: 0,
    height: 0,
    cells: { w: 0, h: 0 },
  });
});

test('a cross-origin frame is addressed by its own origin', () => {
  const frame = fakeFrame('https://scene.invalid/view?x=1');
  assert.equal(postGeometry(frame, { width: 10, height: 10 }), true);
  assert.equal(frame.posted[0].targetOrigin, 'https://scene.invalid');
});

test('geometry is never posted to the * wildcard', () => {
  // Posting to '*' delivers to whatever document is in the frame now, which
  // is the habit that leaks the messages that ARE secret.
  const frame = fakeFrame('https://scene.invalid/view');
  postGeometry(frame, { width: 10, height: 10 });
  assert.notEqual(frame.posted[0].targetOrigin, '*');
});

test('a relative embed is addressed as same-origin', () => {
  const frame = fakeFrame('/home3d.html?preview=true');
  assert.equal(
    frameOrigin(frame, { pageOrigin: 'https://haven.invalid' }),
    'https://haven.invalid'
  );
});

test('nothing is posted when the frame has not loaded yet', () => {
  // The lazy-load path: no contentWindow is not an error, and the next resize
  // after load carries the geometry.
  const frame = fakeFrame('/home3d.html', { withWindow: false });
  assert.equal(postGeometry(frame, { width: 10, height: 10 }), false);
});

test('nothing is posted when no origin can be determined', () => {
  // Rather than falling back to '*'.
  const frame = fakeFrame('/home3d.html');
  assert.equal(frameOrigin(frame, { pageOrigin: undefined }), null);
  assert.equal(postGeometry(frame, { width: 1, height: 1 }, { origin: null }), false);
});

test('a frame with no src has no origin', () => {
  assert.equal(frameOrigin(fakeFrame('')), null);
});
