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
