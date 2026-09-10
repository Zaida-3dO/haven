import { bootDashboard } from './shell/boot.js';

/**
 * The booted dashboard is published on `window.__haven`.
 *
 * `bootDashboard` already returns the handle — the dashboard, the grid, edit
 * mode and the panels — and this only stops it being dropped on the floor. It
 * is what lets the browser tests assert against the *real* objects (that a
 * widget's `onResize` was called, that edit mode holds a snapshot) instead of
 * inferring it from the DOM, and it is a useful console handle when debugging
 * a live dashboard.
 *
 * Nothing sensitive is exposed: these are the same front-end objects the page
 * already holds, and every credential lives on the server by design.
 */
window.__haven = await bootDashboard(document.querySelector('#haven-grid'), {
  chrome: document.querySelector('#haven-chrome'),
  pageRoot: document.querySelector('#haven-page'),
  // The two-column layout element. The sidebar is appended here as a sibling
  // of the chrome, and the header is inserted before it so the bar spans both.
  layoutRoot: document.querySelector('#haven-layout'),
});
