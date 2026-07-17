import { useEffect, useMemo, useState } from 'react';
import { useIsMobile } from '../lib/useIsMobile.js';

// ─── Fan Owl config — dual-surface editor (docs/specs/FAN_OWL_SPEC.md §3B) ─────
// The same component serves Admin → client detail (scope="admin-client") and the
// client's own Settings (scope="my"), like MailTemplateEditor. Organised as four
// sections: SITES & PAGES (embed key, domain allowlist, page mappings with their
// per-page info + chips, the website reader), CATALOGUE (tickets/add-ons with
// Howler-supplied buy links + images — the Owl's only price facts), FAQs
// (event-wide knowledge the Owl may quote), and REPORTS (funnel, FAQ gaps,
// captured fans).

const PAGE_TYPES = ['home', 'lineup', 'artist', 'tickets', 'attraction', 'venue', 'accommodation', 'sponsors', 'faq', 'other'];
const ITEM_KINDS = ['ticket', 'addon', 'bundle', 'accommodation', 'transport', 'merchandise'];
const AVAILABILITY = ['', 'selling fast', 'last few', 'sold out'];
const LANGS = [['', "Auto — fan's device language, else English"], ['en', 'English'], ['af', 'Afrikaans'], ['it', 'Italiano'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['pt', 'Português'], ['nl', 'Nederlands']];
const NAV_TYPE_LABELS = { home: 'Home', tickets: 'Tickets', lineup: 'Line-up', artist: 'Artists', venue: 'Venue', accommodation: 'Stay', attraction: 'Explore', sponsors: 'Partners', faq: 'FAQs', other: 'More' };
// Same derivation as the server: a mapping is navigable when its pattern leaves a path.
const navigablePath = (pattern) => {
  const frag = String(pattern || '').replace(/\*/g, '').replace(/[^\w/\-.:]/g, '').trim();
  return !frag || frag.startsWith('/') ? frag : `/${frag}`;
};
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', fontFamily: 'inherit', background: 'var(--card, #fff)', color: 'var(--text)' };
const small = { fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 4px' };
const btn = { padding: '8px 14px', borderRadius: 8, border: '1.5px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontSize: 12.5, cursor: 'pointer', minHeight: 36 };
const primaryBtn = { ...btn, background: 'var(--text)', color: 'var(--bg, #fff)', border: 0, fontWeight: 700 };
const card = { border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, marginTop: 10 };
const H = ({ children }) => <h3 style={{ fontSize: 14, fontWeight: 700, margin: '18px 0 2px' }}>{children}</h3>;
const summaryStyle = { cursor: 'pointer', fontWeight: 700, fontSize: 13, padding: '8px 0', listStyle: 'none' };

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
  const [tab, setTab] = useState('sites');
  const [imgBusy, setImgBusy] = useState(-1); // catalogue index mid-upload
  const [imgNote, setImgNote] = useState(null); // { i, text }
  const [avBusy, setAvBusy] = useState(-1); // site index mid-avatar-upload
  const [ticketUrl, setTicketUrl] = useState('');
  const [catIngesting, setCatIngesting] = useState(false);
  const [catNote, setCatNote] = useState('');
  const [navBusy, setNavBusy] = useState(false);
  const [navNote, setNavNote] = useState(null); // { i, text }
  const TABS = [['sites', '🌐 Sites'], ['persona', '🪄 Personality'], ['nav', '🧭 Navigation'], ['pages', '📄 Pages'], ['catalogue', '🎟️ Catalogue'], ['knowledge', '❓ FAQs'], ['rewards', '🎁 Rewards'], ['reports', '📊 Reports']];
  // Reward pools (loyalty phase 2) — their own routes; 403 = the fanowl.loyalty
  // flag is off for this client, and the tab explains that instead of erroring.
  const loyaltyBase = scope === 'my' ? `/api/my/loyalty/${entityId}` : `/api/admin/entities/${entityId}/loyalty`;
  const [pools, setPools] = useState(null);
  const [poolsDenied, setPoolsDenied] = useState(false);
  const [poolsSaving, setPoolsSaving] = useState(false);
  const [poolsSavedAt, setPoolsSavedAt] = useState(0);
  const [codesDraft, setCodesDraft] = useState({}); // pool index → pasted codes
  const [codesNote, setCodesNote] = useState(null); // { i, text }

  useEffect(() => {
    let on = true;
    fetch(base).then((r) => r.json()).then((c) => { if (on) setCfg(c); }).catch(() => {});
    fetch(`${loyaltyBase}/pools`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (on) setPools(d.pools || []); })
      .catch((e) => { if (on && e.message === '403') setPoolsDenied(true); });
    fetch(`${base}/insights`).then((r) => r.json()).then((s) => { if (on) setStats(s); }).catch(() => {});
    const suitesUrl = scope === 'my' ? '/api/my/suites' : '/api/admin/suites';
    fetch(suitesUrl).then((r) => r.json()).then((rows) => {
      const list = Array.isArray(rows) ? rows : rows.suites || [];
      if (on) setSuites(list.filter((s) => scope === 'my' || s.entityId === entityId).map((s) => ({ id: s.id, name: s.name })));
    }).catch(() => {});
    return () => { on = false; };
  }, [base, loyaltyBase, scope, entityId]);

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setSite = (i, patch) => set({ sites: cfg.sites.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const setCat = (i, patch) => set({ catalogue: cfg.catalogue.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const setKnow = (i, patch) => set({ knowledge: cfg.knowledge.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const setPage = (i, pi, patch) => setSite(i, { pages: cfg.sites[i].pages.map((x, xi) => (xi === pi ? { ...x, ...patch } : x)) });
  const movePage = (i, pi, dir) => {
    const pages = [...cfg.sites[i].pages];
    const to = pi + dir;
    if (to < 0 || to >= pages.length) return;
    const [x] = pages.splice(pi, 1);
    pages.splice(to, 0, x);
    setSite(i, { pages });
  };

  // Upload catalogue images: downscale in the browser (≤1600px JPEG), POST the
  // data-URL, and drop the returned hosted URL into the item's images like any
  // pasted URL. Nothing goes live until Save.
  async function uploadImages(i, files) {
    const room = 8 - (cfg.catalogue[i].images || []).length;
    const picked = [...files].filter((f) => f.type.startsWith('image/')).slice(0, Math.max(0, room));
    if (!picked.length) { setImgNote({ i, text: room <= 0 ? 'This item already has 8 images — remove one first.' : 'Pick an image file (JPEG/PNG/WebP).' }); return; }
    setImgBusy(i); setImgNote(null);
    try {
      const urls = [];
      for (const f of picked) {
        const r = await fetch(`${base}/images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: await downscaleImage(f) }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Upload failed — try again.');
        urls.push(d.url);
      }
      setCfg((c) => ({ ...c, catalogue: c.catalogue.map((x, j) => (j === i ? { ...x, images: [...(x.images || []), ...urls].slice(0, 8) } : x)) }));
      setImgNote({ i, text: `Uploaded ${urls.length} image${urls.length === 1 ? '' : 's'} ✓ — remember to Save.` });
    } catch (e) { setImgNote({ i, text: `⚠️ ${e.message}` }); }
    finally { setImgBusy(-1); }
  }

  // "Read the ticket site": crawl the shop → AI-suggested catalogue items merged
  // into the UNSAVED editor state (existing items never touched; dedupe by
  // label) — review prices & links, then Save. Interim until the Howler API feed.
  async function ingestCatalogue() {
    const url = ticketUrl.trim();
    if (!url) { setCatNote('Enter the ticket-shop URL first (https://…).'); return; }
    setCatIngesting(true); setCatNote('Reading the ticket site — this takes ~30–60s…');
    try {
      const r = await fetch(`${base}/ingest-catalogue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: /^https?:\/\//i.test(url) ? url : `https://${url}` }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'The read failed — try again.');
      setCfg((c) => {
        const have = new Set(c.catalogue.map((x) => String(x.label || '').toLowerCase().trim()));
        const fresh = (d.items || []).filter((x) => !have.has(x.label.toLowerCase().trim()));
        const skipped = (d.items || []).length - fresh.length;
        setCatNote(`Read ${d.crawled.length} page${d.crawled.length === 1 ? '' : 's'} → suggested ${fresh.length} new item${fresh.length === 1 ? '' : 's'}${skipped ? ` (${skipped} already in the catalogue — left untouched)` : ''}. Check every price, link and image, then Save.`);
        return { ...c, catalogue: [...c.catalogue, ...fresh] };
      });
    } catch (e) { setCatNote(`⚠️ ${e.message}`); }
    finally { setCatIngesting(false); }
  }

  // "Suggest from website menu": read the site's real <nav>/<header> tabs
  // (deterministic, no AI) and load them as an UNSAVED custom button list.
  async function suggestNav(i) {
    const site = cfg.sites[i];
    if (!site.id) { setNavNote({ i, text: 'Save the site first, then suggest.' }); return; }
    const domain = (site.domains || [])[0];
    if (!domain) { setNavNote({ i, text: 'Add the site’s domain first (Sites tab) — that tells the reader which website’s menu to read.' }); return; }
    setNavBusy(true); setNavNote({ i, text: 'Reading the website’s menu…' });
    try {
      const r = await fetch(`${base}/suggest-nav`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId: site.id, url: `https://${domain}` }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'The read failed — try again.');
      setCfg((c) => ({ ...c, sites: c.sites.map((x, j) => (j === i ? { ...x, navButtons: d.buttons } : x)) }));
      setNavNote({ i, text: `Found ${d.buttons.length} menu tab${d.buttons.length === 1 ? '' : 's'} — review, rename or toggle, then Save.` });
    } catch (e) { setNavNote({ i, text: `⚠️ ${e.message}` }); }
    finally { setNavBusy(false); }
  }

  // The Owl's face: one square-ish image per site, downscaled small and hosted
  // like any catalogue image; the URL rides the site's owlAvatar field.
  async function uploadAvatar(i, file) {
    if (!file || !file.type.startsWith('image/')) return;
    setAvBusy(i);
    try {
      const r = await fetch(`${base}/images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: await downscaleImage(file, 512, 0.85) }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Upload failed — try again.');
      setCfg((c) => ({ ...c, sites: c.sites.map((x, j) => (j === i ? { ...x, owlAvatar: d.url } : x)) }));
    } catch (e) { setIngestNote(`⚠️ ${e.message}`); }
    finally { setAvBusy(-1); }
  }

  async function save() {
    setSaving(true);
    try {
      const r = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      if (r.ok) { setCfg(await r.json()); setSavedAt(Date.now()); }
    } finally { setSaving(false); }
  }
  const snippet = (siteKey) => `<script async src="${window.location.origin}/fan-owl.js" data-site-key="${siteKey}"></script>`;

  // "Read the website": crawl → AI suggestions merged into the UNSAVED editor
  // state (deduped; never overwriting promoter edits) — review, then Save.
  // "Write sales pitches": one AI call drafts a salesy ribbon line per page from
  // its info + ticked items; fills only EMPTY pitch fields (edits always win).
  const [pitching, setPitching] = useState(false);
  async function writePitches(siteIndex) {
    const site = cfg.sites[siteIndex];
    if (!site?.id) { setIngestNote('Save the site first, then draft pitches.'); return; }
    setPitching(true); setIngestNote('Writing pitches from each page\'s info + items…');
    try {
      const r = await fetch(`${base}/pitches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId: site.id }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Pitch drafting failed — try again.');
      const byPat = new Map((d.pitches || []).map((p) => [p.urlPattern.toLowerCase().trim(), p.pitch]));
      setCfg((c) => ({
        ...c,
        sites: c.sites.map((s, j) => (j !== siteIndex ? s : {
          ...s,
          pages: (s.pages || []).map((p) => (String(p.pitch || '').trim() ? p : { ...p, pitch: byPat.get(p.urlPattern.toLowerCase().trim()) || '' })),
        })),
      }));
      setIngestNote(`Drafted ${d.pitches.length} pitch${d.pitches.length === 1 ? '' : 'es'} — review each page's pitch line, edit freely, then Save.`);
    } catch (e) { setIngestNote(`⚠️ ${e.message}`); }
    finally { setPitching(false); }
  }

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
          const byPat = new Map((d.pages || []).map((p) => [p.urlPattern.toLowerCase().trim(), p]));
          const merged = (s.pages || []).map((p) => {
            const sug = byPat.get(p.urlPattern.toLowerCase().trim());
            if (sug) byPat.delete(p.urlPattern.toLowerCase().trim());
            if (!sug) return p;
            return {
              ...p,
              content: String(p.content || '').trim() ? p.content : (sug.content || ''),
              note: p.note || sug.note || '',
              starters: (p.starters || []).length ? p.starters : (sug.starters || []),
            };
          });
          const newPages = [...byPat.values()].map((p) => ({ ...p, itemIds: [] }));
          return { ...s, pages: [...merged, ...newPages] };
        });
        setIngestNote(`Read ${d.crawled.length} page${d.crawled.length === 1 ? '' : 's'} → suggested ${newKnow.length} FAQ entries + ${(d.pages || []).length} pages (info + chips). Review, edit freely, then Save.`);
        return { ...c, sites, knowledge: [...c.knowledge, ...newKnow] };
      });
    } catch (e) { setIngestNote(`⚠️ ${e.message}`); }
    finally { setIngesting(false); }
  }

  if (!cfg) return <p style={small}>Loading the Fan Owl config…</p>;

  const saveBar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
      <button type="button" style={primaryBtn} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save Fan Owl config'}</button>
      {savedAt > 0 && Date.now() - savedAt < 4000 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Saved ✓</span>}
    </div>
  );

  return (
    <div style={{ marginTop: 14 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>🦉 Fan Owl — website booking guide</h2>
      <p style={small}>The Owl on the event's public website: it guides fans to the right ticket, answers only from what you approve here, and hands out the buy links you supply. Nothing here is private — only publish what any fan may see.</p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--hairline)', padding: '10px 0', marginBottom: 4 }}>
        {TABS.map(([key, label]) => (
          <button key={key} type="button" onClick={() => setTab(key)}
            style={{ ...btn, fontWeight: tab === key ? 700 : 500, background: tab === key ? 'var(--text)' : 'transparent', color: tab === key ? 'var(--bg, #fff)' : 'var(--text)', border: tab === key ? 0 : btn.border }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'sites' && (
        <>
          <p style={small}>One site per website. Paste the embed snippet once, site-wide. Domains lock which websites may use the key (leave empty while testing).</p>
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
                  <div style={small}>Brand colour (hex — blank adopts your Pulse branding; also editable under 🪄 Personality)</div>
                  <input style={input} value={s.brandColor} onChange={(e) => setSite(i, { brandColor: e.target.value })} placeholder="#111111" />
                </div>
                <div>
                  <div style={small}>Daily chat budget (messages/day; over it the widget degrades to ribbon-only)</div>
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

              <div style={{ textAlign: 'right', marginTop: 8 }}>
                <button type="button" style={{ ...btn, color: 'var(--danger, #b3261e)' }} onClick={() => set({ sites: cfg.sites.filter((_, j) => j !== i) })}>Delete site</button>
              </div>
            </div>
          ))}
          <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => set({ sites: [...cfg.sites, { name: '', suiteId: '', domains: [], enabled: false, teaser: '', brandColor: '', dailyBudget: 400, owlName: '', owlAvatar: '', owlIntro: '', persona: '', guardrails: '', defaultLang: '', widgetTheme: '', widgetStyle: '', heroHome: false, navStyle: '', navButtons: null, pages: [] }] })}>+ Add site</button>
          {saveBar}
        </>
      )}

      {tab === 'persona' && (
        <>
          <p style={small}>Make each site's Owl your own: its face, name, voice and house rules. Personality shapes HOW it speaks — the hard rules (real prices only, nothing invented, no fake urgency) always win. 💡 Special tips live under FAQs as the “tip” kind — the Owl volunteers them when they genuinely help.</p>
          {!cfg.sites.length && <p style={small}>Add a site first (Sites section) — the personality belongs to a site.</p>}
          {cfg.sites.map((s, i) => (
            <div key={s.id || i} style={card}>
              {cfg.sites.length > 1 && <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>{s.name || 'Untitled site'}</div>}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                {s.owlAvatar
                  ? <img src={s.owlAvatar} alt="" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover' }} />
                  : <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--hairline)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26 }}>🦉</div>}
                <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', fontWeight: 700, opacity: avBusy === i ? 0.6 : 1 }}>
                  {avBusy === i ? 'Uploading…' : (s.owlAvatar ? 'Change face' : '📷 Upload a face')}
                  <input type="file" accept="image/*" style={{ display: 'none' }} disabled={avBusy !== -1}
                    onChange={(e) => { uploadAvatar(i, e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {s.owlAvatar && <button type="button" style={btn} onClick={() => setSite(i, { owlAvatar: '' })}>Back to 🦉</button>}
                <span style={{ ...small, margin: 0 }}>Shows on the launcher button and in the chat header.</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 2fr', gap: 8 }}>
                <div>
                  <div style={small}>Owl's name (the chat header title)</div>
                  <input style={input} value={s.owlName || ''} maxLength={40} placeholder="e.g. Kappa Guide" onChange={(e) => setSite(i, { owlName: e.target.value })} />
                </div>
                <div>
                  <div style={small}>Intro line (the first thing fans read when the chat opens)</div>
                  <input style={input} value={s.owlIntro || ''} maxLength={200} placeholder="e.g. Ciao! I'm your festival insider — ask me anything 🎶" onChange={(e) => setSite(i, { owlIntro: e.target.value })} />
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <div style={small}>Default language — the Owl greets in the fan's phone/browser language when it can tell; this is the fallback (it always answers in whatever language the fan writes)</div>
                <select style={input} value={s.defaultLang || ''} onChange={(e) => setSite(i, { defaultLang: e.target.value })}>
                  {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8, marginTop: 8 }}>
                <div>
                  <div style={small}>Widget colour — launcher, header & buttons (hex)</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span aria-hidden style={{ width: 26, height: 26, borderRadius: 8, flex: '0 0 auto', border: '1px solid var(--hairline)', background: s.brandColor || cfg.inherited?.brandColor || '#111' }} />
                    <input style={input} value={s.brandColor || ''} placeholder={cfg.inherited?.brandColor || '#111111'} onChange={(e) => setSite(i, { brandColor: e.target.value })} />
                  </div>
                  <div style={small}>Blank = adopts your Pulse brand{cfg.inherited?.brandColor ? ` (${cfg.inherited.brandColor})` : ''} — set one here if that clashes with this website.</div>
                </div>
                <div>
                  <div style={small}>Widget theme — the chat surface</div>
                  <select style={input} value={s.widgetTheme || ''} onChange={(e) => setSite(i, { widgetTheme: e.target.value })}>
                    <option value="">Auto — follow the fan's device</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </div>
                <div>
                  <div style={small}>Widget style — how the Owl sits on the website</div>
                  <select style={input} value={s.widgetStyle || ''} onChange={(e) => setSite(i, { widgetStyle: e.target.value })}>
                    <option value="">Floating launcher (default)</option>
                    <option value="bar">Persistent ask bar — always-on input + nav at the bottom of every page</option>
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginTop: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!s.heroHome} onChange={(e) => setSite(i, { heroHome: e.target.checked })} style={{ width: 16, height: 16 }} />
                    Hero chat on the home page — greet fans with the ask box centred (folds away on scroll or dismiss)
                  </label>
                </div>
              </div>
              <div style={{ ...small, marginTop: 8 }}>Personality & voice — how should it sound? (style only; it can never change prices or facts)</div>
              <textarea style={{ ...input, resize: 'vertical' }} rows={3} value={s.persona || ''} maxLength={2000}
                placeholder="e.g. Warm and cheeky, proudly local, first-name basis, loves music puns, answers in the fan's language, keeps it short."
                onChange={(e) => setSite(i, { persona: e.target.value })} />
              <div style={{ ...small, marginTop: 8 }}>Dos & don'ts — house rules for this Owl</div>
              <textarea style={{ ...input, resize: 'vertical' }} rows={3} value={s.guardrails || ''} maxLength={2000}
                placeholder="e.g. Always mention the waiting list when something's sold out. Don't recommend camping to families. Never discuss other festivals."
                onChange={(e) => setSite(i, { guardrails: e.target.value })} />
              {s.siteKey && (
                <div style={{ marginTop: 10 }}>
                  <a href={`/fan-owl-test?k=${s.siteKey}`} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', fontWeight: 700 }}>▶ Preview this personality</a>
                  <span style={{ ...small, marginLeft: 8 }}>Save first — the preview reads the saved config.</span>
                </div>
              )}
            </div>
          ))}
          {cfg.sites.length > 0 && saveBar}
        </>
      )}

      {tab === 'nav' && (
        <>
          <p style={small}>The quick buttons fans use to hop around your site from the Owl — tap = the Owl takes them there and follows with that page's context. Buttons come from your 📄 Pages automatically; curate them per site below.</p>
          {!cfg.sites.length && <p style={small}>Add a site first (Sites section) — the buttons belong to a site.</p>}
          {cfg.sites.map((s, i) => (
            <div key={s.id || i} style={card}>
              {cfg.sites.length > 1 && <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 8 }}>{s.name || 'Untitled site'}</div>}
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8 }}>
                  <div>
                    <div style={small}>Where they live</div>
                    <select style={input} value={s.navStyle || ''} onChange={(e) => setSite(i, { navStyle: e.target.value })}>
                      <option value="">Icon strip under the header (default)</option>
                      <option value="plus">＋ menu next to the message box</option>
                      <option value="pills">Labelled pills above the message box (centred)</option>
                      <option value="below">Labelled pills below the message box (centred)</option>
                      <option value="off">Off — chat only</option>
                    </select>
                  </div>
                  <div>
                    <div style={small}>Which buttons</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" style={{ ...btn, fontWeight: 700, background: !Array.isArray(s.navButtons) ? 'var(--text)' : 'transparent', color: !Array.isArray(s.navButtons) ? 'var(--bg, #fff)' : 'var(--text)', border: !Array.isArray(s.navButtons) ? 0 : btn.border }}
                        onClick={() => setSite(i, { navButtons: null })}>Auto — from your pages</button>
                      <button type="button" style={{ ...btn, fontWeight: 700, background: Array.isArray(s.navButtons) ? 'var(--text)' : 'transparent', color: Array.isArray(s.navButtons) ? 'var(--bg, #fff)' : 'var(--text)', border: Array.isArray(s.navButtons) ? 0 : btn.border }}
                        onClick={() => { if (!Array.isArray(s.navButtons)) setSite(i, { navButtons: (s.pages || []).filter((p) => navigablePath(p.urlPattern)).slice(0, 12).map((p) => ({ kind: 'page', urlPattern: p.urlPattern, label: '', emoji: '', enabled: true })) }); }}>Custom</button>
                      <button type="button" style={{ ...btn, borderStyle: 'dashed' }} disabled={navBusy} onClick={() => suggestNav(i)}>{navBusy ? 'Reading…' : '🔮 Suggest from website menu'}</button>
                    </div>
                  </div>
                </div>
                {!Array.isArray(s.navButtons) && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
                    {(s.pages || []).filter((p) => navigablePath(p.urlPattern)).slice(0, 8).map((p) => (
                      <span key={p.urlPattern} style={{ fontSize: 12, border: '1px solid var(--hairline)', borderRadius: 999, padding: '5px 11px' }}>{NAV_TYPE_LABELS[p.pageType] || NAV_TYPE_LABELS.other} <span style={{ color: 'var(--muted)' }}>· {navigablePath(p.urlPattern)}</span></span>
                    ))}
                    {!(s.pages || []).some((p) => navigablePath(p.urlPattern)) && <span style={small}>No mapped pages yet — add them under 📄 Pages (or run "Read the website") and buttons appear automatically.</span>}
                    <span style={small}>Switch to Custom to rename, reorder, toggle or add your own links.</span>
                  </div>
                )}
                {Array.isArray(s.navButtons) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                    {s.navButtons.map((b, bi) => {
                      const pg = b.kind !== 'custom' ? (s.pages || []).find((p) => p.urlPattern === b.urlPattern) : null;
                      const defLabel = b.kind === 'custom' ? 'Custom link' : (NAV_TYPE_LABELS[pg?.pageType] || NAV_TYPE_LABELS.other);
                      const upd = (patch) => setSite(i, { navButtons: s.navButtons.map((x, xi) => (xi === bi ? { ...x, ...patch } : x)) });
                      const move = (dir) => {
                        const arr = [...s.navButtons]; const to = bi + dir;
                        if (to < 0 || to >= arr.length) return;
                        const [x] = arr.splice(bi, 1); arr.splice(to, 0, x);
                        setSite(i, { navButtons: arr });
                      };
                      return (
                        <div key={`${b.kind}-${b.urlPattern || b.path}-${bi}`} style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid var(--hairline)', borderRadius: 10, padding: '6px 8px', flexWrap: 'wrap', opacity: b.enabled === false ? 0.55 : 1 }}>
                        <input type="checkbox" checked={b.enabled !== false} onChange={(e) => upd({ enabled: e.target.checked })} style={{ width: 16, height: 16 }} title="Show this button" />
                        <input style={{ ...input, width: 54, textAlign: 'center', padding: '7px 4px' }} value={b.emoji || ''} maxLength={4} placeholder="icon" title="Emoji icon (blank = the page-type icon)" onChange={(e) => upd({ emoji: e.target.value })} />
                        <input style={{ ...input, flex: '1 1 110px', width: 'auto' }} value={b.label || ''} maxLength={24} placeholder={defLabel} title="Button label" onChange={(e) => upd({ label: e.target.value })} />
                        {b.kind === 'custom'
                          ? <input style={{ ...input, flex: '2 1 140px', width: 'auto' }} value={b.path || ''} placeholder="/glamping (path on your site)" onChange={(e) => upd({ path: e.target.value })} />
                          : <span style={{ ...small, margin: 0, flex: '2 1 140px', fontFamily: 'ui-monospace, monospace' }}>{navigablePath(b.urlPattern)} · {pg ? pg.pageType : '⚠️ page mapping removed'}</span>}
                        <button type="button" aria-label="Move up" disabled={bi === 0} style={{ ...btn, minHeight: 28, padding: '2px 8px', fontSize: 11, opacity: bi === 0 ? 0.35 : 1 }} onClick={() => move(-1)}>▲</button>
                        <button type="button" aria-label="Move down" disabled={bi === s.navButtons.length - 1} style={{ ...btn, minHeight: 28, padding: '2px 8px', fontSize: 11, opacity: bi === s.navButtons.length - 1 ? 0.35 : 1 }} onClick={() => move(1)}>▼</button>
                        <button type="button" aria-label="Remove" style={{ ...btn, minHeight: 28, padding: '2px 8px', fontSize: 11, color: 'var(--danger, #b3261e)' }} onClick={() => setSite(i, { navButtons: s.navButtons.filter((_, xi) => xi !== bi) })}>✕</button>
                        </div>
                      );
                    })}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button type="button" style={btn} onClick={() => setSite(i, { navButtons: [...s.navButtons, { kind: 'custom', urlPattern: '', label: '', emoji: '🔗', path: '', enabled: true }] })}>+ Add custom link</button>
                      <button type="button" style={btn} onClick={() => setSite(i, { navButtons: (s.pages || []).filter((p) => navigablePath(p.urlPattern)).slice(0, 12).map((p) => ({ kind: 'page', urlPattern: p.urlPattern, label: '', emoji: '', enabled: true })) })}>↺ Rebuild from pages</button>
                      <span style={{ ...small, alignSelf: 'center' }}>Up to 8 show; blank label/icon = the page-type default.</span>
                    </div>
                  </div>
                )}
                {navNote && navNote.i === i && <p style={{ ...small, marginTop: 6 }}>{navNote.text}</p>}
              {s.siteKey && (
                <div style={{ marginTop: 10 }}>
                  <a href={`/fan-owl-test?k=${s.siteKey}`} target="_blank" rel="noreferrer" style={{ ...btn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', fontWeight: 700 }}>▶ Preview</a>
                  <span style={{ ...small, marginLeft: 8 }}>Save first — the preview reads the saved config.</span>
                </div>
              )}
            </div>
          ))}
          {cfg.sites.length > 0 && saveBar}
        </>
      )}

      {tab === 'pages' && (
        <>
          <p style={small}>What the Owl knows & sells on each page. When the page URL contains the pattern (* = wildcard), the Owl leads with the ticked items, answers from that page's info, and shows that page's chips. Longest match wins; unmatched pages get the whole catalogue. Page info is searchable from anywhere.</p>
          {!cfg.sites.length && <p style={small}>Add a site first (Sites section) — pages belong to a site.</p>}
          {cfg.sites.map((s, i) => (
            <div key={s.id || i} style={card}>
              {cfg.sites.length > 1 && <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 4 }}>{s.name || 'Untitled site'}</div>}

              <details style={{ marginBottom: 6 }}>
                <summary style={summaryStyle}>🔮 Read the website — draft pages, info & chips automatically</summary>
                <p style={small}>Point the Owl at the event site — it reads the pages and SUGGESTS page info, chips and FAQs. Nothing goes live until you review and Save.</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input style={{ ...input, flex: '1 1 220px', width: 'auto' }} value={ingestUrl} placeholder={`https://${(s.domains || [])[0] || 'your-event-site.com'}`} onChange={(e) => setIngestUrl(e.target.value)} />
                  <button type="button" style={{ ...btn, fontWeight: 700 }} disabled={ingesting} onClick={() => ingest(i)}>{ingesting ? 'Reading…' : 'Read & suggest'}</button>
                </div>
                {ingestNote && <p style={{ ...small, marginTop: 6 }}>{ingestNote}</p>}
              </details>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '2px 0 6px' }}>
                <button type="button" style={{ ...btn, fontWeight: 700 }} disabled={pitching} onClick={() => writePitches(i)}>{pitching ? 'Writing…' : '✨ Write sales pitches'}</button>
                <span style={small}>Drafts the salesy ribbon line per page (fills empty pitch fields only).</span>
              </div>

              {(s.pages || []).map((p, pi) => (
                <details key={p.id || pi} style={{ borderTop: '1px dashed var(--hairline)' }} open={!p.urlPattern}>
                  <summary style={{ ...summaryStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {p.urlPattern || 'New page'} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {p.pageType}{(p.itemIds || []).length ? ` · ${p.itemIds.length} item${p.itemIds.length === 1 ? '' : 's'}` : ''}{p.content ? ' · info ✓' : ''}{(p.starters || []).length ? ' · chips ✓' : ''}</span>
                    </span>
                    <button type="button" aria-label="Move up" disabled={pi === 0} style={{ ...btn, minHeight: 28, padding: '2px 9px', fontSize: 11, opacity: pi === 0 ? 0.35 : 1 }}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); movePage(i, pi, -1); }}>▲</button>
                    <button type="button" aria-label="Move down" disabled={pi === (s.pages || []).length - 1} style={{ ...btn, minHeight: 28, padding: '2px 9px', fontSize: 11, opacity: pi === (s.pages || []).length - 1 ? 0.35 : 1 }}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); movePage(i, pi, 1); }}>▼</button>
                  </summary>
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr auto', gap: 8 }}>
                    <input style={input} value={p.urlPattern} placeholder="/accommodation or /artists/*" onChange={(e) => setPage(i, pi, { urlPattern: e.target.value })} />
                    <select style={input} value={p.pageType} onChange={(e) => setPage(i, pi, { pageType: e.target.value })}>
                      {PAGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <button type="button" style={btn} onClick={() => setSite(i, { pages: s.pages.filter((_, xi) => xi !== pi) })}>Remove</button>
                  </div>
                  <input style={{ ...input, marginTop: 6 }} value={p.note} placeholder="One-liner: what is this page? (e.g. Luna X plays Saturday night)" onChange={(e) => setPage(i, pi, { note: e.target.value })} />
                  <textarea style={{ ...input, marginTop: 6, resize: 'vertical' }} rows={3} value={p.content || ''}
                    placeholder="Page info — everything the Owl may tell fans about this page's topic (e.g. all the accommodation options). Filled by “Read the website”; add or edit freely."
                    onChange={(e) => setPage(i, pi, { content: e.target.value })} />
                  <input style={{ ...input, marginTop: 6 }} value={(p.starters || []).join(', ')}
                    placeholder="Suggested chips for this page, comma-separated (e.g. What are the glamping options?, Is bedding included?)"
                    onChange={(e) => setPage(i, pi, { starters: e.target.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4) })} />
                  <input style={{ ...input, marginTop: 6 }} value={p.pitch || ''} maxLength={160}
                    placeholder="Sales pitch — the salesy teaser line fans see on this page (✨ drafts it; edit freely, e.g. Glamping pods from R1,500 — wake up at the festival 🌙)"
                    onChange={(e) => setPage(i, pi, { pitch: e.target.value })} />
                  <div style={{ ...small, marginTop: 6 }}>Lead with these catalogue items on this page:</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingBottom: 8 }}>
                    {cfg.catalogue.map((c) => {
                      const on = (p.itemIds || []).includes(c.id);
                      return (
                        <button key={c.id} type="button"
                          style={{ ...btn, minHeight: 32, padding: '5px 10px', fontSize: 12, background: on ? 'var(--text)' : 'transparent', color: on ? 'var(--bg, #fff)' : 'var(--text)' }}
                          onClick={() => setPage(i, pi, { itemIds: on ? p.itemIds.filter((id) => id !== c.id) : [...(p.itemIds || []), c.id] })}>
                          {c.label}
                        </button>
                      );
                    })}
                    {!cfg.catalogue.length && <span style={small}>No catalogue items yet — add them in the Catalogue section.</span>}
                  </div>
                </details>
              ))}
              <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => setSite(i, { pages: [...(s.pages || []), { urlPattern: '', pageType: 'other', itemIds: [], note: '', content: '', starters: [] }] })}>+ Page</button>
            </div>
          ))}
          {cfg.sites.length > 0 && saveBar}
        </>
      )}

      {tab === 'catalogue' && (
        <>
          <p style={small}>Tickets, add-ons & bundles — the Owl's ONLY price/product facts, and the only links it can hand out. Paste the Howler checkout link per item (Pulse adds tracking automatically). Images show as a scrollable strip on the offer card.</p>
          <details style={{ marginBottom: 6 }}>
            <summary style={summaryStyle}>🔮 Read the ticket site — draft the catalogue automatically</summary>
            <p style={small}>Point the Owl at the event's ticket shop (e.g. the Howler event page) — it reads the tickets, prices, buy links and images and SUGGESTS catalogue items. Existing items are never touched; nothing goes live until you review and Save. (Interim tool — this will pull straight from Howler via API later.)</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input style={{ ...input, flex: '1 1 220px', width: 'auto' }} value={ticketUrl} placeholder="https://howler.co.za/events/…" onChange={(e) => setTicketUrl(e.target.value)} />
              <button type="button" style={{ ...btn, fontWeight: 700 }} disabled={catIngesting} onClick={ingestCatalogue}>{catIngesting ? 'Reading…' : 'Read & suggest'}</button>
            </div>
            {catNote && <p style={{ ...small, marginTop: 6 }}>{catNote}</p>}
          </details>
          {cfg.catalogue.map((c, i) => (
            <details key={c.id || i} style={{ ...card, paddingTop: 4, paddingBottom: 8 }} open={!c.label}>
              <summary style={summaryStyle}>
                {c.label || 'New item'}{' '}
                <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                  · {c.kind}{c.price ? ` · ${c.currency} ${c.price}` : ''}{c.availability ? ` · ${c.availability}` : ''}{(c.images || []).length ? ' · 📷' : ''}{c.public === false ? ' · hidden' : ''}
                </span>
              </summary>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '2fr 1fr 1fr 1fr 1fr', gap: 8 }}>
                <input style={input} value={c.label} placeholder="Label (e.g. Weekend Pass)" onChange={(e) => setCat(i, { label: e.target.value })} />
                <select style={input} value={c.kind} onChange={(e) => setCat(i, { kind: e.target.value })}>
                  {ITEM_KINDS.map((k) => <option key={k} value={k}>{k === 'addon' ? 'add-on' : k}</option>)}
                </select>
                <input style={input} value={c.price} placeholder="Price (e.g. 950)" onChange={(e) => setCat(i, { price: e.target.value })} />
                <input style={input} value={c.currency} placeholder="ZAR" onChange={(e) => setCat(i, { currency: e.target.value })} />
                <select style={input} value={c.availability} onChange={(e) => setCat(i, { availability: e.target.value })}>
                  {AVAILABILITY.map((a) => <option key={a} value={a}>{a || '— availability —'}</option>)}
                </select>
              </div>
              <input style={{ ...input, marginTop: 6 }} value={c.deepLink} placeholder="Howler checkout link (https://…)" onChange={(e) => setCat(i, { deepLink: e.target.value })} />
              <input style={{ ...input, marginTop: 6 }} value={c.description} placeholder="One-liner the Owl can use (what's included, who it's for)" onChange={(e) => setCat(i, { description: e.target.value })} />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', fontWeight: 700, opacity: imgBusy === i ? 0.6 : 1 }}>
                  {imgBusy === i ? 'Uploading…' : '📷 Upload images'}
                  <input type="file" accept="image/*" multiple style={{ display: 'none' }} disabled={imgBusy !== -1}
                    onChange={(e) => { uploadImages(i, e.target.files); e.target.value = ''; }} />
                </label>
                <span style={{ ...small, margin: 0 }}>Up to 8 — fans scroll through them on the offer card.</span>
              </div>
              {imgNote && imgNote.i === i && <p style={{ ...small, marginTop: 6 }}>{imgNote.text}</p>}
              {(c.images || []).filter((u) => /^https?:\/\//i.test(u)).length > 0 && (
                <div style={{ display: 'flex', gap: 10, overflowX: 'auto', marginTop: 6, paddingTop: 8 }}>
                  {c.images.filter((u) => /^https?:\/\//i.test(u)).map((u) => (
                    <div key={u} style={{ position: 'relative', flex: '0 0 auto' }}>
                      <img src={u} alt="" style={{ height: 54, borderRadius: 8, objectFit: 'cover', display: 'block' }} />
                      <button type="button" aria-label="Remove image" title="Remove image"
                        onClick={() => setCat(i, { images: c.images.filter((x) => x !== u) })}
                        style={{ position: 'absolute', top: -8, right: -8, width: 24, height: 24, borderRadius: 12, border: 0, background: 'var(--text)', color: 'var(--bg, #fff)', fontSize: 12, lineHeight: '24px', padding: 0, cursor: 'pointer' }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <details style={{ marginTop: 6 }}>
                <summary style={{ ...small, cursor: 'pointer', listStyle: 'none' }}>Paste image URLs instead…</summary>
                <input style={{ ...input, marginTop: 4 }} value={(c.images || []).join(', ')}
                  placeholder="Image URLs, comma-separated (https://…)"
                  onChange={(e) => setCat(i, { images: e.target.value.split(',').map((u) => u.trim()).filter(Boolean).slice(0, 8) })} />
              </details>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                  <input type="checkbox" checked={c.public !== false} onChange={(e) => setCat(i, { public: e.target.checked })} style={{ width: 16, height: 16 }} />
                  Visible to fans
                </label>
                <button type="button" style={{ ...btn, color: 'var(--danger, #b3261e)' }} onClick={() => set({ catalogue: cfg.catalogue.filter((_, j) => j !== i) })}>Remove</button>
              </div>
            </details>
          ))}
          <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => set({ catalogue: [...cfg.catalogue, { label: '', kind: 'ticket', price: '', currency: 'ZAR', deepLink: '', description: '', availability: '', public: true, images: [] }] })}>+ Add item</button>
          {saveBar}
        </>
      )}

      {tab === 'knowledge' && (
        <>
          <p style={small}>Event-wide FAQs & policies that apply everywhere (refunds, age limits, what's allowed in…). Page-specific detail belongs in that page's info box under Sites & pages. Together these are the ONLY sources the Owl may quote — anything not covered gets an honest "I don't know" and logs the gap in Reports. 💡 The <strong>tip</strong> kind is insider gold the Owl may volunteer unprompted when relevant ("the east gate has no queue after 6pm").</p>
          {cfg.knowledge.map((k, i) => (
            <details key={k.id || i} style={{ ...card, paddingTop: 4, paddingBottom: 8 }} open={!k.question && !k.body}>
              <summary style={summaryStyle}>
                {k.question || (k.body ? `${k.body.slice(0, 60)}…` : 'New entry')}{' '}
                <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {k.kind}</span>
              </summary>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 3fr', gap: 8 }}>
                <select style={input} value={k.kind} onChange={(e) => setKnow(i, { kind: e.target.value })}>
                  <option value="faq">FAQ</option><option value="policy">policy</option><option value="info">info</option><option value="tip">💡 tip</option>
                </select>
                <input style={input} value={k.question} placeholder="Question (e.g. What's the refund policy?)" onChange={(e) => setKnow(i, { question: e.target.value })} />
              </div>
              <textarea style={{ ...input, marginTop: 6, resize: 'vertical' }} rows={3} value={k.body} placeholder="The answer, in the organiser's words — the Owl sticks closely to this." onChange={(e) => setKnow(i, { body: e.target.value })} />
              <div style={{ textAlign: 'right', marginTop: 6 }}>
                <button type="button" style={{ ...btn, color: 'var(--danger, #b3261e)' }} onClick={() => set({ knowledge: cfg.knowledge.filter((_, j) => j !== i) })}>Remove</button>
              </div>
            </details>
          ))}
          <button type="button" style={{ ...btn, marginTop: 8 }} onClick={() => set({ knowledge: [...cfg.knowledge, { kind: 'faq', question: '', body: '' }] })}>+ Add entry</button>
          {saveBar}
        </>
      )}

      {tab === 'rewards' && (
        poolsDenied ? <p style={small}>🎁 Rewards ride the <strong>Loyalty & verification</strong> flag (Admin → Product → Flags → Fan Owl) — it's off for this client.</p>
          : !pools ? <p style={small}>Loading reward pools…</p> : (
            <RewardPools pools={pools} setPools={setPools} suites={suites} catalogue={cfg?.catalogue || []} isMobile={isMobile} loyaltyBase={loyaltyBase}
              saving={poolsSaving} savedAt={poolsSavedAt} codesDraft={codesDraft} setCodesDraft={setCodesDraft} codesNote={codesNote}
              onSave={async () => {
                setPoolsSaving(true);
                try {
                  const r = await fetch(`${loyaltyBase}/pools`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pools }) });
                  const d = await r.json();
                  if (r.ok) { setPools(d.pools || []); setPoolsSavedAt(Date.now()); }
                } finally { setPoolsSaving(false); }
              }}
              onUpload={async (i) => {
                const pool = pools[i];
                if (!pool.id || String(pool.id).length < 30) { setCodesNote({ i, text: 'Save the pool first, then upload its codes.' }); return; }
                const r = await fetch(`${loyaltyBase}/pools/${pool.id}/codes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes: codesDraft[i] || '' }) });
                const d = await r.json().catch(() => ({}));
                if (!r.ok) { setCodesNote({ i, text: `⚠️ ${d.error || 'Upload failed.'}` }); return; }
                setPools((ps) => ps.map((p, j) => (j === i ? { ...p, stock: d.stock } : p)));
                setCodesDraft((c) => ({ ...c, [i]: '' }));
                setCodesNote({ i, text: `Added ${d.added} code${d.added === 1 ? '' : 's'} ✓ (${d.stock.available} now available).` });
              }} />
          )
      )}

      {tab === 'reports' && (
        stats ? <Flywheel stats={stats} leads={leads} loadLeads={() => fetch(`${base}/leads`).then((r) => r.json()).then((d) => setLeads(d.leads || [])).catch(() => setLeads([]))} />
          : <p style={small}>Loading reports…</p>
      )}
    </div>
  );
}

// Downscale a picked image to a phone-friendly JPEG data-URL before upload
// (same approach as ReportForm) — keeps the payload under the server's 2MB cap.
function downscaleImage(file, max = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('That file doesn’t look like an image.'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Couldn’t read that file.'));
    reader.readAsDataURL(file);
  });
}

// ── Reward pools editor (loyalty phase 2, spec §5) ───────────────────────────────
// Budgeted pools of promo codes the Owl may grant to VERIFIED fans. Codes are
// generated in the ticketing system; this holds the stock, the target and the
// rules — issuance itself is server-side and one-per-fan.
const REWARD_KINDS_UI = [['discount', '💸 Discount'], ['upgrade', '⬆️ Upgrade'], ['addon', '➕ Add-on'], ['credit_bundle', '🍺 Ticket+credit bundle'], ['merch', '👕 Merch'], ['prize', '🏆 Prize']];
const TIER_OPTS = [['new', 'New (0 events)'], ['returning', 'Returning (1)'], ['loyal', 'Loyal (2–3)'], ['superfan', '👑 Superfan (4+)']];
const SIGNAL_OPTS = [['group_buyer', 'Group buyer (4+)'], ['comp_guest', 'Comp guest'], ['lead_no_purchase', 'Registered, never bought'], ['preregistered', 'Preregistered']];

function RewardPools({ pools, setPools, suites, catalogue, isMobile, loyaltyBase, saving, savedAt, codesDraft, setCodesDraft, codesNote, onSave, onUpload }) {
  const setPool = (i, patch) => setPools(pools.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  // Issued-codes audit per pool: who got which code, their tier, and (once the
  // ticketing redemption feed exists) whether it was redeemed.
  const [grants, setGrants] = useState({}); // pool id → rows | 'loading'
  const loadGrants = (poolId) => {
    if (grants[poolId] && grants[poolId] !== 'error') { setGrants((g) => ({ ...g, [poolId]: undefined })); return; } // toggle closed
    setGrants((g) => ({ ...g, [poolId]: 'loading' }));
    fetch(`${loyaltyBase}/pools/${poolId}/grants`).then((r) => r.json())
      .then((d) => setGrants((g) => ({ ...g, [poolId]: d.grants || [] })))
      .catch(() => setGrants((g) => ({ ...g, [poolId]: 'error' })));
  };
  const burn = (s = {}) => {
    const total = (s.available || 0) + (s.issued || 0);
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    return (
      <div>
        <div style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--hairline)' }}>
          <span style={{ width: `${pct(s.redeemed || 0)}%`, background: 'var(--ok, #12a150)' }} />
          <span style={{ width: `${pct(Math.max(0, (s.issued || 0) - (s.redeemed || 0)))}%`, background: 'var(--brand, #ff385c)' }} />
        </div>
        <div style={{ ...small, marginTop: 4 }}>{s.granted || 0} granted · {s.redeemed || 0} redeemed · <strong>{s.available || 0} left</strong></div>
      </div>
    );
  };
  const checks = (i, list, key) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {list.map(([val, label]) => {
        const arr = pools[i].target?.[key] || [];
        const on = arr.includes(val);
        return (
          <label key={val} style={{ fontSize: 12.5, border: '1px solid var(--hairline)', borderRadius: 999, padding: '6px 11px', cursor: 'pointer', background: on ? 'var(--text)' : 'transparent', color: on ? 'var(--bg, #fff)' : 'var(--text)' }}>
            <input type="checkbox" checked={on} style={{ display: 'none' }}
              onChange={() => setPool(i, { target: { ...pools[i].target, [key]: on ? arr.filter((x) => x !== val) : [...arr, val] } })} />
            {label}
          </label>
        );
      })}
    </div>
  );
  return (
    <>
      <p style={small}>Budgeted pools of promo codes the Owl offers to <strong>verified</strong> fans that match the target — the server grants one per fan and stops dead when the stock runs out. Codes come from the ticketing system (min-quantity, ticket types and expiry are enforced at checkout by the code itself). Empty target = every verified fan qualifies.</p>
      {pools.map((p, i) => (
        <div key={p.id || i} style={{ border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, marginTop: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr 1fr', gap: 8 }}>
            <div>
              <div style={small}>Pool name</div>
              <input style={input} value={p.name} onChange={(e) => setPool(i, { name: e.target.value })} placeholder="e.g. Loyal-fan VIP upgrade" />
            </div>
            <div>
              <div style={small}>Reward kind</div>
              <select style={input} value={p.rewardKind} onChange={(e) => setPool(i, { rewardKind: e.target.value })}>
                {REWARD_KINDS_UI.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <div style={small}>Event (blank = any of yours)</div>
              <select style={input} value={p.suiteId || ''} onChange={(e) => setPool(i, { suiteId: e.target.value })}>
                <option value="">— portfolio-wide —</option>
                {suites.map((su) => <option key={su.id} value={su.id}>{su.name}</option>)}
              </select>
            </div>
            <div>
              <div style={small}>Value (what the fan is told)</div>
              <input style={input} value={p.valueLabel || ''} onChange={(e) => setPool(i, { valueLabel: e.target.value })} placeholder="e.g. 25% off VIP upgrade" />
            </div>
            <div>
              <div style={small}>Expiry (optional)</div>
              <input type="date" style={input} value={(p.rules?.expiresAt || '').slice(0, 10)} onChange={(e) => setPool(i, { rules: { ...p.rules, expiresAt: e.target.value } })} />
            </div>
            <div>
              <div style={small}>Comps</div>
              <select style={input} value={p.rules?.comps || 'count'} onChange={(e) => setPool(i, { rules: { ...p.rules, comps: e.target.value } })}>
                <option value="count">Comp visits count</option>
                <option value="ignore">Paid history only</option>
              </select>
            </div>
            <div>
              <div style={small}>How the code applies (same as campaigns)</div>
              <select style={input} value={p.codeType || 'discount'} onChange={(e) => setPool(i, { codeType: e.target.value })}>
                <option value="discount">🛒 Basket discount — fan copies the code at checkout</option>
                <option value="promo">🎟 Ticket promo — one-tap link (?promo=CODE)</option>
              </select>
            </div>
            {(p.codeType || 'discount') === 'promo' && (
              <div>
                <div style={small}>Ticket the link opens (needs a buy link in the Catalogue)</div>
                <select style={input} value={p.bundleItemId || ''} onChange={(e) => setPool(i, { bundleItemId: e.target.value })}>
                  <option value="">— choose a catalogue item —</option>
                  {(catalogue || []).filter((c) => c.deepLink).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
            )}
          </div>
          {(p.codeType || 'discount') === 'promo' && !p.bundleItemId
            && <p style={{ ...small, color: 'var(--warn, #b3261e)', fontWeight: 700 }}>⚠️ Ticket-promo pools need a catalogue item with a buy link — until one is chosen the card falls back to tap-to-copy.</p>}
          <div style={{ ...small, marginTop: 8 }}>Who qualifies (tier — any ticked matches; each fan sits on ONE rung, so tick every rung you want — Loyal does NOT include Superfans):</div>
          {checks(i, TIER_OPTS, 'tiers')}
          <div style={{ ...small, marginTop: 6 }}>…and must have ALL of (optional):</div>
          {checks(i, SIGNAL_OPTS, 'signals')}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={small}>…and a streak of at least</span>
            <input type="number" min="0" max="30" style={{ ...input, width: 70 }} value={p.rules?.minStreakYears || 0}
              onChange={(e) => setPool(i, { rules: { ...p.rules, minStreakYears: Number(e.target.value) } })} />
            <span style={small}>consecutive years attended (0 = off — e.g. 3 targets the "3 years running" crowd)</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8, marginTop: 10 }}>
            <div>
              <div style={small}>Code mode</div>
              <select style={input} value={p.mode || 'unique'} onChange={(e) => setPool(i, { mode: e.target.value })}>
                <option value="unique">Unique codes (upload a stock — stock = budget)</option>
                <option value="shared">One shared multi-use code (cap the grants)</option>
              </select>
            </div>
            {p.mode === 'shared' ? (
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                <div>
                  <div style={small}>Shared code{p.sharedCodeSet ? ' (set ✓ — retype to change)' : ''}</div>
                  <input style={input} value={p.sharedCode || ''} onChange={(e) => setPool(i, { sharedCode: e.target.value })} placeholder="e.g. BLOOM-EARLY" />
                </div>
                <div>
                  <div style={small}>Grant cap (0 = ∞)</div>
                  <input type="number" min="0" style={input} value={p.grantCap || 0} onChange={(e) => setPool(i, { grantCap: Number(e.target.value) })} />
                </div>
              </div>
            ) : (
              <div>
                <div style={small}>Add codes (paste from ticketing — one per line)</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <textarea style={{ ...input, resize: 'vertical' }} rows={1} value={codesDraft[i] || ''} onChange={(e) => setCodesDraft((c) => ({ ...c, [i]: e.target.value }))} placeholder={'VIP-A1B2\nVIP-C3D4'} />
                  <button type="button" style={btn} onClick={() => onUpload(i)}>Upload</button>
                </div>
              </div>
            )}
          </div>
          {codesNote && codesNote.i === i && <p style={small}>{codesNote.text}</p>}
          {p.active !== false && (p.mode || 'unique') === 'unique' && !(p.stock?.available > 0)
            && <p style={{ ...small, color: 'var(--warn, #b3261e)', fontWeight: 700 }}>⚠️ This pool has NO codes available — the Owl can't offer it. Save the pool, paste the codes, then hit Upload and check the count.</p>}
          {p.active !== false && p.mode === 'shared' && !p.sharedCodeSet && !String(p.sharedCode || '').trim()
            && <p style={{ ...small, color: 'var(--warn, #b3261e)', fontWeight: 700 }}>⚠️ No shared code set — the Owl can't offer this pool until you enter one and Save.</p>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}>{burn(p.stock)}</div>
            {p.id && String(p.id).length > 30 && (p.stock?.granted || 0) > 0
              && <button type="button" style={btn} onClick={() => loadGrants(p.id)}>{grants[p.id] && grants[p.id] !== 'error' ? 'Hide issued codes' : `Issued codes (${p.stock.granted})`}</button>}
            <label style={{ fontSize: 12.5 }}><input type="checkbox" checked={p.active !== false} onChange={(e) => setPool(i, { active: e.target.checked })} /> Active</label>
            <button type="button" style={{ ...btn, color: 'var(--danger, #b3261e)' }} onClick={() => setPools(pools.filter((_, j) => j !== i))}>Delete pool</button>
          </div>
          {grants[p.id] === 'loading' && <p style={small}>Loading issued codes…</p>}
          {grants[p.id] === 'error' && <p style={small}>⚠️ Couldn’t load the issued codes — try again.</p>}
          {Array.isArray(grants[p.id]) && (grants[p.id].length === 0 ? <p style={small}>No codes issued yet.</p> : (
            <div style={{ overflowX: 'auto', marginTop: 8 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 480 }}>
                <thead><tr>{['Fan', 'Tier', 'Code', 'Via', 'When', 'Redeemed'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '5px 10px', borderBottom: '1px solid var(--hairline)', fontWeight: 700 }}>{h}</th>)}</tr></thead>
                <tbody>
                  {grants[p.id].map((g, gi) => (
                    <tr key={gi}>
                      <td style={{ padding: '5px 10px' }}>{g.name ? `${g.name} · ` : ''}{g.email}</td>
                      <td style={{ padding: '5px 10px' }}>{{ new: '🆕', returning: '↻', loyal: '★', superfan: '👑' }[g.tier] || ''} {g.tier}</td>
                      <td style={{ padding: '5px 10px', fontFamily: 'ui-monospace, monospace' }}>{g.code}</td>
                      <td style={{ padding: '5px 10px' }}>{g.surface}</td>
                      <td style={{ padding: '5px 10px', whiteSpace: 'nowrap' }}>{String(g.at || '').slice(0, 10)}</td>
                      <td style={{ padding: '5px 10px' }} title="Redemption tracking arrives with the ticketing feed">{g.redeemedAt ? `✅ ${String(g.redeemedAt).slice(0, 10)}` : '— not yet tracked'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ))}
      <button type="button" style={{ ...btn, marginTop: 10 }} onClick={() => setPools([...pools, { name: '', rewardKind: 'discount', valueLabel: '', target: { tiers: [], signals: [] }, rules: { comps: 'count' }, mode: 'unique', active: true, stock: {} }])}>+ New pool</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <button type="button" style={primaryBtn} disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save reward pools'}</button>
        {savedAt > 0 && Date.now() - savedAt < 4000 && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Saved ✓</span>}
      </div>
    </>
  );
}

function Flywheel({ stats, leads, loadLeads }) {
  const total = useMemo(() => (stats.sites || []).reduce((acc, s) => {
    for (const [k, v] of Object.entries(s.funnel || {})) acc[k] = (acc[k] || 0) + v;
    return acc;
  }, {}), [stats]);
  const topics = useMemo(() => (stats.sites || []).flatMap((s) => s.topics || []).sort((a, b) => b.c - a.c).slice(0, 10), [stats]);
  const navTaps = useMemo(() => (stats.sites || []).flatMap((s) => s.navTaps || []).sort((a, b) => b.c - a.c).slice(0, 10), [stats]);
  const stat = (label, v) => (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 12px', minWidth: 90 }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{v || 0}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</div>
    </div>
  );
  return (
    <div style={{ marginTop: 8 }}>
      <H>Last 30 days</H>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {stat('Ribbon views', total.ribbon_view)}
        {stat('Chats opened', total.chat_open)}
        {stat('Messages', total.chat_message)}
        {stat('Buy clicks', total.deeplink_click)}
        {stat('Nav taps', total.nav_click)}
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
      {navTaps.length > 0 && (
        <>
          <p style={{ ...small, marginTop: 10 }}>Where fans navigated (nav-button taps):</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {navTaps.map((t) => <span key={t.path} style={{ fontSize: 12, border: '1px solid var(--hairline)', borderRadius: 999, padding: '4px 10px', fontFamily: 'ui-monospace, monospace' }}>{t.path} · {t.c}</span>)}
          </div>
        </>
      )}
      <div style={{ marginTop: 10 }}>
        {!leads && <button type="button" style={btn} onClick={loadLeads}>Show captured fans</button>}
        {leads && (leads.length === 0 ? <p style={small}>No fans captured yet.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 480 }}>
              <thead><tr>{['Email', 'Name', 'Verified', 'Tier', 'Marketing opt-in', 'Interests', 'When'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--hairline)', fontWeight: 700 }}>{h}</th>)}</tr></thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td style={{ padding: '6px 10px' }}>{l.email}</td>
                    <td style={{ padding: '6px 10px' }}>{l.name}</td>
                    <td style={{ padding: '6px 10px' }}>{l.verified ? '✅' : '—'}</td>
                    <td style={{ padding: '6px 10px' }}>{l.tier ? { new: '🆕 new', returning: '↻ returning', loyal: '★ loyal', superfan: '👑 superfan' }[l.tier] || l.tier : '—'}</td>
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
