// AI email banners: SVG sanitising (defence-in-depth) + rasterisation to PNG.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bn = require('../server/emailBanner');

test('sanitizeSvg: keeps the <svg>, strips scripts / foreignObject / handlers / external refs', () => {
  const dirty = `<p>hi</p><svg xmlns="http://www.w3.org/2000/svg" width="100" height="40">
    <script>alert(1)</script>
    <rect width="100" height="40" fill="#f0f" onclick="evil()"/>
    <image href="https://evil/x.png"/>
    <foreignObject><body>x</body></foreignObject>
    <use xlink:href="#ok"/>
  </svg><span>after</span>`;
  const clean = bn.sanitizeSvg(dirty);
  assert.match(clean, /^<svg/);
  assert.match(clean, /<\/svg>$/);
  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /foreignObject/i);
  assert.doesNotMatch(clean, /onclick/i);
  assert.doesNotMatch(clean, /https:\/\/evil/);
  assert.match(clean, /xlink:href="#ok"/); // internal fragment ref kept
  assert.doesNotMatch(clean, /<p>|<span>/);  // surrounding markup dropped
});

test('sanitizeSvg: null when there is no svg', () => {
  assert.equal(bn.sanitizeSvg('just text'), null);
  assert.equal(bn.sanitizeSvg(''), null);
});

test('svgToPngDataUrl: renders a valid SVG to a PNG data-URL', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48"><rect width="120" height="48" fill="#ff385c"/></svg>';
  const url = bn.svgToPngDataUrl(svg, { width: 120 });
  assert.match(url, /^data:image\/png;base64,/);
  assert.ok(url.length > 200); // actual PNG bytes
  assert.equal(bn.svgToPngDataUrl('nope', { width: 120 }), null);
});
