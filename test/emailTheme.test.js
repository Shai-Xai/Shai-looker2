// Email theme: preset resolution against brand + colour validation (values go into
// inline styles, so only safe colours may pass).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const et = require('../server/emailTheme');
const eb = require('../server/emailBlocks');

test('resolve: preset supplies the palette; accent falls back to the brand colour', () => {
  const r = et.resolve({ preset: 'bold' }, { brandColor: '#ff385c' });
  assert.equal(r.bg, '#0b0b0f');       // bold preset
  assert.equal(r.accent, '#ff385c');   // ← brand
  assert.equal(r.flat, false);
  const clean = et.resolve({}, {});
  assert.equal(clean.bg, '#f5f5f7');   // default preset
  assert.equal(clean.radiusPx, '980px');
});

test('resolve: explicit theme fields override the preset', () => {
  const r = et.resolve({ preset: 'clean', accent: '#00ff00', font: 'serif', radius: 'square', cardStyle: 'flat' }, {});
  assert.equal(r.accent, '#00ff00');
  assert.match(r.fontStack, /Georgia/);
  assert.equal(r.radiusPx, '0');
  assert.equal(r.flat, true);
});

test('clean: rejects unsafe colours + unknown enums (no CSS injection)', () => {
  const c = et.clean({ preset: 'nope', accent: 'red;}body{x', font: 'comic', radius: 'huge' });
  assert.equal(c.preset, 'clean');           // unknown preset → default
  assert.equal(c.accent, '');                // unsafe colour dropped
  assert.equal('font' in c, false);          // unknown font dropped
  assert.equal('radius' in c, false);
  assert.equal(et.clean({ accent: '#abc' }).accent, '#abc'); // valid hex kept
});

test('render: a resolved theme paints buttons/text/headings with its tokens', () => {
  const theme = et.resolve({ preset: 'bold', accent: '#123456', radius: 'square' }, {});
  const { html } = eb.render([
    { type: 'heading', text: 'Hi' },
    { type: 'button', text: 'Go', href: 'https://x' },
  ], { theme });
  assert.match(html, /color:#ffffff/);        // bold heading colour
  assert.match(html, /background:#123456/);   // accent button
  assert.match(html, /border-radius:0/);      // square button
});
