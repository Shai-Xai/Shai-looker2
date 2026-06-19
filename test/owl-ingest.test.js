// The Owl auto-ingest decides whether an emailed settlement/invoice is safe to
// auto-PUBLISH to a client or must be held as a DRAFT for review. Those gates —
// the totals cross-check, the sender allowlist, and the type heuristic — are the
// safety boundary, so they're locked here as pure-function tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const owl = require('../server/owlIngest');

test('settlement cross-check: passes when itemised sales sum to turnover (value due taken as stated)', () => {
  // Real shape (Beats In The Bush): 7 sales rows totalling turnover, but value due
  // is far HIGHER because R114k of withheld fees were released at event-end. The
  // payout waterfall isn't reconciled — only the sales→turnover extraction is.
  assert.equal(owl.crossCheckSettlement({ turnover: 267484.52, valueDue: 369517.52, sales: [{ subtotal: { total: 267484.52 } }] }), true);
  // Multiple sales sections summing to turnover (value due below turnover is also fine).
  assert.equal(owl.crossCheckSettlement({ turnover: 300000, valueDue: 250000, sales: [{ subtotal: { total: 200000 } }, { subtotal: { total: 100000 } }] }), true);
  // Within the rounding tolerance.
  assert.equal(owl.crossCheckSettlement({ turnover: 500000, valueDue: 425000, sales: [{ subtotal: { total: 500000.4 } }] }), true);
  // No itemised sales to verify against → accept on the headline figures alone.
  assert.equal(owl.crossCheckSettlement({ turnover: 100000, valueDue: 95000 }), true);
});

test('settlement cross-check: fails (→ draft) when sales do not sum to turnover, or headline figures are missing/zero', () => {
  assert.equal(owl.crossCheckSettlement({ turnover: 300000, valueDue: 250000, sales: [{ subtotal: { total: 267484.52 } }] }), false); // mis-read line item
  assert.equal(owl.crossCheckSettlement({ turnover: 0, valueDue: 0 }), false);            // empty extraction
  assert.equal(owl.crossCheckSettlement({ valueDue: 369517.52 }), false);                 // no turnover
  assert.equal(owl.crossCheckSettlement({ turnover: 267484.52, valueDue: 0 }), false);    // no value due
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
