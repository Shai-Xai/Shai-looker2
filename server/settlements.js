// ─── Settlements & documents ──────────────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the /api/settlements, /api/documents,
// /api/my/{settlements,documents} and /api/admin/{settlements,documents,owl-ingest}
// routes. Mounted from index.js with injected deps. Remove that one line +
// this file to uninstall.
//
// Event settlement reports: an admin uploads a PDF; Claude extracts it into
// structured JSON; the client gets an interactive report scoped to their entity.
// Documents are plain per-event file storage (invoices etc.), no extraction.
//
// NOTE: PDF bodies can be large, so the admin write routes parse their OWN body
// at a higher limit (settlementJson, 40mb). For that to take effect, index.js's
// GLOBAL json parser must SKIP these paths — see `parsesOwnBody` in index.js,
// which still lists /api/admin/settlements* and /api/admin/documents*.

const { serverError } = require('./http'); // sanitized 500s: logs full detail, client gets a generic message
const express = require('express');
const fs = require('fs');
const path = require('path');

// Large-body parser for the admin upload/extract routes (PDF base64).
const settlementJson = express.json({ limit: '40mb' });

// Can this user open this settlement? Admin: any. Client: must belong to one of
// their entities (and the settlement must be published, not an Owl review draft).
function canAccessSettlement(user, s) {
  if (!s) return false;
  if (user.role === 'admin') return true;
  if (s.needsReview) return false; // Owl-drafted (failed cross-check) — hidden until a human publishes
  return !!s.entityId && (user.entityIds || []).includes(s.entityId);
}

