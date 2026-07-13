import { useEffect, useRef, useState } from 'react';

// ─── /embed/fan — the fan-facing Owl (booking guide) inside the widget iframe ──
// Loaded by client/public/fan-owl.js on a promoter's public event site
// (docs/specs/FAN_OWL_SPEC.md). There is NO auth here at all: the fan is
// anonymous, the session id in the URL fragment is the only credential, and the
// server only ever serves published fan data. Mobile-first by construction —
// the widget iframe IS the viewport (full-screen sheet on phones).

const STATUS_RE = /<<<OWL_STATUS>>>([\s\S]*?)<<<\/OWL_STATUS>>>/g;

function splitAnswer(raw) {
  // Stream layout: text … <<<FOLLOWUPS>>>[…] then \n<<<FAN_OFFERS>>>[…] then
  // \n<<<FAN_NAV>>>{…} (server appends offers + nav after the loop returns).
  // Parse back-to-front so each marker's JSON is clean. Strip statuses first.
  let text = String(raw || '').replace(STATUS_RE, '');
  let offers = [];
  let followups = [];
  let nav = null;
  const ni = text.indexOf('<<<FAN_NAV>>>');
  if (ni !== -1) { try { nav = JSON.parse(text.slice(ni + 13)); } catch { /* partial */ } text = text.slice(0, ni); }
  const oi = text.indexOf('<<<FAN_OFFERS>>>');
  if (oi !== -1) { try { offers = JSON.parse(text.slice(oi + 16)); } catch { /* partial */ } text = text.slice(0, oi); }
  const fi = text.indexOf('<<<FOLLOWUPS>>>');
  if (fi !== -1) { try { followups = JSON.parse(text.slice(fi + 15)); } catch { /* partial */ } text = text.slice(0, fi); }
  return { text: text.replace(/\s+$/, ''), offers, followups, nav };
}
const lastStatus = (raw) => { let m; let s = ''; STATUS_RE.lastIndex = 0; while ((m = STATUS_RE.exec(raw))) s = m[1]; return s; };

