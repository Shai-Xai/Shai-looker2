// Email content blocks → email-safe HTML. Guards the rendered markup (inline
// styles, bulletproof button, escaping) and the plain-text fallback + image hosting.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const eb = require('../server/emailBlocks');

test('render: heading + text + button produce inline-styled, brand-accented HTML', () => {
  const { html } = eb.render([
    { type: 'heading', text: 'Big news', level: 1, align: 'center' },
    { type: 'text', text: 'Line one\nLine two with **bold**' },
    { type: 'button', text: 'Buy now', href: 'https://ex.com', align: 'center' },
  ], { brand: '#ff385c' });
  assert.match(html, /Big news/);
  assert.match(html, /text-align:center/);
  assert.match(html, /Line one<br>Line two with <strong>bold<\/strong>/);
  assert.match(html, /background:#ff385c/);            // button uses brand
  assert.match(html, /href="https:\/\/ex\.com"/);
  assert.match(html, /role="presentation"/);            // bulletproof table button
});

test('render: escapes HTML in author text (no injection)', () => {
  const { html } = eb.render([{ type: 'text', text: '<script>alert(1)</script>' }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('render: image supports link wrap + width; blank blocks are skipped', () => {
  const { html } = eb.render([
    { type: 'image', url: 'https://img/x.png', href: 'https://go', width: 'half', align: 'center' },
    { type: 'text', text: '' },            // empty → skipped
    { type: 'heading', text: '   ' },      // whitespace → skipped
  ]);
  assert.match(html, /<a href="https:\/\/go"[^>]*><img/);
  assert.match(html, /width:50%/);
  // only the image block rendered
  assert.equal((html.match(/margin-bottom/g) || []).length, 1);
});

test('render: divider + spacer render zero-content boxes', () => {
  const { html } = eb.render([{ type: 'divider' }, { type: 'spacer', size: 'lg' }]);
  assert.match(html, /border-top:1px solid/);
  assert.match(html, /height:40px/);
});

test('render: video is a linked thumbnail (email can’t embed); social lists links', () => {
  const { html } = eb.render([
    { type: 'video', thumb: 'https://t/th.jpg', href: 'https://youtu.be/x' },
    { type: 'social', items: [{ type: 'instagram', url: 'https://ig/h' }, { type: 'x', url: 'https://x/h' }, { type: 'nope' }] },
  ], { brand: '#000' });
  assert.match(html, /href="https:\/\/youtu\.be\/x"/);
  assert.match(html, /Watch the video/);
  assert.match(html, /Instagram/);
  assert.match(html, /href="https:\/\/x\/h"/);
});

test('render: plain-text fallback covers each block', () => {
  const { text } = eb.render([
    { type: 'heading', text: 'Hi **there**' },
    { type: 'button', text: 'Go', href: 'https://b' },
    { type: 'social', items: [{ type: 'website', url: 'https://w' }] },
  ]);
  assert.match(text, /Hi there/);          // markdown stripped
  assert.match(text, /Go: https:\/\/b/);
  assert.match(text, /Website: https:\/\/w/);
});

test('render: quote / list / menu / html blocks', () => {
  const { html } = eb.render([
    { type: 'quote', text: 'Great *event*' },
    { type: 'list', text: 'One\nTwo\nThree', ordered: true },
    { type: 'menu', links: [{ label: 'Home', url: 'https://h' }, { label: 'Buy', url: 'https://b' }] },
    { type: 'html', html: '<span class="raw">hi</span>' },
  ], { brand: '#f0f' });
  assert.match(html, /border-left:3px solid #f0f/);          // quote
  assert.match(html, /Great <em>event<\/em>/);
  assert.match(html, /<ol[^>]*><li[^>]*>One<\/li><li[^>]*>Two<\/li>/); // ordered list
  assert.match(html, /href="https:\/\/h"[^>]*>Home</);        // menu link
  assert.match(html, /<span class="raw">hi<\/span>/);         // raw html passthrough
});

test('render: 4 columns size their cells to fit across', () => {
  const cols = [[{ type: 'text', text: 'A' }], [{ type: 'text', text: 'B' }], [{ type: 'text', text: 'C' }], [{ type: 'text', text: 'D' }]];
  const { html } = eb.render([{ type: 'columns', cols }]);
  assert.match(html, /max-width:125px/); // floor(548/4)-12
  assert.equal((html.match(/inline-block/g) || []).length, 4);
});

test('render: columns render two fluid-hybrid cells; one column falls back to a single', () => {
  const two = eb.render([{ type: 'columns', cols: [
    [{ type: 'text', text: 'Left' }],
    [{ type: 'text', text: 'Right' }],
  ] }]);
  assert.match(two.html, /display:inline-block/);
  assert.match(two.html, /max-width:262px/);
  assert.match(two.html, /Left/);
  assert.match(two.html, /Right/);
  assert.match(two.text, /Left\n\nRight/);
  // A column that resolves to nothing → the other column renders full-width (no cell wrap).
  const one = eb.render([{ type: 'columns', cols: [[{ type: 'text', text: 'Solo' }], []] }]);
  assert.match(one.html, /Solo/);
  assert.doesNotMatch(one.html, /inline-block/);
});

test('cleanBlocks: keeps columns at top level, cleans children, forbids nested columns', () => {
  const cleaned = eb.cleanBlocks([
    { type: 'columns', cols: [
      [{ type: 'text', text: 'ok' }, { type: 'columns', cols: [[], []] }], // nested columns dropped
      [{ type: 'button', text: 'Go', href: 'https://x' }],
    ] },
  ]);
  assert.equal(cleaned[0].type, 'columns');
  assert.equal(cleaned[0].cols[0].length, 1);          // nested-columns child removed
  assert.equal(cleaned[0].cols[0][0].type, 'text');
  assert.equal(cleaned[0].cols[1][0].type, 'button');
});

test('flattenBlocks: yields column children so their images are findable by id', () => {
  const flat = eb.flattenBlocks([
    { id: 'top', type: 'text', text: 'x' },
    { id: 'col', type: 'columns', cols: [[{ id: 'c1', type: 'image', url: 'u' }], [{ id: 'c2', type: 'text' }]] },
  ]);
  assert.deepEqual(flat.map((b) => b.id), ['top', 'col', 'c1', 'c2']);
});

test('hostImages: recurses into column children', () => {
  const out = eb.hostImages([{ id: 'col', type: 'columns', cols: [[{ id: 'c1', type: 'image', url: 'data:image/png;base64,AAA' }], []] }], (b, key) => `https://host/${b.id}/${key}`);
  assert.equal(out[0].cols[0][0].url, 'https://host/c1/url');
});

test('hostImages: swaps only data-URL images/thumbs, leaves URLs + non-media alone', () => {
  const blocks = [
    { type: 'image', id: 'a', url: 'data:image/png;base64,AAA' },
    { type: 'image', id: 'b', url: 'https://cdn/x.png' },
    { type: 'video', id: 'c', thumb: 'data:image/png;base64,BBB' },
    { type: 'text', id: 'd', text: 'hi' },
  ];
  const out = eb.hostImages(blocks, (b, key) => `https://host/${b.id}/${key}`);
  assert.equal(out[0].url, 'https://host/a/url');
  assert.equal(out[1].url, 'https://cdn/x.png'); // already a URL — untouched
  assert.equal(out[2].thumb, 'https://host/c/thumb');
  assert.equal(out[3].text, 'hi');
  assert.equal(blocks[0].url, 'data:image/png;base64,AAA'); // original not mutated
});
