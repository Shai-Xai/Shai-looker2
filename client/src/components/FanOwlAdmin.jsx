import { useEffect, useMemo, useState } from 'react';
import { useIsMobile } from '../lib/useIsMobile.js';

// ─── Fan Owl config — dual-surface editor (docs/specs/FAN_OWL_SPEC.md §3B) ─────
// The same component serves Admin → client detail (scope="admin-client") and the
// client's own Settings (scope="my"), like MailTemplateEditor. It manages the
// three things the fan-facing widget grounds on: SITES (the embed key + domain
// allowlist + ribbon teaser), the CATALOGUE (tickets/add-ons with their
// Howler-supplied buy links — the Owl's only price facts), and KNOWLEDGE (the
// FAQs/policies the Owl may quote). Plus a read of the flywheel: funnel counts,
// interest topics / FAQ gaps, and captured (consented) fans.

const PAGE_TYPES = ['home', 'lineup', 'artist', 'tickets', 'attraction', 'venue', 'faq', 'other'];
const AVAILABILITY = ['', 'selling fast', 'last few', 'sold out'];
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', fontFamily: 'inherit', background: 'var(--card, #fff)', color: 'var(--text)' };
const small = { fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 4px' };
const btn = { padding: '8px 14px', borderRadius: 8, border: '1.5px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontSize: 12.5, cursor: 'pointer', minHeight: 36 };
const primaryBtn = { ...btn, background: 'var(--text)', color: 'var(--bg, #fff)', border: 0, fontWeight: 700 };
const card = { border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, marginTop: 10 };
const H = ({ children }) => <h3 style={{ fontSize: 14, fontWeight: 700, margin: '18px 0 2px' }}>{children}</h3>;

export default function FanOwlAdmin({ scope = 'admin-client', entityId }) {
  const isMobile = useIsMobile();
  const base = scope === 'my' ? `/api/my/fan-owl/${entityId}` : `/api/admin/entities/${entityId}/fan-owl`;
  const [cfg, setCfg] = useState(null);
  const [suites, setSuites] = useState([]);
  const [stats, setStats] = useState(null);
  const [leads, setLeads] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [ingestUrl, setIngestUrl] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [ingestNote, setIngestNote] = useState('');

  useEffect(() => {
    let on = true;
    fetch(base).then((r) => r.json()).then((c) => { if (on) setCfg(c); }).catch(() => {});
    fetch(`${base}/insights`).then((r) => r.json()).then((s) => { if (on) setStats(s); }).catch(() => {});
    const suitesUrl = scope === 'my' ? '/api/my/suites' : '/api/admin/suites';
    fetch(suitesUrl).then((r) => r.json()).then((rows) => {
      const list = Array.isArray(rows) ? rows : rows.suites || [];
      if (on) setSuites(list.filter((s) => scope === 'my' || s.entityId === entityId).map((s) => ({ id: s.id, name: s.name })));
    }).catch(() => {});
    return () => { on = false; };
  }, [base, scope, entityId]);

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setSite = (i, patch) => set({ sites: cfg.sites.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const setCat = (i, patch) => set({ catalogue: cfg.catalogue.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const setKnow = (i, patch) => set({ knowledge: cfg.knowledge.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  async function save() {
    setSaving(true);
    try {
      const r = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      if (r.ok) { setCfg(await r.json()); setSavedAt(Date.now()); }
    } finally { setSaving(false); }
  }

  const snippet = (siteKey) => `<script async src="${window.location.origin}/fan-owl.js" data-site-key="${siteKey}"></script>`;

  // "Read the website": crawl → AI suggestions merged into the UNSAVED editor
  // state (deduped) — the human reviews/edits and hits Save. Nothing auto-commits.
  async function ingest(siteIndex) {
    const url = ingestUrl.trim();
    if (!url) { setIngestNote('Enter the site URL first (https://…).'); return; }
    setIngesting(true); setIngestNote('Reading the site — this takes ~30–60s…');
    try {
      const r = await fetch(`${base}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: /^https?:\/\//i.test(url) ? url : `https://${url}` }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'The crawl failed — try again.');
      setCfg((c) => {
        const haveQ = new Set(c.knowledge.map((k) => (k.question || k.body).toLowerCase().trim()));
        const newKnow = (d.knowledge || []).filter((k) => !haveQ.has((k.question || k.body).toLowerCase().trim()));
        const sites = c.sites.map((s, j) => {
          if (j !== siteIndex) return s;
          const havePat = new Set((s.pages || []).map((p) => p.urlPattern.toLowerCase().trim()));
          const newPages = (d.pages || []).filter((p) => !havePat.has(p.urlPattern.toLowerCase().trim())).map((p) => ({ ...p, itemIds: [] }));
          return { ...s, pages: [...(s.pages || []), ...newPages] };
        });
        setIngestNote(`Read ${d.crawled.length} page${d.crawled.length === 1 ? '' : 's'} → suggested ${newKnow.length} knowledge entries + ${(d.pages || []).length} page mappings. Review below, edit freely, then Save.`);
        return { ...c, sites, knowledge: [...c.knowledge, ...newKnow] };
      });
    } catch (e) { setIngestNote(`⚠️ ${e.message}`); }
    finally { setIngesting(false); }
  }

  if (!cfg) return <p style={small}>Loading the Fan Owl config…</p>;
  return (
    <div style={{ marginTop: 14 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>🦉 Fan Owl — website booking guide</h2>
      <p style={small}>The Owl on the event's public website: it guides fans to the right ticket, answers from the knowledge base below, and hands out the buy links you supply. Nothing here is private — only publish what any fan may see.</p>

      <H>Sites</H>
      <p style={small}>One per website. Paste the embed snippet once, site-wide. Domains lock which websites may use the key (leave empty while testing).</p>
      {cfg.sites.map((s, i) => (
        <div key={s.id || i} style={card}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8 }}>
            <div>
              <div style={small}>Site name</div>
              <input style={input} value={s.name} onChange={(e) => setSite(i, { name: e.target.value })} placeholder="e.g. Retreat Yourself website" />
            </div>
            <div>
              <div style={small}>Event</div>
              <select style={input} value={s.suiteId || ''} onChange={(e) => setSite(i, { suiteId: e.target.value })}>
                <option value="">— whole client —</option>
                {suites.map((su) => <option key={su.id} value={su.id}>{su.name}</option>)}
              </select>
            </div>
            <div>
              <div style={small}>Allowed domains (comma-separated, e.g. ry.howler.co.za)</div>
              <input style={input} value={(s.domains || []).join(', ')} onChange={(e) => setSite(i, { domains: e.target.value.split(',').map((d) => d.trim()).filter(Boolean) })} />
            </div>
            <div>
              <div style={small}>Teaser (the ribbon line when no page mapping matches)</div>
              <input style={input} value={s.teaser} onChange={(e) => setSite(i, { teaser: e.target.value })} placeholder="e.g. Tickets are live — ask me anything" />
            </div>
            <div>
              <div style={small}>Brand colour (hex)</div>
              <input style={input} value={s.brandColor} onChange={(e) => setSite(i, { brandColor: e.target.value })} placeholder="#111111" />
            </div>
            <div>
              <div style={small}>Daily chat budget (messages/day, then the widget degrades to ribbon-only)</div>
              <input style={input} type="number" value={s.dailyBudget} onChange={(e) => setSite(i, { dailyBudget: e.target.value })} />
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '10px 0' }}>
            <input type="checkbox" checked={!!s.enabled} onChange={(e) => setSite(i, { enabled: e.target.checked })} style={{ width: 16, height: 16 }} />
            Enabled (fans can see the widget)
          </label>
          {s.siteKey && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{ fontSize: 11, background: 'var(--hairline)', padding: '6px 8px', borderRadius: 6, overflowX: 'auto', maxWidth: '100%' }}>{snippet(s.siteKey)}</code>
              <button type="button" style={btn} onClick={() => navigator.clipboard?.writeText(snippet(s.siteKey))}>Copy snippet</button>
              <a href={`/fan-owl-test?k=${s.siteKey}`} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', fontWeight: 700 }}>▶ Preview</a>
            </div>
          )}
          <H>🔮 Read the website</H>
          <p style={small}>Point the Owl at the event site — it reads the pages and SUGGESTS knowledge entries + page mappings below. Nothing goes live until you review and Save.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={{ ...input, flex: '1 1 220px', width: 'auto' }} value={ingestUrl} placeholder={`https://${(s.domains || [])[0] || 'your-event-site.com'}`} onChange={(e) => setIngestUrl(e.target.value)} />
            <button type="button" style={{ ...btn, fontWeight: 700 }} disabled={ingesting} onClick={() => ingest(i)}>{ingesting ? 'Reading…' : 'Read & suggest'}</button>
          </div>
          {ingestNote && <p style={{ ...small, marginTop: 6 }}>{ingestNote}</p>}
          <H>Page mappings</H>
          <p style={small}>When the page URL contains the pattern (use * as a wildcard), the ribbon + Owl lead with the ticked items. Longest match wins; unmatched pages get the whole catalogue.</p>
          {(s.pages || []).map((p, pi) => (
            <div key={p.id || pi} style={{ borderTop: '1px dashed var(--hairline)', padding: '8px 0' }}>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr auto', gap: 8 }}>
                <input style={input} value={p.urlPattern} placeholder="/artists/luna-x or /tickets*" onChange={(e) => setSite(i, { pages: s.pages.map((x, xi) => (xi === pi ? { ...x, urlPattern: e.target.value } : x)) })} />
                <select style={input} value={p.pageType} onChange={(e) => setSite(i, { pages: s.pages.map((x, xi) => (xi === pi ? { ...x, pageType: e.target.value } : x)) })}>
                  {PAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <button type="button" style={btn} onClick={() => setSite(i, { pages: s.pages.filter((_, xi) => xi !== pi) })}>Remove</button>
              </div>
              <input style={{ ...input, marginTop: 6 }} value={p.note} placeholder="Note for the Owl (e.g. Luna X plays Saturday night)" onChange={(e) => setSite(i, { pages: s.pages.map((x, xi) => (xi === pi ? { ...x, note: e.target.value } : x)) })} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {cfg.catalogue.map((c) => {
                  const on = (p.itemIds || []).includes(c.id);
                  return (
                    <button key={c.id} type="button"
                      style={{ ...btn, minHeight: 32, padding: '5px 10px', fontSize: 12, background: on ? 'var(--text)' : 'transparent', color: on ? 'var(--bg, #fff)' : 'var(--text)' }}
                      onClick={() => setSite(i, { pages: s.pages.map((x, xi) => (xi === pi ? { ...x, itemIds: on ? x.itemIds.filter((id) => id !== c.id) : [...(x.itemIds || []), c.id] } : x)) })}>
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" style={btn} onClick={() => setSite(i, { pages: [...(s.pages || []), { urlPattern: '', pageType: 'other', itemIds: [], note: '' }] })}>+ Page mapping</button>
            <button type="button" style={{ ...btn, color: 'var(--danger, #b3261e)' }} onClick={() => set({ sites: cfg.sites.filter((_, j) => j !== i) })}>Delete site</button>
          </div>
        </div>
      ))}
      <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => set({ sites: [...cfg.sites, { name: '', suiteId: '', domains: [], enabled: false, teaser: '', brandColor: '', dailyBudget: 400, pages: [] }] })}>+ Add site</button>

      <H>Catalogue — tickets, add-ons & bundles</H>
      <p style={small}>The Owl's ONLY price/product facts, and the only links it can hand out. Paste the Howler checkout link per item (Pulse adds tracking automatically).</p>
      {cfg.catalogue.map((c, i) => (
        <div key={c.id || i} style={card}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '2fr 1fr 1fr 1fr 1fr', gap: 8 }}>
            <input style={input} value={c.label} placeholder="Label (e.g. Weekend Pass)" onChange={(e) => setCat(i, { label: e.target.value })} />
            <select style={input} value={c.kind} onChange={(e) => setCat(i, { kind: e.target.value })}>
              <option value="ticket">ticket</option><option value="addon">add-on</option><option value="bundle">bundle</option>
            </select>
            <input style={input} value={c.price} placeholder="Price (e.g. 950)" onChange={(e) => setCat(i, { price: e.target.value })} />
            <input style={input} value={c.currency} placeholder="ZAR" onChange={(e) => setCat(i, { currency: e.target.value })} />
            <select style={input} value={c.availability} onChange={(e) => setCat(i, { availability: e.target.value })}>
              {AVAILABILITY.map((a) => <option key={a} value={a}>{a || '— availability —'}</option>)}
            </select>
          </div>
          <input style={{ ...input, marginTop: 6 }} value={c.deepLink} placeholder="Howler checkout link (https://…)" onChange={(e) => setCat(i, { deepLink: e.target.value })} />
          <input style={{ ...input, marginTop: 6 }} value={c.description} placeholder="One-liner the Owl can use (what's included, who it's for)" onChange={(e) => setCat(i, { description: e.target.value })} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <input type="checkbox" checked={c.public !== false} onChange={(e) => setCat(i, { public: e.target.checked })} style={{ width: 16, height: 16 }} />
              Visible to fans
            </label>
            <button type="button" style={{ ...btn, color: 'var(--danger, #b3261e)' }} onClick={() => set({ catalogue: cfg.catalogue.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        </div>
      ))}
      <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => set({ catalogue: [...cfg.catalogue, { label: '', kind: 'ticket', price: '', currency: 'ZAR', deepLink: '', description: '', availability: '', public: true }] })}>+ Add item</button>

      <H>Knowledge — FAQs, policies & info</H>
      <p style={small}>The ONLY source the Owl may quote for rules and logistics (refunds, kids, what's included…). If it's not here, the Owl says it doesn't know — and logs the gap below.</p>
      {cfg.knowledge.map((k, i) => (
        <div key={k.id || i} style={card}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 3fr', gap: 8 }}>
            <select style={input} value={k.kind} onChange={(e) => setKnow(i, { kind: e.target.value })}>
              <option value="faq">FAQ</option><option value="policy">policy</option><option value="info">info</option>
            </select>
            <input style={input} value={k.question} placeholder="Question (e.g. What's the refund policy?)" onChange={(e) => setKnow(i, { question: e.target.value })} />
          </div>
          <textarea style={{ ...input, marginTop: 6, resize: 'vertical' }} rows={3} value={k.body} placeholder="The answer, in the organiser's words — the Owl sticks closely to this." onChange={(e) => setKnow(i, { body: e.target.value })} />
          <div style={{ textAlign: 'right', marginTop: 6 }}>
            <button type="button" style={{ ...btn, color: 'var(--danger, #b3261e)' }} onClick={() => set({ knowledge: cfg.knowledge.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        </div>
      ))}
      <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => set({ knowledge: [...cfg.knowledge, { kind: 'faq', question: '', body: '' }] })}>+ Add entry</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <button type="button" style={primaryBtn} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save Fan Owl config'}</button>
        {savedAt > 0 && Date.now() - savedAt < 4000 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Saved ✓</span>}
      </div>

      {stats && <Flywheel stats={stats} leads={leads} loadLeads={() => fetch(`${base}/leads`).then((r) => r.json()).then((d) => setLeads(d.leads || [])).catch(() => setLeads([]))} />}
    </div>
  );
}

function Flywheel({ stats, leads, loadLeads }) {
  const total = useMemo(() => (stats.sites || []).reduce((acc, s) => {
    for (const [k, v] of Object.entries(s.funnel || {})) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {}), [stats]);
  const topics = useMemo(() => (stats.sites || []).flatMap((s) => s.topics || []).sort((a, b) => b.c - a.c).slice(0, 10), [stats]);
  const stat = (label, v) => (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 12px', minWidth: 90 }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{v || 0}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</div>
    </div>
  );
  return (
    <div style={{ marginTop: 20 }}>
      <H>Last 30 days</H>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {stat('Ribbon views', total.ribbon_view)}
        {stat('Chats opened', total.chat_open)}
        {stat('Messages', total.chat_message)}
        {stat('Buy clicks', total.deeplink_click)}
        {stat('Leads', stats.leads?.total)}
        {stat('Opted in', stats.leads?.optedIn)}
      </div>
      {topics.length > 0 && (
        <>
          <p style={{ ...small, marginTop: 10 }}>What fans asked about (interest + unanswered questions — your FAQ gaps):</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {topics.map((t) => <span key={t.topic} style={{ fontSize: 12, border: '1px solid var(--hairline)', borderRadius: 999, padding: '4px 10px' }}>{t.topic} · {t.c}</span>)}
          </div>
        </>
      )}
      <div style={{ marginTop: 10 }}>
        {!leads && <button type="button" style={btn} onClick={loadLeads}>Show captured fans</button>}
        {leads && (leads.length === 0 ? <p style={small}>No fans captured yet.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 480 }}>
              <thead><tr>{['Email', 'Name', 'Marketing opt-in', 'Interests', 'When'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--hairline)', fontWeight: 700 }}>{h}</th>)}</tr></thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td style={{ padding: '6px 10px' }}>{l.email}</td>
                    <td style={{ padding: '6px 10px' }}>{l.name}</td>
                    <td style={{ padding: '6px 10px' }}>{l.consentMarketing ? '✅' : '—'}</td>
                    <td style={{ padding: '6px 10px' }}>{(l.preferences || []).join(', ')}</td>
                    <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{String(l.at || '').slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
