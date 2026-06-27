// Emails received: mailer.recipientLog returns the mail-log entries addressed to
// a given address, handling comma-joined recipients and avoiding substring matches.

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');
const mailer = require('../server/mailer');

mailer.init({ db: h.db });
const insert = (recipient, subject, status, kind, entityId) => h.db.db
  .prepare('INSERT INTO mail_log (at, recipient, subject, status, detail, kind, entity_id) VALUES (?,?,?,?,?,?,?)')
  .run(new Date().toISOString(), recipient, subject, status, '', kind, entityId || '');

test('recipientLog returns emails to the user, newest first, incl. comma-joined sends', () => {
  insert('jane@x.com', 'Your weekly digest', 'sent', 'digest', '');
  insert('bob@x.com, jane@x.com', 'Campaign blast', 'sent', 'campaign', 'e1'); // joint send, includes jane
  insert('bob@x.com', 'Not for jane', 'sent', 'campaign', '');
  const out = mailer.recipientLog('jane@x.com');
  assert.equal(out.length, 2);
  assert.equal(out[0].subject, 'Campaign blast', 'newest first');
  assert.equal(out[0].kind, 'campaign');
  assert.equal(out[0].entityId, 'e1');
  assert.equal(out[1].subject, 'Your weekly digest');
});

test('recipientLog does not substring-match a longer address', () => {
  insert('jane@x.com.au', 'For the other Jane', 'sent', 'other', '');
  const subjects = mailer.recipientLog('jane@x.com').map((m) => m.subject);
  assert.ok(!subjects.includes('For the other Jane'), 'jane@x.com.au must not match jane@x.com');
});

test('recipientLog is empty for an unknown / blank address', () => {
  assert.deepEqual(mailer.recipientLog('nobody@nowhere.com'), []);
  assert.deepEqual(mailer.recipientLog(''), []);
});