export default function FanOwlEmbedPage() {
  const [sid] = useState(() => (/[#&]sid=([^&]+)/.exec(window.location.hash || '') || [])[1] || '');
  // "You've moved pages" — greet the fan with the NEW page's context (pill,
  // pitch, offer, starters) instead of just resuming the old thread. Set by the
  // loader's &nav=1 (an Owl-driven hop) or by boot's pageChanged flag (the fan
  // browsed to another page and reopened the chat there).
  const [navArrived, setNavArrived] = useState(() => /[#&]nav=1/.test(window.location.hash || ''));
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState([]); // {role, body, offers?, followups?}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [lead, setLead] = useState(null); // null | 'open' | 'saved'
  const scroller = useRef(null);

  useEffect(() => {
    if (!sid) { setError('Open the assistant from the event website.'); return; }
    fetch(`/api/fan/boot?sid=${encodeURIComponent(sid)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((b) => {
        setBoot(b);
        setMessages((b.messages || []).map((m) => ({ role: m.role, ...splitAnswer(m.body) })));
        if (b.pageChanged && b.page && (b.messages || []).length) setNavArrived(true);
      })
      .catch(() => setError('This session has expired — close and reopen the assistant.'));
  }, [sid]);
  useEffect(() => { scroller.current?.scrollTo({ top: 1e9, behavior: 'smooth' }); }, [messages, busy]);

  const brand = boot?.site?.brandColor || '#111';
  // Scrollable image strip on an offer card (image URLs the promoter supplied).
  const ImageStrip = ({ images }) => {
    const safe = (images || []).filter((u) => /^https?:\/\//i.test(u));
    if (!safe.length) return null;
    return (
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 8, WebkitOverflowScrolling: 'touch', scrollSnapType: 'x mandatory' }}>
        {safe.map((u) => (
          <img key={u} src={u} alt="" loading="lazy"
            style={{ height: 110, maxWidth: 200, objectFit: 'cover', borderRadius: 10, flex: '0 0 auto', scrollSnapAlign: 'start' }} />
        ))}
      </div>
    );
  };
  const close = () => { try { window.parent.postMessage('howler-fan-owl:close', '*'); } catch { /* not framed */ } };
  // "Take me there": hand the destination path to the parent loader, which
  // resolves it against the HOST site's origin and navigates — the chat reopens
  // on the new page with its context.
  const goTo = (nav) => {
    fetch('/api/fan/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, kind: 'nav_click', payload: { path: nav.path, pageType: nav.pageType } }) }).catch(() => {});
    try { window.parent.postMessage({ t: 'howler-fan-owl:nav', path: nav.path }, '*'); } catch { /* not framed */ }
  };
  const pageLabel = (p) => (p.note || `the ${p.pageType} page`).slice(0, 60);
  const clickOffer = (o) => {
    fetch('/api/fan/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid, kind: 'deeplink_click', payload: { itemId: o.id, label: o.label } }) }).catch(() => {});
    window.open(o.url, '_blank', 'noopener');
  };

  async function send(text) {
    const message = String(text || '').trim();
    if (!message || busy) return;
    setInput('');
    setNavArrived(false);
    setBusy(true);
    setStatus('Thinking…');
    setMessages((m) => [...m, { role: 'user', text: message }, { role: 'owl', text: '', streaming: true }]);
    try {
      const r = await fetch('/api/fan/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, message }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || 'The Owl hit a snag — try again.');
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let raw = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
        const s = lastStatus(raw);
        if (s) setStatus(s);
        const parts = splitAnswer(raw);
        setMessages((m) => [...m.slice(0, -1), { role: 'owl', ...parts, streaming: true }]);
      }
      const parts = splitAnswer(raw);
      setMessages((m) => [...m.slice(0, -1), { role: 'owl', ...parts }]);
    } catch (e) {
      setMessages((m) => [...m.slice(0, -1), { role: 'owl', text: e.message || 'The Owl hit a snag — try again.' }]);
    } finally { setBusy(false); setStatus(''); }
  }

  async function saveLead(form) {
    const r = await fetch('/api/fan/lead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, ...form }),
    });
    if (r.ok) setLead('saved');
    else { const e = await r.json().catch(() => ({})); alert(e.error || 'That didn’t save — check the email address.'); }
  }

  if (error) {
    return (
      <div style={S.center}>
        <span style={{ fontSize: 34 }}>🦉</span>
        <p style={{ margin: 0, fontSize: 14.5, maxWidth: 300, lineHeight: 1.5, textAlign: 'center' }}>{error}</p>
      </div>
    );
  }
  if (!boot) return <div style={S.center}>🦉 One sec…</div>;

  const latest = messages[messages.length - 1];
  // Suggested pills are ALWAYS on offer: right after an Owl reply its follow-ups
  // lead; any other time (fresh open, reopened thread, page hop) the CURRENT
  // page's starters show, so every page invites its own questions.
  const chips = busy ? []
    : (navArrived ? (boot.starters || [])
      : (latest?.role === 'owl' && (latest.followups || []).length ? latest.followups : (boot.starters || [])));

  return (
    <div style={S.shell}>
      <header style={{ ...S.header, background: brand }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 20 }}>🦉</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{boot.event?.name || boot.site?.name || 'Event guide'}</div>
            <div style={{ fontSize: 11.5, opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {boot.page ? <>📍 {pageLabel(boot.page)}</> : 'Your ticket guide'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" style={S.hBtn} title="Keep me posted" aria-label="Keep me posted" onClick={() => setLead(lead === 'saved' ? 'saved' : 'open')}>🔔</button>
          <button type="button" style={S.hBtn} aria-label="Close" onClick={close}>✕</button>
        </div>
      </header>

      <div ref={scroller} style={S.scroll}>
        {!messages.length && (
          <div style={S.hello}>
            <div style={{ fontSize: 30, marginBottom: 6 }}>🦉</div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Hey! I know this event inside out.</div>
            <div style={{ fontSize: 13.5, opacity: 0.75 }}>{boot.pitch || 'Ask me anything — which ticket you need, what’s included, how to add extras.'}</div>
            {boot.offer && (
              <div style={{ ...S.offerCard, marginTop: 14 }}>
                <div style={{ fontWeight: 700 }}>{boot.offer.label}</div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {boot.offer.price ? `${boot.offer.currency} ${boot.offer.price}` : 'See tickets'}
                  {boot.offer.availability ? ` · ${boot.offer.availability}` : ''}
                </div>
                <ImageStrip images={boot.offer.images} />
                <button type="button" style={{ ...S.cta, background: brand }} onClick={() => send(`Tell me about ${boot.offer.label}`)}>Tell me more</button>
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={m.role === 'user' ? { ...S.bubble, ...S.mine, background: brand } : { ...S.bubble, ...S.theirs }}>
              {m.text || (m.streaming ? <span style={{ opacity: 0.6 }}>{status || 'Thinking…'}</span> : '')}
            </div>
            {(m.offers || []).map((o) => (
              <div key={o.id} style={S.offerCard}>
                <div style={{ fontWeight: 700 }}>{o.label}</div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {o.price ? `${o.currency} ${o.price}` : ''}
                  {o.availability ? ` · ${o.availability}` : ''}
                </div>
                <ImageStrip images={o.images} />
                <button type="button" style={{ ...S.cta, background: brand }} onClick={() => clickOffer(o)}>Get tickets ↗</button>
              </div>
            ))}
            {m.nav && !m.streaming && (
              <div style={S.offerCard}>
                <div style={{ fontWeight: 700 }}>📍 {pageLabel(m.nav)}</div>
                {m.nav.note && <div style={{ fontSize: 13, opacity: 0.8 }}>{m.nav.path}</div>}
                <button type="button" style={{ ...S.cta, background: brand }} onClick={() => goTo(m.nav)}>Take me there →</button>
              </div>
            )}
          </div>
        ))}
        {navArrived && boot.page && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ alignSelf: 'center', fontSize: 12.5, color: '#888', padding: '2px 8px' }}>
              📍 You’re now on {pageLabel(boot.page)} — ask me anything about it
            </div>
            {boot.pitch && <div style={{ ...S.bubble, ...S.theirs }}>{boot.pitch}</div>}
            {boot.offer && (
              <div style={S.offerCard}>
                <div style={{ fontWeight: 700 }}>{boot.offer.label}</div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {boot.offer.price ? `${boot.offer.currency} ${boot.offer.price}` : 'See tickets'}
                  {boot.offer.availability ? ` · ${boot.offer.availability}` : ''}
                </div>
                <ImageStrip images={boot.offer.images} />
                <button type="button" style={{ ...S.cta, background: brand }} onClick={() => send(`Tell me about ${boot.offer.label}`)}>Tell me more</button>
              </div>
            )}
          </div>
        )}
        {chips.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {chips.map((c) => (
              <button key={c} type="button" style={S.chip} onClick={() => send(c)}>{c}</button>
            ))}
          </div>
        )}
      </div>

      {lead === 'open' && <LeadSheet brand={brand} onSave={saveLead} onClose={() => setLead(null)} />}
      {lead === 'saved' && (
        <div style={S.savedNote}>✅ You’re on the list — we’ll keep you posted.</div>
      )}

      <form
        style={S.composer}
        onSubmit={(e) => { e.preventDefault(); send(input); }}
      >
        <input
          style={S.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about tickets…"
          aria-label="Message"
        />
        <button type="submit" disabled={busy || !input.trim()} style={{ ...S.send, background: brand, opacity: busy || !input.trim() ? 0.5 : 1 }}>↑</button>
      </form>
      <div style={S.foot}>Powered by Howler 🦉</div>
    </div>
  );
}

// The consent form: explicit, unticked-by-default marketing opt-in (POPIA/GDPR —
// spec §6b). The chat works fully without it; this is only ever a favour.
function LeadSheet({ brand, onSave, onClose }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div style={S.sheet}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 14.5 }}>Keep me posted</strong>
        <button type="button" style={{ ...S.hBtn, color: '#666' }} aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave({ name, email, marketingConsent: consent }); } finally { setBusy(false); } }}>
        <input style={{ ...S.input, width: '100%', marginBottom: 8 }} placeholder="Your name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ ...S.input, width: '100%', marginBottom: 8 }} type="email" required placeholder="Your email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45, marginBottom: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 2, width: 16, height: 16 }} />
          <span>Email me updates and offers about this event. You can unsubscribe any time.</span>
        </label>
        <button type="submit" disabled={busy || !email} style={{ ...S.cta, background: brand, width: '100%', opacity: busy || !email ? 0.6 : 1 }}>Save</button>
      </form>
    </div>
  );
}

const S = {
  center: { minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, fontFamily: '-apple-system, system-ui, sans-serif', color: '#333', background: '#fff' },
  shell: { height: '100dvh', display: 'flex', flexDirection: 'column', background: '#fff', color: '#141414', fontFamily: '-apple-system, system-ui, sans-serif' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '12px 12px 12px 14px', color: '#fff' },
  hBtn: { width: 34, height: 34, border: 0, borderRadius: 10, background: 'rgba(255,255,255,.16)', color: 'inherit', fontSize: 15, cursor: 'pointer' },
  scroll: { flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 },
  hello: { textAlign: 'center', padding: '18px 8px 6px' },
  bubble: { maxWidth: '85%', padding: '9px 13px', borderRadius: 16, fontSize: 14.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  mine: { color: '#fff', borderBottomRightRadius: 5 },
  theirs: { background: '#f2f2f4', borderBottomLeftRadius: 5 },
  offerCard: { border: '1px solid #e8e8ec', borderRadius: 14, padding: '12px 14px', marginTop: 8, width: '85%', maxWidth: 300, background: '#fff', boxShadow: '0 3px 14px rgba(0,0,0,.05)', textAlign: 'left' },
  cta: { marginTop: 10, border: 0, borderRadius: 10, color: '#fff', fontWeight: 700, fontSize: 14, padding: '10px 14px', cursor: 'pointer', minHeight: 40 },
  chip: { border: '1px solid #ddd', background: '#fff', borderRadius: 999, padding: '8px 13px', fontSize: 13, cursor: 'pointer', minHeight: 36 },
  composer: { display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid #eee' },
  input: { flex: 1, border: '1px solid #ddd', borderRadius: 12, padding: '10px 12px', fontSize: 15, outline: 'none', minHeight: 40, boxSizing: 'border-box' },
  send: { width: 42, height: 42, border: 0, borderRadius: 12, color: '#fff', fontSize: 18, cursor: 'pointer' },
  foot: { textAlign: 'center', fontSize: 10.5, color: '#999', padding: '0 0 7px' },
  sheet: { borderTop: '1px solid #eee', padding: '12px 14px', background: '#fafafa' },
  savedNote: { padding: '10px 14px', fontSize: 13.5, background: '#f0faf2', borderTop: '1px solid #d8eedd', color: '#1d6b34' },
};