function mount(app, { db, auth, insights, anthropicKey }) {
  // Client list: settlements for the user's entities (admin sees all). Admins also
  // see Owl-drafted ones (needs_review) so they can review/publish; clients don't.
  app.get('/api/my/settlements', auth.requireAuth, (req, res) => {
    const list = req.user.role === 'admin' ? db.listSettlements({ includeDrafts: true }) : db.listSettlements({ entityIds: req.user.entityIds || [] });
    res.json(list);
  });

  app.get('/api/settlements/:id', auth.requireAuth, (req, res) => {
    const s = db.getSettlement(req.params.id);
    if (!s) return res.status(404).json({ error: 'Settlement not found' });
    if (!canAccessSettlement(req.user, s)) return res.status(403).json({ error: 'Not allowed' });
    res.json(s);
  });

  // Save notes (user annotations) on a settlement. Writable by anyone who can
  // view it — admin or the assigned client — since notes are collaborative.
  // The client sends the full notes array; we stamp author + timestamp.
  app.put('/api/settlements/:id/notes', auth.requireAuth, (req, res) => {
    const s = db.getSettlement(req.params.id);
    if (!s) return res.status(404).json({ error: 'Settlement not found' });
    if (!canAccessSettlement(req.user, s)) return res.status(403).json({ error: 'Not allowed' });
    const incoming = Array.isArray(req.body?.notes) ? req.body.notes : [];
    const clean = incoming.slice(0, 500).map((n) => ({
      id: String(n.id || '').slice(0, 64) || Math.random().toString(36).slice(2),
      section: String(n.section || 'general').slice(0, 64),
      sectionLabel: String(n.sectionLabel || '').slice(0, 120),
      text: String(n.text || '').slice(0, 4000),
      author: String(n.author || req.user.email || '').slice(0, 160),
      at: n.at || new Date().toISOString(),
    })).filter((n) => n.text.trim());
    const updated = db.setSettlementNotes(req.params.id, clean);
    res.json({ notes: updated.notes });
  });

  // Download the original PDF.
  app.get('/api/settlements/:id/file', auth.requireAuth, (req, res) => {
    const s = db.getSettlement(req.params.id);
    if (!s) return res.status(404).json({ error: 'Settlement not found' });
    if (!canAccessSettlement(req.user, s)) return res.status(403).json({ error: 'Not allowed' });
    const f = db.getSettlementFile(req.params.id);
    if (!f) return res.status(404).json({ error: 'No file attached' });
    res.setHeader('Content-Type', f.fileType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(f.fileName || 'settlement.pdf').replace(/"/g, '')}"`);
    res.send(Buffer.from(f.file, 'base64'));
  });

  // Admin: list all (with entity names for the management table).
  app.get('/api/admin/settlements', auth.requireAdmin, (_req, res) => {
    res.json(db.listSettlements({ includeDrafts: true }).map((s) => ({ ...s, entityName: s.entityId ? (db.getEntity(s.entityId)?.name || '') : '' })));
  });

  // Owl auto-ingest config: kill-switch + the trusted-sender allowlist (emails or
  // bare domains) that may trigger settlement/invoice auto-publish from email.
  app.get('/api/admin/owl-ingest', auth.requireAdmin, (_req, res) => {
    res.json({
      enabled: db.getSetting('owl_ingest_enabled', '1') !== '0',
      senders: db.getSetting('settlement_ingest_senders', 'howler.co.za'),
    });
  });
  app.put('/api/admin/owl-ingest', auth.requireAdmin, (req, res) => {
    if (req.body?.enabled !== undefined) db.setSetting('owl_ingest_enabled', req.body.enabled ? '1' : '0');
    if (req.body?.senders !== undefined) db.setSetting('settlement_ingest_senders', String(req.body.senders || '').slice(0, 2000));
    res.json({
      enabled: db.getSetting('owl_ingest_enabled', '1') !== '0',
      senders: db.getSetting('settlement_ingest_senders', 'howler.co.za'),
    });
  });

  // ─── Event documents (invoices etc.) ───────────────────────────────────────────
  // Plain file storage per client/event — uploaded by admins, downloadable by the
  // assigned client. No extraction.
  app.get('/api/my/documents', auth.requireAuth, (req, res) => {
    const list = req.user.role === 'admin' ? db.listDocuments({ includeDrafts: true }) : db.listDocuments({ entityIds: req.user.entityIds || [] });
    res.json(list);
  });
  app.get('/api/documents/:id', auth.requireAuth, (req, res) => {
    const doc = db.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const allowed = req.user.role === 'admin' || (!doc.needsReview && doc.entityId && (req.user.entityIds || []).includes(doc.entityId));
    if (!allowed) return res.status(403).json({ error: 'Not allowed' });
    res.json({ ...doc, entityName: doc.entityId ? (db.getEntity(doc.entityId)?.name || '') : '' });
  });
  app.get('/api/documents/:id/file', auth.requireAuth, (req, res) => {
    const doc = db.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    const allowed = req.user.role === 'admin' || (!doc.needsReview && doc.entityId && (req.user.entityIds || []).includes(doc.entityId));
    if (!allowed) return res.status(403).json({ error: 'Not allowed' });
    const f = db.getDocumentFile(req.params.id);
    if (!f) return res.status(404).json({ error: 'No file attached' });
    res.setHeader('Content-Type', f.fileType || 'application/octet-stream');
    // inline=1 lets the browser render it in the viewer; otherwise force download.
    const disp = req.query.inline ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disp}; filename="${(f.fileName || 'document').replace(/"/g, '')}"`);
    res.send(Buffer.from(f.file, 'base64'));
  });
  app.get('/api/admin/documents', auth.requireAdmin, (req, res) => {
    res.json(db.listDocuments({ includeDrafts: true, ...(req.query.entityId ? { entityId: req.query.entityId } : {}) }));
  });
  app.post('/api/admin/documents', auth.requireAdmin, settlementJson, (req, res) => {
    const { entityId, eventName, title, category, data, fileBase64, fileName, fileType } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });
    res.status(201).json(db.createDocument({ entityId, eventName, title, category, data: data || {}, file: fileBase64, fileName: fileName || '', fileType: fileType || '' }));
  });
  // AI-extract an invoice PDF into structured JSON (same ndjson progress stream
  // as the settlement extraction). Nothing saved — the admin reviews & publishes.
  app.post('/api/admin/documents/extract', auth.requireAdmin, settlementJson, async (req, res) => {
    const { fileBase64 } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });
    const apiKey = anthropicKey();
    if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI extraction needs an Anthropic API key (Admin → Integrations).' });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');
    send({ type: 'progress', stage: 'reading', chars: 0, rows: 0 });
    try {
      const data = await insights.extractInvoice({
        pdfBase64: fileBase64, apiKey,
        onProgress: (p) => send({ type: 'progress', stage: 'extracting', ...p }),
      });
      send({ type: 'done', data });
    } catch (err) {
      console.error('[POST /api/admin/documents/extract]', err.message);
      send({ type: 'error', error: err.message });
    }
    res.end();
  });
  app.put('/api/admin/documents/:id', auth.requireAdmin, settlementJson, (req, res) => {
    const doc = db.updateDocument(req.params.id, req.body || {});
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  });
  app.delete('/api/admin/documents/:id', auth.requireAdmin, (req, res) => {
    res.status(db.deleteDocument(req.params.id) ? 204 : 404).end();
  });

  // Admin: AI-extract an uploaded settlement PDF into the structured JSON draft.
  // Streams progress as newline-delimited JSON ({type:'progress'|'done'|'error'})
  // so the admin sees live feedback — and so bytes keep flowing through any
  // proxy during the long extraction. Nothing is saved; the admin reviews, then
  // publishes via POST /api/admin/settlements.
  app.post('/api/admin/settlements/extract', auth.requireAdmin, settlementJson, async (req, res) => {
    const { fileBase64, fileType } = req.body || {};
    if (!fileBase64) return res.status(400).json({ error: 'fileBase64 is required' });
    if (fileType && fileType !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files are supported for now' });
    const apiKey = anthropicKey();
    if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI extraction needs an Anthropic API key (Admin → Integrations).' });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');
    send({ type: 'progress', stage: 'reading', chars: 0, rows: 0 });
    try {
      const data = await insights.extractSettlement({
        pdfBase64: fileBase64, apiKey,
        onProgress: (p) => send({ type: 'progress', stage: 'extracting', ...p }),
      });
      send({ type: 'done', data });
    } catch (err) {
      console.error('[POST /api/admin/settlements/extract]', err.message);
      send({ type: 'error', error: err.message });
    }
    res.end();
  });

  // Admin: publish a settlement (extracted data + original file + assignment).
  app.post('/api/admin/settlements', auth.requireAdmin, settlementJson, (req, res) => {
    const { entityId, title, status, settlementDate, data, fileBase64, fileName, fileType } = req.body || {};
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'data is required' });
    const s = db.createSettlement({ entityId, title, status, settlementDate, data, file: fileBase64 || '', fileName: fileName || '', fileType: fileType || '' });
    res.status(201).json(s);
  });

  // Admin: load the bundled example report (MTN Bushfire) to demo the feature.
  app.post('/api/admin/settlements/example', auth.requireAdmin, (_req, res) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'settlement-example.json'), 'utf8'));
      const s = db.createSettlement({ entityId: null, title: data.meta.eventName, status: 'final', settlementDate: data.meta.settlementDate, data });
      res.status(201).json(s);
    } catch (err) {
      serverError(res, err);
    }
  });

  app.put('/api/admin/settlements/:id', auth.requireAdmin, settlementJson, (req, res) => {
    const s = db.updateSettlement(req.params.id, req.body || {});
    if (!s) return res.status(404).json({ error: 'Settlement not found' });
    res.json(s);
  });

  app.delete('/api/admin/settlements/:id', auth.requireAdmin, (req, res) => {
    res.status(db.deleteSettlement(req.params.id) ? 204 : 404).end();
  });

  console.log('[settlements] settlements & documents module mounted');
  return { canAccessSettlement };
}

module.exports = { mount, canAccessSettlement };
