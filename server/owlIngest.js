// Owl auto-ingest — settlements & invoices that arrive by "CC the Owl" email.
//
// Slice 2 of the settlements automation. When an inbound email reaches a client's
// Owl address with a PDF attachment, this module (triggered by os.js's onInbound
// hook) decides what to do:
//   trusted Howler sender + PDF  →  classify (settlement | invoice | other)
//                                →  extract (reuse insights.extractSettlement/Invoice)
//                                →  cross-check the totals
//                                →  reconciles  → AUTO-PUBLISH for the client
//                                   doesn't     → save a DRAFT (needs_review, hidden
//                                                 from the client) for a human to publish
//
// Disposable module: owns no tables (it writes through db.createSettlement /
// createDocument), no routes (the trigger is the os.js inbound hook + a tiny admin
// settings endpoint in index.js). Safe by default — does nothing unless the sender
// is on the allowlist and the kill-switch is on.

const PDF_RE = /\.pdf$/i;
const isPdf = (a) => /pdf/i.test(a.mime || '') || PDF_RE.test(a.name || '');

// ── pure helpers (exported for tests) ──────────────────────────────────────────

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
// Tolerance for rounding: the larger of R1 or 0.5% of the expected magnitude.
const within = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.005);

// A settlement reconciles when value-due ≈ turnover − commissions − advances.
// Advances sign conventions vary (some reports print the amount, some the
// deduction), so we accept either ±. If the core figures are missing or zero, or
// it doesn't reconcile, we fail closed → the report is drafted, not published.
function crossCheckSettlement(d) {
  const turnover = num(d?.turnover);
  const comm = num(d?.commissionsTotal);
  const due = num(d?.valueDue);
  if (![turnover, comm, due].every(Number.isFinite)) return false;
  if (turnover === 0) return false;
  const advRaw = num(d?.advances?.subtotal);
  const adv = Number.isFinite(advRaw) ? advRaw : 0;
  return within(due, turnover - comm - adv) || within(due, turnover - comm + adv);
}

// An invoice reconciles when total ≈ subtotal + VAT.
function crossCheckInvoice(d) {
  const sub = num(d?.subtotal);
  const vat = num(d?.vatTotal);
  const tot = num(d?.total);
  if (![sub, vat, tot].every(Number.isFinite)) return false;
  if (tot === 0) return false;
  return within(tot, sub + vat);
}

// Heuristic triage from the subject + filename. Returns a confident type, or
// 'unknown' (→ caller falls back to the AI classifier).
function classify(subject, name) {
  const s = `${subject || ''} ${name || ''}`.toLowerCase();
  const inv = /invoice/.test(s);
  const set = /settlement|reconciliation|recon\b|statement/.test(s);
  if (inv && !set) return 'invoice';
  if (set && !inv) return 'settlement';
  return 'unknown';
}

// Best-effort settlement kind/status from the subject + filename. These only set
// defaults — a human can correct them on a draft, and Howler controls the subject
// line on auto-published ones.
function detectSettlementType(subject, name) {
  const s = `${subject || ''} ${name || ''}`.toLowerCase();
  const kind = /cashless|bar\b|f&b|top.?up/.test(s) ? 'cashless' : 'ticketing';
  const status = /\bweekly\b|\binterim\b/.test(s) ? 'weekly' : 'final';
  return { kind, status };
}

// from-address matches an allowlist of emails or bare domains (lowercased).
function senderMatches(from, list) {
  const email = String(from || '').toLowerCase().trim();
  if (!email.includes('@') || !Array.isArray(list) || !list.length) return false;
  const domain = email.split('@')[1] || '';
  return list.some((x) => x && (x === email || x === domain));
}

// ── module ──────────────────────────────────────────────────────────────────

