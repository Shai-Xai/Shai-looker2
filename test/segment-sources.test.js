// Segment list sources (paste / uploaded CSV-Excel / Google Sheet) all funnel
// through parseContactLines. A header row must be ignored, people deduped by
// email-or-phone, and a Google Sheets link must resolve to its CSV export URL.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseContactLines, googleSheetCsvUrl } = require('../server/actions');

test('parseContactLines pulls email + phone + name per line, skips a header', () => {
  const rows = parseContactLines('name,email,phone\nJohn Smith,john@x.com,0821234567\nJane,jane@y.com,');
  assert.equal(rows.length, 2); // header row (no email/phone) dropped
  assert.deepEqual(rows[0], { email: 'john@x.com', phone: '0821234567', name: 'John Smith', emailOk: true, smsOk: true });
  assert.equal(rows[1].email, 'jane@y.com');
  assert.equal(rows[1].smsOk, false); // no phone
});

test('parseContactLines dedupes by email-or-phone and skips blank lines', () => {
  const rows = parseContactLines('a@x.com\n\na@x.com\nb@x.com');
  assert.equal(rows.length, 2);
});

test('googleSheetCsvUrl builds the CSV export URL with the gid', () => {
  assert.equal(
    googleSheetCsvUrl('https://docs.google.com/spreadsheets/d/ABC123_xy/edit#gid=42'),
    'https://docs.google.com/spreadsheets/d/ABC123_xy/export?format=csv&gid=42',
  );
  // Defaults to gid 0 when none is present.
  assert.match(googleSheetCsvUrl('https://docs.google.com/spreadsheets/d/ABC123/edit'), /gid=0$/);
  // Not a sheets link → empty.
  assert.equal(googleSheetCsvUrl('https://example.com/foo'), '');
});
