// The Owl auto-ingest decides whether an emailed settlement/invoice is safe to
// auto-PUBLISH to a client or must be held as a DRAFT for review. Those gates —
// the totals cross-check, the sender allowlist, and the type heuristic — are the
// safety boundary, so they're locked here as pure-function tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const owl = require('../server/owlIngest');

test('settlement cross-check: passes when value-due reconciles (turnover − commissions − advances)', () => {
  assert.equal(owl.crossCheckSettlement({ turnover: 1000000, commissionsTotal: 100000, valueDue: 850000, advances: { subtotal: 50000 } }), true);
  // advances absent → value-due = turnover − commissions
  assert.equal(owl.crossCheckSettlement({ turnover: 500000, commissionsTotal: 75000, valueDue: 425000 }), true);
  // within the rounding tolerance
  assert.equal(owl.crossCheckSettlement({ turnover: 500000, commissionsTotal: 75000, valueDue: 425000.4 }), true);
});

test('settlement cross-check: fails (→ draft) when it does not reconcile or figures are missing/zero', () => {
  assert.equal(owl.crossCheckSettlement({ turnover: 1000000, commissionsTotal: 100000, valueDue: 700000, advances: { subtotal: 50000 } }), false); // off by 150k
  assert.equal(owl.crossCheckSettlement({ turnover: 0, commissionsTotal: 0, valueDue: 0 }), false); // empty extraction
  assert.equal(owl.crossCheckSettlement({ commissionsTotal: 100000, valueDue: 850000 }), false); // no turnover
  assert.equal(owl.crossCheckSettlement(null), false);
});

test('invoice cross-check: passes when total ≈ subtotal + VAT, else fails', () => {
  assert.equal(owl.crossCheckInvoice({ subtotal: 10000, vatTotal: 1500, total: 11500 }), true);
  assert.equal(owl.crossCheckInvoice({ subtotal: 10000, vatTotal: 1500, total: 12000 }), false);
  assert.equal(owl.crossCheckInvoice({ subtotal: 0, vatTotal: 0, total: 0 }), false);
  assert.equal(owl.crossCheckInvoice({ total: 11500 }), false);
});

test('classify: confident from subject/filename, else "unknown"', () => {
  assert.equal(owl.classify('Your June settlement report', 'bushfire-settlement.pdf'), 'settlement');
  assert.equal(owl.classify('Tax invoice 10432', 'invoice.pdf'), 'invoice');
  assert.equal(owl.classify('Documents attached', 'file.pdf'), 'unknown'); // → AI fallback
  assert.equal(owl.classify('settlement + invoice bundle', 'x.pdf'), 'unknown'); // ambiguous both
});

test('detectSettlementType: ticketing/cashless + weekly/final defaults', () => {
  assert.deepEqual(owl.detectSettlementType('Weekly cashless settlement', 'x.pdf'), { kind: 'cashless', status: 'weekly' });
  assert.deepEqual(owl.detectSettlementType('Final settlement', 'x.pdf'), { kind: 'ticketing', status: 'final' });
  assert.deepEqual(owl.detectSettlementType('Settlement report', 'x.pdf'), { kind: 'ticketing', status: 'final' }); // defaults
});

test('senderMatches: only allowlisted emails or bare domains; fails closed on empty list', () => {
  assert.equal(owl.senderMatches('amanda@howler.co.za', ['howler.co.za']), true);     // domain match
  assert.equal(owl.senderMatches('Amanda@Howler.co.za', ['howler.co.za']), true);     // case-insensitive (caller lowercases list)
  assert.equal(owl.senderMatches('finance@howler.co.za', ['finance@howler.co.za']), true); // exact email
  assert.equal(owl.senderMatches('spammer@evil.com', ['howler.co.za']), false);       // wrong domain
  assert.equal(owl.senderMatches('amanda@howler.co.za', []), false);                  // empty allowlist → nothing trusted
  assert.equal(owl.senderMatches('', ['howler.co.za']), false);
});