function mount({ db, insights, anthropicKeyForEntity }) {
  const enabled = () => db.getSetting('owl_ingest_enabled', '1') !== '0';
  const allowlist = () => String(db.getSetting('settlement_ingest_senders', 'howler.co.za'))
    .split(/[\s,;]+/).map((x) => x.toLowerCase().trim().replace(/^@/, '')).filter(Boolean);

  // Triggered (fire-and-forget) by os.js after an inbound email with attachments
  // is stored. Never throws back into the webhook — failures are logged per file.
  async function handle({ entityId, from, subject, attachments, getAttachmentBuffer }) {
    if (!enabled()) return;
    const pdfs = (attachments || []).filter(isPdf);
    if (!entityId || !pdfs.length) return;
    if (!senderMatches(from, allowlist())) {
      console.log(`[owl-ingest] skip — sender ${from} not on the allowlist (left ${pdfs.length} PDF(s) in the inbox)`);
      return;
    }
    const apiKey = anthropicKeyForEntity(entityId);
    if (!insights.isConfigured(apiKey)) {
      console.log('[owl-ingest] skip — no Anthropic key for entity', entityId);
      return;
    }
    for (const att of pdfs) {
      try {
        if (db.settlementExistsForSource(att.id) || db.documentExistsForSource(att.id)) continue; // already ingested
        const blob = getAttachmentBuffer(att.id);
        if (!blob || !blob.buf?.length) continue;
        const pdfBase64 = blob.buf.toString('base64');

        let type = classify(subject, att.name);
        if (type === 'unknown') type = await insights.classifyDocument({ pdfBase64, apiKey }).catch(() => 'other');

        if (type === 'settlement') await ingestSettlement({ entityId, subject, att, pdfBase64, apiKey });
        else if (type === 'invoice') await ingestInvoice({ entityId, subject, att, pdfBase64, apiKey });
        else console.log(`[owl-ingest] "${att.name}" classified ${type} — left in the inbox, not ingested`);
      } catch (e) {
        console.error(`[owl-ingest] failed on "${att.name}":`, e.message);
      }
    }
  }

  async function ingestSettlement({ entityId, subject, att, pdfBase64, apiKey }) {
    const data = await insights.extractSettlement({ pdfBase64, apiKey });
    const reconciles = crossCheckSettlement(data);
    const { kind, status } = detectSettlementType(subject, att.name);
    const s = db.createSettlement({
      entityId,
      title: data?.meta?.eventName || subject || 'Settlement report',
      status, kind,
      settlementDate: data?.meta?.settlementDate || '',
      data,
      file: pdfBase64, fileName: att.name || 'settlement.pdf', fileType: 'application/pdf',
      source: 'email', sourceRef: att.id, needsReview: reconciles ? 0 : 1,
    });
    console.log(`[owl-ingest] settlement ${reconciles ? 'PUBLISHED' : 'DRAFTED (cross-check failed — needs review)'}: ${s.title} (entity ${entityId})`);
    return s;
  }

  async function ingestInvoice({ entityId, subject, att, pdfBase64, apiKey }) {
    const data = await insights.extractInvoice({ pdfBase64, apiKey });
    const reconciles = crossCheckInvoice(data);
    const title = data?.meta?.invoiceNumber ? `Invoice ${data.meta.invoiceNumber}` : (att.name || 'Invoice');
    const doc = db.createDocument({
      entityId,
      eventName: data?.meta?.eventName || '',
      title, category: 'invoice',
      data,
      file: pdfBase64, fileName: att.name || 'invoice.pdf', fileType: 'application/pdf',
      source: 'email', sourceRef: att.id, needsReview: reconciles ? 0 : 1,
    });
    console.log(`[owl-ingest] invoice ${reconciles ? 'PUBLISHED' : 'DRAFTED (cross-check failed — needs review)'}: ${title} (entity ${entityId})`);
    return doc;
  }

  return { handle };
}

module.exports = { mount, crossCheckSettlement, crossCheckInvoice, classify, detectSettlementType, senderMatches, within };
