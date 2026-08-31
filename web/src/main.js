import { bootDashboard } from './shell/boot.js';

bootDashboard(document.querySelector('#haven-grid'), {
  chrome: document.querySelector('#haven-chrome'),
  pageRoot: document.querySelector('#haven-page'),
});
