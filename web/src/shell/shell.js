/**
 * The widget shell.
 *
 * The shell owns fetching, caching, auth, dedup and refresh; widgets are
 * near-pure render functions that receive data and draw it. See
 * docs/WIDGET-CONTRACT.md — that split is the single most important
 * decision in this codebase and every widget depends on it.
 */
export function mountShell(root) {
  if (!root) throw new Error('mountShell: no root element');

  root.innerHTML = '<p class="haven-boot">Haven — scaffold. No widgets registered yet.</p>';
}
