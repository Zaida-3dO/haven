// Builds the Haven logo pack ("island at dusk") from one definition of the art: SVGs,
// Android vector drawables, PNGs at every size, favicon.ico, and the web shell's icons in
// web/public. Edit the art here, never the generated files.
//
// Run from the repo root: node brand/build-pack.mjs
// (Playwright's Chromium rasterises the PNGs: npx playwright install chromium)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const OUT = path.dirname(fileURLToPath(import.meta.url));
const WEB_PUBLIC = path.join(OUT, '..', 'web', 'public');

// ---- the art ---------------------------------------------------------------------------

const circle = (cx, cy, r) =>
  `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
const rect = (x, y, w, h) => `M${x} ${y} H${x + w} V${y + h} H${x} Z`;

const gradients = {
  sky: {
    x1: 0,
    y1: 96,
    x2: 0,
    y2: 318,
    stops: [
      [0, '#1E2A5C'],
      [0.5, '#55508F'],
      [0.82, '#C77F92'],
      [1, '#F4B183'],
    ],
  },
  sea: {
    x1: 0,
    y1: 318,
    x2: 0,
    y2: 512,
    stops: [
      [0, '#3B4F8C'],
      [1, '#18234D'],
    ],
  },
  sun: {
    x1: 0,
    y1: 208,
    x2: 0,
    y2: 318,
    stops: [
      [0, '#FFF1CC'],
      [1, '#FFC07E'],
    ],
  },
  isle: {
    x1: 0,
    y1: 250,
    x2: 0,
    y2: 320,
    stops: [
      [0, '#24485A'],
      [1, '#1A3346'],
    ],
  },
  skyS: {
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 330,
    stops: [
      [0, '#2A2F66'],
      [0.6, '#8A6497'],
      [1, '#F4B183'],
    ],
  },
  sunS: {
    x1: 0,
    y1: 120,
    x2: 0,
    y2: 330,
    stops: [
      [0, '#FFF1CC'],
      [1, '#FFC07E'],
    ],
  },
};

const INK = '#1A3346';
const row = (d, color) => ({ d, stroke: color, strokeWidth: 8, cap: 'round' });

// Full icon, split into the two Android adaptive-icon layers.
const background = [
  { d: rect(0, 0, 512, 318), fill: 'sky' },
  { d: rect(0, 318, 512, 194), fill: 'sea' },
];
const foreground = [
  // constellation
  {
    d: 'M164 186 L202 160 L240 176 L272 146 M202 160 L210 126',
    stroke: '#E8E6FF',
    strokeWidth: 2.5,
    cap: 'round',
    join: 'round',
    strokeAlpha: 0.55,
  },
  ...[
    [164, 186, 5],
    [202, 160, 6],
    [240, 176, 4.5],
    [272, 146, 5.5],
    [210, 126, 4],
  ].map(([x, y, r]) => ({ d: circle(x, y, r), fill: '#F4F2FF' })),
  { d: circle(352, 144, 3), fill: '#F4F2FF', fillAlpha: 0.7 },
  { d: circle(384, 186, 2.5), fill: '#F4F2FF', fillAlpha: 0.6 },
  { d: circle(322, 112, 2), fill: '#F4F2FF', fillAlpha: 0.6 },
  // setting sun, cut at the horizon
  { d: 'M170.13 318 A84 84 0 1 1 329.87 318 Z', fill: 'sun' },
  // the sun's reflection, as rows of data
  row('M178 340 H272 M290 340 H322', '#FFC98E'),
  row('M196 358 H230 M246 358 H304', '#EDB08E'),
  row('M212 376 H288', '#C99693'),
  row('M226 394 H244 M260 394 H274', '#A07F97'),
  row('M240 412 H260', '#7E6C95'),
  { d: circle(337, 340, 5.5), fill: '#FFC98E' },
  { d: circle(181, 358, 5), fill: '#EDB08E' },
  { d: circle(303, 376, 4.5), fill: '#C99693' },
  // island, house and tree
  {
    group: { scale: 1.16, pivot: [229, 320], to: [250, 320] },
    children: [
      {
        d: 'M132 322 C160 300 186 286 214 280 C236 274 268 274 292 284 C304 290 316 304 326 322 Z',
        fill: 'isle',
      },
      { d: 'M188 286 L188 246 L216 220 L244 246 L244 280 Z', fill: INK },
      { d: 'M182 250 L216 218 L250 250', stroke: INK, strokeWidth: 8, cap: 'round', join: 'round' },
      { d: 'M206 280 V264 A10 10 0 0 1 226 264 V280 Z', fill: '#FFC57A' },
      { d: circle(216, 244, 6), fill: '#FFC57A' },
      { d: 'M270 282 V264', stroke: INK, strokeWidth: 6, cap: 'round' },
      {
        d: 'M270 238 C278 238 284 248 284 256 C284 264 278 268 270 268 C262 268 256 264 256 256 C256 248 262 238 270 238 Z',
        fill: INK,
      },
    ],
  },
];

// Small-size art (48px and below): sun halo, island house, two reflection bars.
const small = [
  { d: rect(0, 0, 512, 512), fill: 'skyS' },
  { d: circle(256, 270, 150), fill: 'sunS' },
  { d: rect(0, 330, 512, 182), fill: '#2C3D78' },
  { d: 'M150 382 H362', stroke: '#FFC98E', strokeWidth: 30, cap: 'round' },
  { d: 'M206 440 H306', stroke: '#C99693', strokeWidth: 30, cap: 'round' },
  { d: 'M40 334 C120 278 190 262 256 262 C322 262 392 278 472 334 Z', fill: INK },
  {
    d: 'M200 272 V206 H182 L256 136 L330 206 H312 V272 Z',
    fill: INK,
    stroke: INK,
    strokeWidth: 10,
    join: 'round',
  },
  { d: 'M236 272 V236 A20 20 0 0 1 276 236 V272 Z', fill: '#FFC57A' },
];

// One-colour version (Android themed icons, Safari pinned tab, print, stamps).
const MONO = '#000000';
const mono = [
  // The ring ends inside the island, so its round caps never poke out below it.
  { d: 'M166.67 312 A92 92 0 1 1 345.33 312', stroke: MONO, strokeWidth: 14, cap: 'round' },
  { d: 'M140 322 C176 294 214 282 256 282 C298 282 336 294 372 322 Z', fill: MONO },
  {
    d: 'M226 290 V250 H214 L256 208 L298 250 H286 V290 Z M246 290 V268 A10 10 0 0 1 266 268 V290 Z',
    fill: MONO,
    evenOdd: true,
  },
  { d: 'M196 344 H316', stroke: MONO, strokeWidth: 10, cap: 'round' },
  { d: 'M216 366 H296', stroke: MONO, strokeWidth: 10, cap: 'round' },
  { d: 'M236 388 H276', stroke: MONO, strokeWidth: 10, cap: 'round' },
];

// ---- SVG -------------------------------------------------------------------------------

function svgDefs(els) {
  const used = new Set();
  const walk = (list) =>
    list.forEach((e) =>
      e.group ? walk(e.children) : [e.fill, e.stroke].forEach((c) => c in gradients && used.add(c))
    );
  walk(els);
  if (!used.size) return '';
  const defs = [...used].map((id) => {
    const g = gradients[id];
    const stops = g.stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
    return `<linearGradient id="${id}" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`;
  });
  return `  <defs>\n    ${defs.join('\n    ')}\n  </defs>\n`;
}

const paint = (c) => (c in gradients ? `url(#${c})` : c);

function svgEls(els, indent = '  ') {
  return els
    .map((e) => {
      if (e.group) {
        const { scale, pivot, to } = e.group;
        return `${indent}<g transform="translate(${to[0]} ${to[1]}) scale(${scale}) translate(${-pivot[0]} ${-pivot[1]})">\n${svgEls(e.children, indent + '  ')}\n${indent}</g>`;
      }
      const a = [`d="${e.d}"`, `fill="${e.fill ? paint(e.fill) : 'none'}"`];
      if (e.fillAlpha != null) a.push(`fill-opacity="${e.fillAlpha}"`);
      if (e.evenOdd) a.push('fill-rule="evenodd"');
      if (e.stroke) {
        a.push(`stroke="${paint(e.stroke)}"`, `stroke-width="${e.strokeWidth}"`);
        if (e.cap) a.push(`stroke-linecap="${e.cap}"`);
        if (e.join) a.push(`stroke-linejoin="${e.join}"`);
        if (e.strokeAlpha != null) a.push(`stroke-opacity="${e.strokeAlpha}"`);
      }
      return `${indent}<path ${a.join(' ')}/>`;
    })
    .join('\n');
}

function svg(els, { title, clip } = {}) {
  let body = svgEls(els, clip ? '    ' : '  ');
  let defs = svgDefs(els);
  if (clip) {
    const shape =
      clip === 'circle'
        ? '<circle cx="256" cy="256" r="256"/>'
        : '<rect width="512" height="512" rx="112"/>';
    const clipDef = `<clipPath id="shape">${shape}</clipPath>`;
    defs = defs
      ? defs.replace('  </defs>', `    ${clipDef}\n  </defs>`)
      : `  <defs>\n    ${clipDef}\n  </defs>\n`;
    body = `  <g clip-path="url(#shape)">\n${body}\n  </g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n  <!-- ${title} -->\n${defs}${body}\n</svg>\n`;
}

// ---- Android vector drawable -----------------------------------------------------------

const argb = (hex, alpha = 1) =>
  '#' +
  Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase() +
  hex.slice(1).toUpperCase();

function vdGradient(attr, id, indent) {
  const g = gradients[id];
  const items = g.stops
    .map(([o, c]) => `${indent}      <item android:offset="${o}" android:color="${argb(c)}" />`)
    .join('\n');
  return `${indent}  <aapt:attr name="android:${attr}">\n${indent}    <gradient android:type="linear" android:startX="${g.x1}" android:startY="${g.y1}" android:endX="${g.x2}" android:endY="${g.y2}">\n${items}\n${indent}    </gradient>\n${indent}  </aapt:attr>\n`;
}

function vdEls(els, indent = '    ') {
  return els
    .map((e) => {
      if (e.group) {
        const { scale, pivot, to } = e.group;
        return `${indent}<group android:pivotX="${pivot[0]}" android:pivotY="${pivot[1]}" android:scaleX="${scale}" android:scaleY="${scale}" android:translateX="${to[0] - pivot[0]}" android:translateY="${to[1] - pivot[1]}">\n${vdEls(e.children, indent + '    ')}\n${indent}</group>`;
      }
      const a = [`android:pathData="${e.d}"`];
      let inner = '';
      if (e.fill) {
        if (e.fill in gradients) inner += vdGradient('fillColor', e.fill, indent);
        else a.push(`android:fillColor="${argb(e.fill)}"`);
      }
      if (e.fillAlpha != null) a.push(`android:fillAlpha="${e.fillAlpha}"`);
      if (e.evenOdd) a.push('android:fillType="evenOdd"');
      if (e.stroke) {
        if (e.stroke in gradients) inner += vdGradient('strokeColor', e.stroke, indent);
        else a.push(`android:strokeColor="${argb(e.stroke)}"`);
        a.push(`android:strokeWidth="${e.strokeWidth}"`);
        if (e.cap) a.push(`android:strokeLineCap="${e.cap}"`);
        if (e.join) a.push(`android:strokeLineJoin="${e.join}"`);
        if (e.strokeAlpha != null) a.push(`android:strokeAlpha="${e.strokeAlpha}"`);
      }
      const open = `${indent}<path\n${a.map((x) => `${indent}    ${x}`).join('\n')}`;
      return inner ? `${open}>\n${inner}${indent}</path>` : `${open} />`;
    })
    .join('\n');
}

function vd(els, comment) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- ${comment} Generated by build-pack.mjs in the Haven logo pack. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
${vdEls(els)}
</vector>
`;
}

const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`;

// ---- favicon.ico (PNG-encoded entries) -------------------------------------------------

function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, o);
    head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt8(0, o + 2);
    head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(buf.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}

// ---- build -----------------------------------------------------------------------------

const write = (rel, data) => {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};

const full = [...background, ...foreground];
const svgs = {
  'haven-icon.svg': svg(full, { title: 'Haven icon: full art, square. Use at 64px and up.' }),
  'haven-icon-rounded.svg': svg(full, {
    title: 'Haven icon: full art, rounded square.',
    clip: 'rounded',
  }),
  'haven-icon-circle.svg': svg(full, { title: 'Haven icon: full art, circle.', clip: 'circle' }),
  'haven-icon-small.svg': svg(small, {
    title: 'Haven icon: simplified art for 48px and below (favicons, tabs, toolbars).',
  }),
  'haven-icon-small-rounded.svg': svg(small, {
    title: 'Haven icon: simplified art, rounded square.',
    clip: 'rounded',
  }),
  'haven-icon-small-circle.svg': svg(small, {
    title: 'Haven icon: simplified art, circle.',
    clip: 'circle',
  }),
  'haven-icon-mono.svg': svg(
    [{ group: { scale: 1.85, pivot: [256, 297], to: [256, 256] }, children: mono }],
    { title: 'Haven icon: one colour (black on transparent). Recolour with fill/stroke or CSS.' }
  ),
};
for (const dir of ['svg', 'png', 'web', 'android'])
  fs.rmSync(path.join(OUT, dir), { recursive: true, force: true });
for (const [name, text] of Object.entries(svgs)) write(`svg/${name}`, text);

write(
  'android/res/drawable/ic_launcher_background.xml',
  vd(background, 'Haven launcher icon, background layer: dusk sky and sea.')
);
write(
  'android/res/drawable/ic_launcher_foreground.xml',
  vd(foreground, 'Haven launcher icon, foreground layer: sun, island house, reflection, stars.')
);
write(
  'android/res/drawable/ic_launcher_monochrome.xml',
  vd(mono, 'Haven launcher icon, monochrome layer (themed icons).')
);
write('android/res/mipmap-anydpi/ic_launcher.xml', adaptive);
write('android/res/mipmap-anydpi/ic_launcher_round.xml', adaptive);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1100, height: 1100 },
  deviceScaleFactor: 1,
});
async function png(svgText, size) {
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svgText).toString('base64');
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img id="i" src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`
  );
  await page.waitForFunction(() => document.getElementById('i').complete);
  return page.locator('#i').screenshot({ omitBackground: true });
}
const pick = (size, kind = '') => svgs[`haven-icon${size <= 48 ? '-small' : ''}${kind}.svg`];

for (const s of [16, 24, 32, 48, 64, 96, 128, 180, 192, 256, 384, 512, 1024])
  write(`png/square/haven-icon-${s}.png`, await png(pick(s), s));
for (const s of [16, 24, 32, 48, 64, 96, 128, 192, 256, 512])
  write(`png/rounded/haven-icon-rounded-${s}.png`, await png(pick(s, '-rounded'), s));
for (const s of [16, 24, 32, 48, 64, 96, 128, 192, 256, 512])
  write(`png/circle/haven-icon-circle-${s}.png`, await png(pick(s, '-circle'), s));
for (const s of [24, 48, 96, 192, 512])
  write(`png/mono/haven-icon-mono-${s}.png`, await png(svgs['haven-icon-mono.svg'], s));

// Web: favicons, Apple touch icon, PWA icons.
const icoParts = [];
for (const s of [16, 32, 48])
  icoParts.push({ size: s, buf: await png(svgs['haven-icon-small.svg'], s) });
write('web/favicon.ico', ico(icoParts));
write('web/favicon.svg', svgs['haven-icon-small.svg']);
write('web/favicon-16.png', icoParts[0].buf);
write('web/favicon-32.png', icoParts[1].buf);
write('web/apple-touch-icon.png', await png(svgs['haven-icon.svg'], 180));
write('web/icon-192.png', await png(svgs['haven-icon.svg'], 192));
write('web/icon-512.png', await png(svgs['haven-icon.svg'], 512));
write('web/icon-maskable-512.png', await png(svgs['haven-icon.svg'], 512));
write('web/mask-icon.svg', svgs['haven-icon-mono.svg']);
write(
  'web/site.webmanifest',
  JSON.stringify(
    {
      name: 'Haven',
      short_name: 'Haven',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      theme_color: '#1E2A5C',
      background_color: '#1E2A5C',
      display: 'standalone',
    },
    null,
    2
  ) + '\n'
);

// Android: legacy launcher PNGs (pre-adaptive launchers, other stores) and the Play Store icon.
for (const [dpi, s] of [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
]) {
  write(
    `android/legacy-mipmaps/mipmap-${dpi}/ic_launcher.png`,
    await png(svgs[s <= 48 ? 'haven-icon-small-rounded.svg' : 'haven-icon-rounded.svg'], s)
  );
  write(
    `android/legacy-mipmaps/mipmap-${dpi}/ic_launcher_round.png`,
    await png(svgs[s <= 48 ? 'haven-icon-small-circle.svg' : 'haven-icon-circle.svg'], s)
  );
}
write('android/play-store-512.png', await png(svgs['haven-icon.svg'], 512));

await browser.close();

// The web shell serves these from its root (Vite copies web/public into dist). The topbar
// mark is the small art, since it shows at 36px.
fs.mkdirSync(WEB_PUBLIC, { recursive: true });
for (const f of fs.readdirSync(path.join(OUT, 'web')))
  fs.copyFileSync(path.join(OUT, 'web', f), path.join(WEB_PUBLIC, f));
fs.copyFileSync(
  path.join(OUT, 'svg', 'haven-icon-small.svg'),
  path.join(WEB_PUBLIC, 'haven-mark.svg')
);
console.log('built', OUT);
