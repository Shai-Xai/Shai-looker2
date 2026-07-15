// The living-doc pages (Product Overview, client API guide) render their
// markdown with a SELF-HOSTED renderer (docs/vendor/md-lite.js) instead of a
// CDN <script>. This guards two things:
//   1. the renderer handles the GFM subset those docs actually use, and
//   2. no living-doc page ever reintroduces an external-CDN dependency
//      (the exact bug from issue #42 — page dies when the CDN is blocked).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const marked = require('../docs/vendor/md-lite.js');
const DOCS = path.join(__dirname, '..', 'docs');
const NUL = String.fromCharCode(0);

test('exposes a marked-compatible surface', () => {
  assert.equal(typeof marked.parse, 'function');
  assert.equal(typeof marked.setOptions, 'function');
  assert.equal(marked.setOptions({ gfm: true, breaks: false }), marked); // chainable
});

test('renders the core GFM constructs', () => {
  const html = marked.parse([
    '# Title',
    '',
    'A **bold** and *italic* and `code` and [link](https://x.io).',
    '',
    '> a quote',
    '> - nested item',
    '',
    '- one',
    '  - sub',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '| A | B |',
    '| --- | ---: |',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = 1 < 2;',
    '```',
    '',
    '---',
  ].join('\n'));

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/x\.io">link<\/a>/);
  assert.match(html, /<blockquote>[\s\S]*<li>nested item<\/li>[\s\S]*<\/blockquote>/);
  assert.match(html, /<ul><li>one<ul><li>sub<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<table>[\s\S]*<th>A<\/th>[\s\S]*text-align:right[\s\S]*<td>1<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<pre><code class="language-js">const x = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /<hr>/);
});

test('escapes raw HTML in prose (no injection)', () => {
  const html = marked.parse('a <script>alert(1)</script> b');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('a code span containing a bare number is preserved (sentinel does not collide)', () => {
  // Regression: an early sentinel design used " N " which collided with prose
  // like "the last 30 days", turning it into `undefined`.
  const html = marked.parse('Keep `30` and the last 30 days for 12 months.');
  assert.match(html, /<code>30<\/code>/);
  assert.match(html, /the last 30 days for 12 months/);
  assert.doesNotMatch(html, /undefined/);
});

test('the real living docs render without artefacts', () => {
  for (const file of ['PRODUCT_OVERVIEW_SALES.md', 'CLIENT_API_GUIDE.md']) {
    const md = fs.readFileSync(path.join(DOCS, file), 'utf8');
    const html = marked.parse(md);
    assert.ok(html.length > 500, `${file} produced very little HTML`);
    assert.doesNotMatch(html, new RegExp(NUL), `${file}: leftover placeholder sentinel`);
    assert.doesNotMatch(html, />undefined</, `${file}: rendered "undefined"`);
    assert.doesNotMatch(html, /\*\*/, `${file}: unrendered bold markers`);
    assert.match(html, /<h1>/, `${file}: no <h1>`);
  }
  // the API guide specifically exercises tables + fenced code
  const guide = marked.parse(fs.readFileSync(path.join(DOCS, 'CLIENT_API_GUIDE.md'), 'utf8'));
  assert.match(guide, /<table>/);
  assert.match(guide, /<pre><code/);
});

test('no living-doc HTML page loads a renderer from an external CDN', () => {
  const pages = ['product-overview-sales.html', 'client-api-guide.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(DOCS, page), 'utf8');
    const externalScripts = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)]
      .map((m) => m[1])
      .filter((src) => /^https?:\/\//i.test(src) || src.startsWith('//'));
    assert.deepEqual(externalScripts, [], `${page} must self-host its scripts, not load ${externalScripts.join(', ')}`);
  }
});
