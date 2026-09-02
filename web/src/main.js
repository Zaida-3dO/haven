import { bootDashboard } from './shell/boot.js';

bootDashboard(document.querySelector('#haven-grid'), {
  chrome: document.querySelector('#haven-chrome'),
  pageRoot: document.querySelector('#haven-page'),
  // The two-column layout element. The sidebar is appended here as a sibling
  // of the chrome, and the header is inserted before it so the bar spans both.
  layoutRoot: document.querySelector('#haven-layout'),
});
