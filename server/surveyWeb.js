// ─── Survey email/web channel: hosted survey pages + personalised links ─────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `survey_links` table and the
// fan-facing survey WEB surface. Mounted from index.js with the surveys core
// injected ({ db, auth, rateLimit, mailer, surveys }) — surveys and responses
// live in server/surveys.js's tables; this module only adds ways IN:
//
//   • GET  /s/:token                 (PUBLIC) — the hosted survey page. A
//     PERSONAL token knows the fan (email + ticket type, minted per recipient,
//     unguessable); a SHARE token is anonymous (visitor id from localStorage).
//   • POST /api/s/:token/responses   (PUBLIC) — submit; same validation as the
//     app channel, respondent identity comes from the LINK (never the browser),
//     channel recorded as 'email' (personal) or 'web' (share).
//   • POST /api/my/surveys/:id/email (auth)  — mint personal links for pasted
//     recipients and send branded emails via mailer (suppression-aware).
//   • POST /api/my/surveys/:id/share-link · GET /api/my/surveys/:id/links.
//
// Access rules mirror the app surface exactly: live-window only, per-client
// engage.surveys flag, surveys_enabled kill switch, rate limits, size caps.
// TO REMOVE: delete this file + its mount line, drop survey_links.

const crypto = require('crypto');
const { asyncHandler } = require('./http');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function mount(app, { db, auth, rateLimit, mailer, surveys, getSegmentsApi = () => null }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS survey_links (
      token          TEXT PRIMARY KEY,
      survey_id      TEXT NOT NULL,
      email          TEXT NOT NULL DEFAULT '',
      display_name   TEXT NOT NULL DEFAULT '',
      ticket_type    TEXT NOT NULL DEFAULT '',
      ticket_type_id TEXT NOT NULL DEFAULT '',
      source         TEXT NOT NULL DEFAULT 'manual',
      email_status   TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      opened_at      TEXT,
      responded_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_survey_links_survey ON survey_links(survey_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_links_recipient ON survey_links(survey_id, email) WHERE email != '';
  `);

  const nowIso = () => new Date().toISOString();
  const newToken = () => `svl_${crypto.randomBytes(12).toString('base64url')}`;
  const linkUrl = (t) => `${mailer.baseUrl()}/s/${t}`;
  const getLink = (t) => sql.prepare('SELECT * FROM survey_links WHERE token=?').get(String(t || '').slice(0, 60));

  // Resolve a token to an ANSWERABLE survey; encodes the public-surface rules.
  // Returns { link, row } or { status, error } for the page/API to render.
  function resolveToken(token) {
    if (!surveys.enabled()) return { status: 404, error: 'Survey not found' };
    const link = getLink(token);
    const row = link && surveys.getSurvey(link.survey_id);
    if (!link || !row || row.status === 'draft' || !surveys.flagOn(row.entity_id)) return { status: 404, error: 'Survey not found' };
    const state = surveys.effectiveState(row);
    if (state === 'closed') return { status: 409, error: 'This survey has closed', link, row };
    if (state === 'scheduled') return { status: 409, error: 'This survey is not open yet', link, row };
    return { link, row };
  }

  // Respondent identity ALWAYS comes from the link (or the anon visitor id) —
  // never from browser-supplied identity fields.
  const respondentKey = (link, visitorId) => (link.email ? `email:${link.email.toLowerCase()}` : `web_${str(visitorId, 60).replace(/[^a-zA-Z0-9_-]/g, '') || crypto.randomBytes(6).toString('base64url')}`);

  // ── PUBLIC: the hosted survey page ───────────────────────────────────────────
  const pageLimit = rateLimit({ windowMs: 60_000, max: 60, by: 'ip', scope: 'survey_web_page' });
  const submitLimit = rateLimit({ windowMs: 10 * 60_000, max: 20, by: 'ip', scope: 'survey_web_submit' });

  // The page is fully self-contained (inline CSS/JS, no external code), so it
  // carries its own tight CSP instead of the app shell's ('self'-only) one:
  // nothing loads from anywhere except images, and it may only talk to Pulse.
  const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src https: data:; base-uri 'none'; form-action 'self'";

  app.get('/s/:token', pageLimit, (req, res) => {
    res.set('Content-Security-Policy', PAGE_CSP);
    const r = resolveToken(req.params.token);
    if (r.status === 404) return res.status(404).send(shellPage('Survey not found', 'This link is no longer valid.', '#FF385C'));
    const b = mailer.resolveBranding(r.row ? r.row.entity_id : '');
    if (r.status) return res.status(r.status).send(shellPage(r.row ? r.row.title : 'Survey', r.error === 'This survey has closed' ? 'This survey has closed — thanks for your interest!' : r.error, b.brandColor));
    sql.prepare('UPDATE survey_links SET opened_at=COALESCE(opened_at, ?) WHERE token=?').run(nowIso(), r.link.token);
    res.send(surveyPage(r.row, r.link, b));
  });

  app.post('/api/s/:token/responses', submitLimit, (req, res) => {
    const r = resolveToken(req.params.token);
    if (r.status) return res.status(r.status).json({ error: r.error });
    const { link, row } = r;
    const body = req.body || {};
    // Rebuild the respondent server-side from the link — the browser only
    // supplies answers (and, for share links, its random visitor id).
    const clean = surveys.validateAnswers(row, {
      answers: body.answers,
      respondent: {
        howlerUserId: respondentKey(link, body.visitorId),
        displayName: link.display_name || '',
        email: link.email || '',
        ticketType: link.ticket_type || '',
        ticketTypeId: link.ticket_type_id || '',
      },
      client: { platform: 'web', appVersion: '' },
    });
    if (clean.ticketType && !surveys.audienceMatches(row, clean.ticketType)) {
      return res.status(400).json({ error: `This survey is for ${surveys.audienceOf(row).join(' / ')} ticket holders` });
    }
    const id = surveys.saveResponse(row, clean, link.email ? 'email' : 'web');
    sql.prepare('UPDATE survey_links SET responded_at=? WHERE token=?').run(nowIso(), link.token);
    res.json({ ok: true, responseId: id });
  });

  // ── Management: mint links + send emails (my + admin, same handlers) ─────────
  function guard(req, res, perm) {
    const row = surveys.getSurvey(req.params.id || req.params.surveyId);
    if (!row) { res.status(404).json({ error: 'Survey not found' }); return null; }
    const user = req.user;
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return null; }
    if (user.role !== 'admin' && (!(user.entityIds || []).includes(row.entity_id) || !auth.hasPermission(user, row.entity_id, perm))) {
      res.status(403).json({ error: 'Not allowed' });
      return null;
    }
    return row;
  }

  // Recipients can come from an Engage SEGMENT (always-current audience,
  // resolved via the same engine campaigns use — consent-aware) or an explicit
  // list (pasted / CSV-parsed in the UI). Segment resolution respects emailOk.
  async function recipientsFromSegment(row, segmentId, user) {
    const segs = getSegmentsApi();
    if (!segs || !segs.resolveSegment) throw new Error('Segments are not available');
    const resolved = await segs.resolveSegment(row.entity_id, String(segmentId), user);
    if (!resolved) return null;
    return (resolved.list || [])
      .filter((r) => r.email && r.emailOk !== false)
      .map((r) => ({ email: r.email, displayName: r.name || '', ticketType: r.ticket || r.ticketType || '' }));
  }

  async function emailHandler(req, res) {
    const row = guard(req, res, 'campaigns.approve'); if (!row) return;
    if (row.status !== 'live') return res.status(409).json({ error: 'Publish the survey before emailing it out' });
    const body = req.body || {};
    let raw;
    if (body.segmentId) {
      let fromSeg;
      try { fromSeg = await recipientsFromSegment(row, body.segmentId, req.user); }
      catch (e) { return res.status(502).json({ error: e.message || 'Could not resolve the segment — try again.' }); }
      if (fromSeg === null) return res.status(404).json({ error: 'Segment not found' });
      raw = fromSeg.slice(0, 2000);
      if (body.preview) {
        return res.json({ ok: true, preview: true, count: raw.length, sample: raw.slice(0, 5).map((r) => r.email.replace(/^(..).*(@.*)$/, '$1…$2')) });
      }
      if (!raw.length) return res.status(400).json({ error: 'That segment has no emailable members (no addresses, or no email consent)' });
    } else {
      raw = Array.isArray(body.recipients) ? body.recipients.slice(0, 500) : [];
    }
    if (!raw.length) return res.status(400).json({ error: 'recipients required — [{ email, displayName?, ticketType? }] or a segmentId' });
    const subject = str(body.subject, 150) || `How was ${row.event_name || 'the event'}?`;
    const message = str(body.message, 1000) || row.description || 'It only takes 2 minutes — tell us how it went.';
    const doSend = body.send !== false;

    // Phase 1 — validate + mint links (fast, DB-only). Idempotent per recipient.
    const seen = new Set();
    const skippedPre = [];
    const toSend = []; // { email, link }
    for (const rec of raw) {
      const email = str(rec && rec.email, 200).toLowerCase();
      if (!emailOk(email)) { skippedPre.push({ email: email || '(blank)', status: 'skipped', reason: 'invalid email' }); continue; }
      if (seen.has(email)) continue;
      seen.add(email);
      const ticketType = str(rec.ticketType, 80);
      if (ticketType && !surveys.audienceMatches(row, ticketType)) {
        skippedPre.push({ email, status: 'skipped', reason: `survey targets ${surveys.audienceOf(row).join(' / ')}` });
        continue;
      }
      let link = sql.prepare('SELECT * FROM survey_links WHERE survey_id=? AND email=?').get(row.id, email);
      if (!link) {
        link = { token: newToken(), survey_id: row.id, email, display_name: str(rec.displayName, 200), ticket_type: ticketType, ticket_type_id: str(rec.ticketTypeId, 40), source: 'email', created_at: nowIso() };
        sql.prepare('INSERT INTO survey_links (token, survey_id, email, display_name, ticket_type, ticket_type_id, source, created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(link.token, link.survey_id, link.email, link.display_name, link.ticket_type, link.ticket_type_id, link.source, link.created_at);
      }
      toSend.push({ email, link });
    }

    // Phase 2 — send. One branded mail per link via mailer (suppression-aware).
    const sendOne = async ({ email, link }) => {
      let status = 'sent', reason = '';
      try {
        const b = mailer.resolveBranding(row.entity_id);
        const greeting = link.display_name ? `Hi ${link.display_name} — ` : '';
        const { html, text } = mailer.notificationEmail({
          entityId: row.entity_id,
          title: row.title,
          body: `${greeting}${message}`,
          ctaPath: `/s/${link.token}`,
          ctaText: 'Start the survey',
          preheader: message,
        });
        const sent = await mailer.send({ to: email, subject, html, text, fromName: b.senderName, kind: 'survey', entity: row.entity_id });
        if (!sent || !sent.ok) { status = 'skipped'; reason = (sent && sent.reason) || (sent && sent.error) || 'send failed'; }
      } catch (e) { status = 'skipped'; reason = e.message || 'send failed'; }
      sql.prepare('UPDATE survey_links SET email_status=? WHERE token=?').run(reason ? `${status}: ${reason}` : status, link.token);
      return { email, status, reason: reason || undefined, url: linkUrl(link.token) };
    };

    if (!doSend) {
      for (const t of toSend) sql.prepare("UPDATE survey_links SET email_status='link only' WHERE token=? AND email_status=''").run(t.link.token);
      return res.json({ ok: true, total: toSend.length + skippedPre.length, sent: 0, skipped: skippedPre, links: toSend.map((t) => ({ email: t.email, url: linkUrl(t.link.token), status: 'link only' })) });
    }
    if (toSend.length <= 100) {
      const results = [];
      for (const t of toSend) results.push(await sendOne(t));
      const sent = results.filter((x) => x.status === 'sent').length;
      const skipped = [...skippedPre, ...results.filter((x) => x.status === 'skipped')];
      return res.json({ ok: true, total: toSend.length + skippedPre.length, sent, skipped, links: results.map(({ email, url, status }) => ({ email, url, status })) });
    }
    // Big audience (a segment): answer NOW, deliver in the background. The
    // per-link email_status + the links endpoint's counters show live progress.
    res.json({ ok: true, queued: toSend.length, total: toSend.length + skippedPre.length, skipped: skippedPre, background: true });
    (async () => {
      for (const t of toSend) { try { await sendOne(t); } catch { /* recorded on the link */ } }
      console.log(`[surveys] background email send finished: ${toSend.length} recipients, survey ${row.id}`);
    })();
  }

  function shareLinkHandler(req, res) {
    const row = guard(req, res, 'campaigns.approve'); if (!row) return;
    let link = sql.prepare("SELECT * FROM survey_links WHERE survey_id=? AND source='share'").get(row.id);
    if (!link) {
      link = { token: newToken() };
      sql.prepare("INSERT INTO survey_links (token, survey_id, email, source, created_at) VALUES (?,?, '', 'share', ?)").run(link.token, row.id, nowIso());
    }
    res.json({ ok: true, url: linkUrl(link.token) });
  }

  function linksHandler(req, res) {
    const row = guard(req, res, 'campaigns.view'); if (!row) return;
    const rows = sql.prepare('SELECT * FROM survey_links WHERE survey_id=? ORDER BY created_at DESC').all(row.id);
    res.json({
      total: rows.length,
      responded: rows.filter((l) => l.responded_at).length,
      opened: rows.filter((l) => l.opened_at).length,
      sent: rows.filter((l) => l.email_status === 'sent').length,
      pending: rows.filter((l) => l.email === '' ? false : !l.email_status).length, // queued, not yet attempted
      links: rows.slice(0, 200).map((l) => ({ email: l.email, displayName: l.display_name, ticketType: l.ticket_type, source: l.source, status: l.email_status, opened: !!l.opened_at, responded: !!l.responded_at, url: linkUrl(l.token) })),
    });
  }

  app.post('/api/my/surveys/:id/email', asyncHandler(emailHandler));
  app.post('/api/my/surveys/:id/share-link', shareLinkHandler);
  app.get('/api/my/surveys/:id/links', linksHandler);
  app.post('/api/admin/entities/:entityId/surveys/:surveyId/email', asyncHandler(emailHandler));
  app.post('/api/admin/entities/:entityId/surveys/:surveyId/share-link', shareLinkHandler);
  app.get('/api/admin/entities/:entityId/surveys/:surveyId/links', linksHandler);

  // ── The hosted page (server-rendered, self-contained, mobile-first) ──────────
  function shellPage(title, message, brandColor) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
<div style="max-width:480px;margin:0 auto;padding:60px 20px;text-align:center;">
  <div style="background:#fff;border:1px solid #e8e8ec;border-radius:16px;padding:36px 24px;">
    <div style="font-size:34px;">🎪</div>
    <h1 style="font-size:20px;margin:12px 0 6px;color:#111;">${esc(title)}</h1>
    <p style="font-size:14px;color:#6e6e73;margin:0;">${esc(message)}</p>
  </div>
</div></body></html>`;
  }

  function surveyPage(row, link, b) {
    const survey = surveys.publicSurvey(row);
    const data = { survey, greeting: link.display_name || '', personal: !!link.email, ticketType: link.ticket_type || '' };
    const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const brand = /^#[0-9a-fA-F]{3,8}$/.test(b.brandColor || '') ? b.brandColor : '#FF385C';
    const brand2 = /^#[0-9a-fA-F]{3,8}$/.test(b.secondaryColor || '') ? b.secondaryColor : brand;
    const mark = b.logo && !b.logo.startsWith('data:') ? `<img src="${esc(b.logo)}" alt="${esc(b.wordmark)}" style="max-height:34px;max-width:180px;">` : `<div style="font-weight:800;font-size:15px;color:#fff;">${esc(b.wordmark || '')}</div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(row.title)}</title>
<style>
  :root{--brand:${brand};--brand2:${brand2}}
  *{box-sizing:border-box}body{margin:0;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
  .wrap{max-width:520px;margin:0 auto;padding:18px 14px 60px}
  .head{background:linear-gradient(135deg,var(--brand),var(--brand2));border-radius:16px;padding:20px 18px;color:#fff;margin-bottom:16px}
  .head .ev{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;opacity:.92}
  .head h1{font-size:22px;font-weight:800;margin:6px 0 4px;letter-spacing:-.01em}
  .head p{margin:0;font-size:13.5px;opacity:.94}
  .head .who{margin-top:10px;display:inline-block;font-size:11.5px;font-weight:650;background:rgba(255,255,255,.2);border-radius:99px;padding:4px 11px}
  .q{background:#fff;border:1px solid #e8e8ec;border-radius:14px;padding:16px;margin-bottom:12px}
  .q h2{font-size:15px;font-weight:650;margin:0 0 12px}.q h2 .req{color:var(--brand)}
  .stars{display:flex;gap:8px;font-size:34px;line-height:1;cursor:pointer;user-select:none}
  .stars span{color:#d8d8dc;transition:transform .1s}.stars span.on{color:#ffb340}.stars span:active{transform:scale(1.2)}
  .opt{display:flex;align-items:center;gap:10px;border:1.5px solid #e3e3e8;border-radius:11px;padding:12px;margin-bottom:8px;font-size:14px;cursor:pointer;background:#fff}
  .opt .mk{width:18px;height:18px;flex:none;border:2px solid #c7c7cc;border-radius:50%}.opt.ck .mk{border-radius:5px}
  .opt.on{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 6%,#fff)}
  .opt.on .mk{border-color:var(--brand)}.opt.on:not(.ck) .mk{box-shadow:inset 0 0 0 4px var(--brand)}.opt.ck.on .mk{background:var(--brand)}
  textarea{width:100%;min-height:80px;border:1.5px solid #e3e3e8;border-radius:11px;padding:11px;font-family:inherit;font-size:14px;resize:vertical}
  .send{display:block;width:100%;border:0;margin-top:6px;background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;font-size:15.5px;font-weight:700;border-radius:13px;padding:15px;cursor:pointer;font-family:inherit}
  .send:disabled{opacity:.6}
  .err{color:#d70015;font-size:13px;font-weight:600;margin:10px 2px;display:none}
  .brandbar{display:flex;justify-content:center;margin-bottom:14px}
  .done{background:#fff;border:1px solid #e8e8ec;border-radius:16px;padding:40px 22px;text-align:center;display:none}
  .done .big{font-size:40px}.done h2{font-size:19px;margin:10px 0 4px}.done p{color:#6e6e73;font-size:13.5px;margin:0}
  .foot{text-align:center;font-size:11px;color:#86868b;margin-top:18px}
</style></head><body><div class="wrap">
  <div class="head">
    <div class="brandbar" style="justify-content:flex-start;margin-bottom:12px">${mark}</div>
    <div class="ev">${esc(survey.eventName)}</div>
    <h1>${esc(survey.title)}</h1>
    ${survey.description ? `<p>${esc(survey.description)}</p>` : ''}
    <div id="who" class="who" style="display:none"></div>
  </div>
  <form id="f"></form>
  <p class="err" id="err"></p>
  <div class="done" id="done"><div class="big">🎉</div><h2>Thank you!</h2><p>Your feedback helps make the next one even better.</p></div>
  <p class="foot">Powered by Howler · your answers go to the event organiser</p>
</div>
<script>
const D=${json};
const S=D.survey, A={};
const f=document.getElementById('f');
if(D.greeting||D.ticketType){const w=document.getElementById('who');w.style.display='inline-block';w.textContent='\\u2713 '+(D.greeting?D.greeting:'You')+(D.ticketType?' \\u00b7 '+D.ticketType:'');}
let vid=null;
if(!D.personal){try{vid=localStorage.getItem('pulse_svy_uid')||(Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem('pulse_svy_uid',vid);}catch(e){vid=Math.random().toString(36).slice(2);}}
function el(t,c,h){const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;}
S.questions.forEach(q=>{
  const card=el('div','q');
  card.appendChild(el('h2','',escq(q.text)+(q.required?' <span class="req">\\u2605</span>':'')));
  if(q.type==='rating'){
    const st=el('div','stars');
    for(let n=1;n<=5;n++){const s=el('span','','\\u2605');s.onclick=()=>{A[q.id]={type:'rating',rating:n};[...st.children].forEach((x,i)=>x.classList.toggle('on',i<n));};st.appendChild(s);}
    card.appendChild(st);
  } else if(q.type==='single_choice'||q.type==='multiple_choice'){
    const multi=q.type==='multiple_choice';
    (q.options||[]).forEach((o,i)=>{
      const r=el('div','opt'+(multi?' ck':''));r.appendChild(el('span','mk'));r.appendChild(document.createTextNode(o));
      r.onclick=()=>{
        if(multi){const cur=A[q.id]&&A[q.id].selectedIndices||[];const has=cur.includes(i);const nxt=has?cur.filter(x=>x!==i):cur.concat([i]);A[q.id]=nxt.length?{type:'multiple_choice',selectedIndices:nxt}:undefined;r.classList.toggle('on');}
        else{A[q.id]={type:'single_choice',selectedIndex:i};[...card.querySelectorAll('.opt')].forEach((x,xi)=>x.classList.toggle('on',xi===i));}
      };
      card.appendChild(r);
    });
  } else {
    const t=document.createElement('textarea');t.maxLength=1000;t.placeholder='Type here\\u2026';
    t.oninput=()=>{A[q.id]=t.value.trim()?{type:'text',text:t.value.trim()}:undefined;};
    card.appendChild(t);
  }
  f.appendChild(card);
});
const btn=el('button','send','Send feedback');btn.type='button';f.appendChild(btn);
function escq(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
btn.onclick=async()=>{
  const err=document.getElementById('err');err.style.display='none';
  const missing=S.questions.filter(q=>q.required&&!A[q.id]);
  if(missing.length){err.textContent='Please answer: '+missing.map(q=>q.text).join(' \\u00b7 ');err.style.display='block';return;}
  const answers=S.questions.map(q=>A[q.id]?Object.assign({questionId:q.id},A[q.id]):null).filter(Boolean);
  btn.disabled=true;btn.textContent='Sending\\u2026';
  try{
    const r=await fetch(location.pathname.replace('/s/','/api/s/')+'/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers:answers,visitorId:vid})});
    const j=await r.json();
    if(!r.ok||!j.ok)throw new Error(j.error||'Something went wrong \\u2014 please try again.');
    f.style.display='none';document.getElementById('done').style.display='block';window.scrollTo(0,0);
  }catch(e){err.textContent=e.message;err.style.display='block';btn.disabled=false;btn.textContent='Send feedback';}
};
</script></body></html>`;
  }

  return { resolveToken };
}

module.exports = { mount };
