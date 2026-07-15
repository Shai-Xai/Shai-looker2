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

// ── Widget UI strings, localised. The chat itself follows the fan's language via
// the model; these are the deterministic bits around it. Picked from the fan's
// device language, else the site's configured default, else English. Promoter-
// written content (pitch, intro, starters, FAQs) is never machine-translated.
const LOCALES = {
  en: { guide: 'Your ticket guide', hello: "Hey! I'm {name} — I know this event inside out.", helloSub: 'Ask me anything — which ticket you need, what’s included, how to add extras.', owl: 'the Owl', seeTickets: 'See tickets', tellMore: 'Tell me more', getTickets: 'Get tickets ↗', takeMe: 'Take me there →', nowOn: 'You’re now on {page} — ask me anything about it', ask: 'Ask about tickets…', starters: ['Which ticket do I need?', 'What’s included?', 'Refund policy?'], keepPosted: 'Keep me posted', namePh: 'Your name (optional)', emailPh: 'Your email', consent: 'Email me updates and offers about this event. You can unsubscribe any time.', save: 'Save', saved: '✅ You’re on the list — we’ll keep you posted.', askOn: 'Ask about {t}…', topics: { home: 'the event', tickets: 'tickets', lineup: 'the line-up', artist: 'the artists', venue: 'the venue', accommodation: 'where to stay', attraction: 'what to do', sponsors: 'our partners', faq: 'the details', other: 'this page' } },
  af: { guide: 'Jou kaartjiegids', hello: 'Haai! Ek is {name} — ek ken hierdie geleentheid deur en deur.', helloSub: 'Vra my enigiets — watter kaartjie jy nodig het, wat ingesluit is, hoe om ekstras by te voeg.', owl: 'die Uil', seeTickets: 'Sien kaartjies', tellMore: 'Vertel my meer', getTickets: 'Kry kaartjies ↗', takeMe: 'Vat my soontoe →', nowOn: 'Jy is nou op {page} — vra my enigiets daaroor', ask: 'Vra oor kaartjies…', starters: ['Watter kaartjie het ek nodig?', 'Wat is ingesluit?', 'Terugbetalingsbeleid?'], keepPosted: 'Hou my op hoogte', namePh: 'Jou naam (opsioneel)', emailPh: 'Jou e-pos', consent: 'E-pos my opdaterings en aanbiedinge oor hierdie geleentheid. Jy kan enige tyd uitteken.', save: 'Stoor', saved: '✅ Jy is op die lys — ons hou jou op hoogte.', askOn: 'Vra oor {t}…', topics: { home: 'die geleentheid', tickets: 'kaartjies', lineup: 'die program', artist: 'die kunstenaars', venue: 'die venue', accommodation: 'verblyf', attraction: 'wat om te doen', sponsors: 'ons vennote', faq: 'die besonderhede', other: 'hierdie bladsy' } },
  it: { guide: 'La tua guida ai biglietti', hello: 'Ciao! Sono {name} — conosco questo evento alla perfezione.', helloSub: 'Chiedimi qualsiasi cosa — quale biglietto ti serve, cosa è incluso, come aggiungere extra.', owl: 'il Gufo', seeTickets: 'Vedi i biglietti', tellMore: 'Dimmi di più', getTickets: 'Prendi i biglietti ↗', takeMe: 'Portami lì →', nowOn: 'Ora sei su {page} — chiedimi quello che vuoi', ask: 'Chiedi sui biglietti…', starters: ['Quale biglietto mi serve?', 'Cosa è incluso?', 'Politica di rimborso?'], keepPosted: 'Tienimi aggiornato', namePh: 'Il tuo nome (facoltativo)', emailPh: 'La tua email', consent: 'Inviami aggiornamenti e offerte su questo evento via email. Puoi disiscriverti in qualsiasi momento.', save: 'Salva', saved: '✅ Sei in lista — ti terremo aggiornato.', askOn: 'Domande su {t}…', topics: { home: 'l’evento', tickets: 'i biglietti', lineup: 'la line-up', artist: 'gli artisti', venue: 'la location', accommodation: 'l’alloggio', attraction: 'cosa fare', sponsors: 'i partner', faq: 'i dettagli', other: 'questa pagina' } },
  es: { guide: 'Tu guía de entradas', hello: '¡Hola! Soy {name} — conozco este evento al dedillo.', helloSub: 'Pregúntame lo que sea — qué entrada necesitas, qué incluye, cómo añadir extras.', owl: 'el Búho', seeTickets: 'Ver entradas', tellMore: 'Cuéntame más', getTickets: 'Comprar entradas ↗', takeMe: 'Llévame allí →', nowOn: 'Ahora estás en {page} — pregúntame lo que quieras', ask: 'Pregunta sobre entradas…', starters: ['¿Qué entrada necesito?', '¿Qué incluye?', '¿Política de reembolso?'], keepPosted: 'Mantenme informado', namePh: 'Tu nombre (opcional)', emailPh: 'Tu email', consent: 'Envíame novedades y ofertas de este evento por email. Puedes darte de baja cuando quieras.', save: 'Guardar', saved: '✅ Estás en la lista — te mantendremos informado.', askOn: 'Pregunta sobre {t}…', topics: { home: 'el evento', tickets: 'las entradas', lineup: 'el cartel', artist: 'los artistas', venue: 'el recinto', accommodation: 'dónde alojarte', attraction: 'qué hacer', sponsors: 'nuestros partners', faq: 'los detalles', other: 'esta página' } },
  fr: { guide: 'Votre guide billetterie', hello: 'Salut ! Je suis {name} — je connais cet événement par cœur.', helloSub: 'Demandez-moi tout — quel billet il vous faut, ce qui est inclus, comment ajouter des extras.', owl: 'le Hibou', seeTickets: 'Voir les billets', tellMore: 'Dites-m’en plus', getTickets: 'Obtenir des billets ↗', takeMe: 'Emmenez-moi →', nowOn: 'Vous êtes maintenant sur {page} — posez-moi vos questions', ask: 'Une question billets ?…', starters: ['Quel billet me faut-il ?', 'Qu’est-ce qui est inclus ?', 'Politique de remboursement ?'], keepPosted: 'Tenez-moi informé', namePh: 'Votre nom (facultatif)', emailPh: 'Votre email', consent: 'Envoyez-moi des nouvelles et offres de cet événement par email. Désinscription possible à tout moment.', save: 'Enregistrer', saved: '✅ Vous êtes sur la liste — on vous tient au courant.', askOn: 'Une question sur {t} ?…', topics: { home: 'l’événement', tickets: 'les billets', lineup: 'la programmation', artist: 'les artistes', venue: 'le lieu', accommodation: 'où loger', attraction: 'quoi faire', sponsors: 'nos partenaires', faq: 'les détails', other: 'cette page' } },
  de: { guide: 'Dein Ticket-Guide', hello: 'Hey! Ich bin {name} — ich kenne dieses Event in- und auswendig.', helloSub: 'Frag mich alles — welches Ticket du brauchst, was enthalten ist, wie du Extras dazubuchst.', owl: 'die Eule', seeTickets: 'Tickets ansehen', tellMore: 'Erzähl mir mehr', getTickets: 'Tickets holen ↗', takeMe: 'Bring mich hin →', nowOn: 'Du bist jetzt auf {page} — frag mich alles dazu', ask: 'Frag zu Tickets…', starters: ['Welches Ticket brauche ich?', 'Was ist enthalten?', 'Rückerstattung?'], keepPosted: 'Halt mich auf dem Laufenden', namePh: 'Dein Name (optional)', emailPh: 'Deine E-Mail', consent: 'Schick mir Updates und Angebote zu diesem Event per E-Mail. Jederzeit abbestellbar.', save: 'Speichern', saved: '✅ Du bist auf der Liste — wir halten dich auf dem Laufenden.', askOn: 'Frag zu {t}…', topics: { home: 'dem Event', tickets: 'Tickets', lineup: 'dem Line-up', artist: 'den Artists', venue: 'dem Gelände', accommodation: 'Unterkünften', attraction: 'Aktivitäten', sponsors: 'unseren Partnern', faq: 'den Details', other: 'dieser Seite' } },
  pt: { guide: 'O seu guia de bilhetes', hello: 'Olá! Sou {name} — conheço este evento de trás para a frente.', helloSub: 'Pergunte-me qualquer coisa — que bilhete precisa, o que está incluído, como juntar extras.', owl: 'o Mocho', seeTickets: 'Ver bilhetes', tellMore: 'Conte-me mais', getTickets: 'Comprar bilhetes ↗', takeMe: 'Leva-me lá →', nowOn: 'Está agora em {page} — pergunte-me o que quiser', ask: 'Pergunte sobre bilhetes…', starters: ['Que bilhete preciso?', 'O que está incluído?', 'Política de reembolso?'], keepPosted: 'Mantenha-me informado', namePh: 'O seu nome (opcional)', emailPh: 'O seu email', consent: 'Envie-me novidades e ofertas deste evento por email. Pode cancelar a qualquer momento.', save: 'Guardar', saved: '✅ Está na lista — vamos mantê-lo informado.', askOn: 'Pergunte sobre {t}…', topics: { home: 'o evento', tickets: 'bilhetes', lineup: 'o cartaz', artist: 'os artistas', venue: 'o recinto', accommodation: 'onde ficar', attraction: 'o que fazer', sponsors: 'os parceiros', faq: 'os detalhes', other: 'esta página' } },
  nl: { guide: 'Jouw ticketgids', hello: 'Hoi! Ik ben {name} — ik ken dit evenement door en door.', helloSub: 'Vraag me alles — welk ticket je nodig hebt, wat inbegrepen is, hoe je extra’s toevoegt.', owl: 'de Uil', seeTickets: 'Bekijk tickets', tellMore: 'Vertel me meer', getTickets: 'Koop tickets ↗', takeMe: 'Breng me erheen →', nowOn: 'Je bent nu op {page} — vraag me er alles over', ask: 'Vraag over tickets…', starters: ['Welk ticket heb ik nodig?', 'Wat is inbegrepen?', 'Terugbetalingsbeleid?'], keepPosted: 'Houd me op de hoogte', namePh: 'Je naam (optioneel)', emailPh: 'Je e-mail', consent: 'Mail me updates en aanbiedingen over dit evenement. Je kunt je altijd uitschrijven.', save: 'Opslaan', saved: '✅ Je staat op de lijst — we houden je op de hoogte.', askOn: 'Vraag over {t}…', topics: { home: 'het evenement', tickets: 'tickets', lineup: 'de line-up', artist: 'de artiesten', venue: 'de locatie', accommodation: 'overnachten', attraction: 'wat te doen', sponsors: 'onze partners', faq: 'de details', other: 'deze pagina' } },
};
const localeFor = (bootLang) => LOCALES[(navigator.language || '').slice(0, 2).toLowerCase()] || LOCALES[String(bootLang || '').slice(0, 2).toLowerCase()] || LOCALES.en;

// ── Quick-nav buttons (per-site nav styles: top strip / + menu / pills). One
// icon + short label per page type; the button list itself comes from boot.nav.
const NAV_LABELS = { home: 'Home', tickets: 'Tickets', lineup: 'Line-up', artist: 'Artists', venue: 'Venue', accommodation: 'Stay', attraction: 'Explore', sponsors: 'Partners', faq: 'FAQs', other: 'More' };
const NAV_PATHS = {
  home: <><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10.5V20h13v-9.5" /></>,
  tickets: <><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" /><path d="M13.5 6v2m0 3v2m0 3v2" strokeDasharray="1.5 3" /></>,
  lineup: <><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></>,
  artist: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1.2-3.4 3.8-5 7-5s5.8 1.6 7 5" /></>,
  venue: <><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></>,
  accommodation: <><path d="M12 4 3 18h18L12 4Z" /><path d="M12 10 8.5 18h7L12 10Z" /></>,
  attraction: <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z" />,
  sponsors: <><circle cx="12" cy="12" r="8" /><path d="M8.5 12h7M12 8.5v7" /></>,
  faq: <><circle cx="12" cy="12" r="8" /><path d="M9.5 9.5c.4-1.2 1.3-2 2.5-2 1.4 0 2.5 1 2.5 2.3 0 1.6-2 1.9-2 3.2" /><circle cx="12" cy="16.6" r=".4" fill="currentColor" /></>,
  other: <><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></>,
};
const NavIcon = ({ t, size = 19 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {NAV_PATHS[t] || NAV_PATHS.other}
  </svg>
);
const navLabel = (n) => NAV_LABELS[n.pageType] || NAV_LABELS.other;

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
  const [navOpen, setNavOpen] = useState(false); // the + menu (navStyle 'plus')
  const [expanded, setExpanded] = useState(false); // desktop wide view (parent resizes)
  const isMobileFrame = /[#&]m=1/.test(window.location.hash || '');
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
  const T = localeFor(boot?.lang); // widget UI strings in the fan's language
  // Widget theme: the site's explicit choice, else the fan's device preference.
  const dark = boot?.site?.theme === 'dark'
    || (boot?.site?.theme !== 'light' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const C = dark
    ? { bg: '#141417', ink: '#ececf0', muted: '#94949c', theirs: '#232329', card: '#1d1d22', line: '#2c2c31', chipBg: '#1d1d22', chipLine: '#3b3b41', inputBg: '#1a1a1e', savedBg: '#12241a', savedLine: '#1e3a2a', savedInk: '#7fd49a', sheetBg: '#18181c' }
    : { bg: '#fff', ink: '#141414', muted: '#999', theirs: '#f2f2f4', card: '#fff', line: '#eee', chipBg: '#fff', chipLine: '#ddd', inputBg: '#fff', savedBg: '#f0faf2', savedLine: '#d8eedd', savedInk: '#1d6b34', sheetBg: '#fafafa' };
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
  const toggleExpand = () => {
    const on = !expanded;
    setExpanded(on);
    try { window.parent.postMessage({ t: 'howler-fan-owl:expand', on }, '*'); } catch { /* not framed */ }
  };
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
  const pageChips = (boot.starters || []).length ? boot.starters : T.starters;
  // The composer invites questions about THIS page ("Ask about the line-up…").
  const askPh = boot.page && T.askOn && T.topics
    ? T.askOn.replace('{t}', T.topics[boot.page.pageType] || T.topics.other)
    : T.ask;
  const nav = boot.nav || [];
  const navStyle = nav.length ? (boot.navStyle === 'top' || !boot.navStyle ? 'top' : boot.navStyle) : 'off';
  // Centred pills that still scroll fully when they overflow: centring the inner
  // max-content row (not the scroller itself) keeps the leading pills reachable.
  const navIco = (n, size) => (n.emoji ? <span style={{ fontSize: size, lineHeight: 1 }} aria-hidden>{n.emoji}</span> : <NavIcon t={n.pageType} size={size} />);
  const navText = (n) => n.label || navLabel(n);
  const navPillRow = (pad) => (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', padding: pad }}>
      <div style={{ display: 'flex', gap: 8, width: 'max-content', margin: '0 auto' }}>
        {nav.map((n) => (
          <button key={n.path} type="button" title={n.note || navText(n)} onClick={() => goTo(n)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flex: '0 0 auto', cursor: 'pointer', border: `1px solid ${n.active ? brand : C.chipLine}`, background: n.active ? brand : C.chipBg, color: n.active ? '#fff' : C.ink, borderRadius: 999, padding: '8px 13px', fontSize: 12.5, fontWeight: 600, minHeight: 36 }}>
            {navIco(n, 15)}{navText(n)}
          </button>
        ))}
      </div>
    </div>
  );
  const navBtnStyle = (n, size = 40) => ({
    width: size, height: size, borderRadius: '50%', flex: '0 0 auto', cursor: 'pointer',
    border: `1px solid ${n.active ? brand : C.chipLine}`, background: n.active ? brand : C.chipBg,
    color: n.active ? '#fff' : C.ink, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  });
  const chips = busy ? []
    : (navArrived ? pageChips
      : (latest?.role === 'owl' && (latest.followups || []).length ? latest.followups : pageChips));

  return (
    <div style={{ ...S.shell, background: C.bg, color: C.ink }}>
      <header style={{ ...S.header, background: brand }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {boot.site?.owlAvatar
            ? <img src={boot.site.owlAvatar} alt="" style={{ width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flex: '0 0 auto' }} />
            : <span style={{ fontSize: 20 }}>🦉</span>}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{boot.site?.owlName || boot.event?.name || boot.site?.name || 'Event guide'}</div>
            <div style={{ fontSize: 11.5, opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {boot.page ? <>📍 {pageLabel(boot.page)}</> : T.guide}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {!isMobileFrame && (
            <button type="button" style={S.hBtn} title={expanded ? 'Smaller' : 'Expand'} aria-label={expanded ? 'Smaller' : 'Expand'} onClick={toggleExpand}>{expanded ? '⤡' : '⤢'}</button>
          )}
          <button type="button" style={S.hBtn} title="Keep me posted" aria-label="Keep me posted" onClick={() => setLead(lead === 'saved' ? 'saved' : 'open')}>🔔</button>
          <button type="button" style={S.hBtn} aria-label="Close" onClick={close}>✕</button>
        </div>
      </header>

      {navStyle === 'top' && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderBottom: `1px solid ${C.line}`, background: C.sheetBg, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {nav.map((n) => (
            <button key={n.path} type="button" title={n.note || navText(n)} aria-label={navText(n)}
              style={navBtnStyle(n)} onClick={() => goTo(n)}>
              {navIco(n, 19)}
            </button>
          ))}
        </div>
      )}

      <div ref={scroller} style={S.scroll}>
        {!messages.length && !(navArrived && boot.page) && (
          <div style={S.hello}>
            {boot.site?.owlAvatar
              ? <img src={boot.site.owlAvatar} alt="" style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover', marginBottom: 6 }} />
              : <div style={{ fontSize: 30, marginBottom: 6 }}>🦉</div>}
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{boot.site?.owlIntro || T.hello.replace('{name}', boot.site?.owlName || T.owl)}</div>
            <div style={{ fontSize: 13.5, opacity: 0.75 }}>{boot.pitch || T.helloSub}</div>
            {boot.offer && (
              <div style={{ ...S.offerCard, marginTop: 14, background: C.card, border: `1px solid ${C.line}` }}>
                <div style={{ fontWeight: 700 }}>{boot.offer.label}</div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {boot.offer.price ? `${boot.offer.currency} ${boot.offer.price}` : T.seeTickets}
                  {boot.offer.availability ? ` · ${boot.offer.availability}` : ''}
                </div>
                <ImageStrip images={boot.offer.images} />
                <button type="button" style={{ ...S.cta, background: brand }} onClick={() => send(`Tell me about ${boot.offer.label}`)}>{T.tellMore}</button>
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={m.role === 'user' ? { ...S.bubble, ...S.mine, background: brand } : { ...S.bubble, ...S.theirs, background: C.theirs }}>
              {m.text || (m.streaming ? <span style={{ opacity: 0.6 }}>{status || 'Thinking…'}</span> : '')}
            </div>
            {(m.offers || []).map((o) => (
              <div key={o.id} style={{ ...S.offerCard, background: C.card, border: `1px solid ${C.line}` }}>
                <div style={{ fontWeight: 700 }}>{o.label}</div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {o.price ? `${o.currency} ${o.price}` : ''}
                  {o.availability ? ` · ${o.availability}` : ''}
                </div>
                <ImageStrip images={o.images} />
                <button type="button" style={{ ...S.cta, background: brand }} onClick={() => clickOffer(o)}>{T.getTickets}</button>
              </div>
            ))}
            {m.nav && !m.streaming && (
              <div style={{ ...S.offerCard, background: C.card, border: `1px solid ${C.line}` }}>
                <div style={{ fontWeight: 700 }}>📍 {pageLabel(m.nav)}</div>
                {m.nav.note && <div style={{ fontSize: 13, opacity: 0.8 }}>{m.nav.path}</div>}
                <button type="button" style={{ ...S.cta, background: brand }} onClick={() => goTo(m.nav)}>{T.takeMe}</button>
              </div>
            )}
          </div>
        ))}
        {navArrived && boot.page && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ alignSelf: 'center', fontSize: 12.5, color: '#888', padding: '2px 8px' }}>
              📍 {T.nowOn.replace('{page}', pageLabel(boot.page))}
            </div>
            {boot.pitch && <div style={{ ...S.bubble, ...S.theirs, background: C.theirs }}>{boot.pitch}</div>}
            {boot.offer && (
              <div style={{ ...S.offerCard, background: C.card, border: `1px solid ${C.line}` }}>
                <div style={{ fontWeight: 700 }}>{boot.offer.label}</div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>
                  {boot.offer.price ? `${boot.offer.currency} ${boot.offer.price}` : T.seeTickets}
                  {boot.offer.availability ? ` · ${boot.offer.availability}` : ''}
                </div>
                <ImageStrip images={boot.offer.images} />
                <button type="button" style={{ ...S.cta, background: brand }} onClick={() => send(`Tell me about ${boot.offer.label}`)}>{T.tellMore}</button>
              </div>
            )}
          </div>
        )}
        {chips.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {chips.map((c) => (
              <button key={c} type="button" style={{ ...S.chip, background: C.chipBg, border: `1px solid ${C.chipLine}`, color: C.ink }} onClick={() => send(c)}>{c}</button>
            ))}
          </div>
        )}
      </div>

      {lead === 'open' && <LeadSheet brand={brand} T={T} C={C} onSave={saveLead} onClose={() => setLead(null)} />}
      {lead === 'saved' && (
        <div style={{ ...S.savedNote, background: C.savedBg, borderTop: `1px solid ${C.savedLine}`, color: C.savedInk }}>{T.saved}</div>
      )}

      {navStyle === 'pills' && navPillRow('8px 12px 10px')}
      <form
        style={{ ...S.composer, borderTop: `1px solid ${C.line}`, position: 'relative' }}
        onSubmit={(e) => { e.preventDefault(); send(input); }}
      >
        {navStyle === 'plus' && navOpen && (
          <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 10, right: 10, maxWidth: 340, background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 6, boxShadow: '0 14px 40px rgba(0,0,0,.25)', zIndex: 5 }}>
            {nav.map((n) => (
              <button key={n.path} type="button" onClick={() => { setNavOpen(false); goTo(n); }}
                style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', border: 0, background: 'transparent', color: C.ink, borderRadius: 10, padding: '9px 10px', cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}>
                <span style={navBtnStyle(n, 32)}>{navIco(n, 15)}</span>
                {navText(n)}
                {n.note && <span style={{ fontWeight: 400, color: C.muted, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.note}</span>}
              </button>
            ))}
          </div>
        )}
        {navStyle === 'plus' && (
          <button type="button" aria-label="Site navigation" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}
            style={{ width: 46, height: 46, borderRadius: '50%', flex: '0 0 auto', cursor: 'pointer', border: `1px solid ${C.chipLine}`, background: navOpen ? brand : C.chipBg, color: navOpen ? '#fff' : C.ink, fontSize: 20, fontWeight: 300, lineHeight: 1 }}>+</button>
        )}
        {/* The design's pill composer: accent ring, ✦ spark, round send inside. */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 9, border: `1.5px solid ${brand}`, borderRadius: 999, padding: '4px 4px 4px 14px', background: C.inputBg, minHeight: 46, boxSizing: 'border-box' }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: '0 0 auto' }}>
            <path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2m0-12-2 2M8 16l-2 2" />
          </svg>
          <input
            style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', color: C.ink, fontSize: 15, padding: '8px 0' }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={askPh}
            aria-label="Message"
          />
          <button type="submit" disabled={busy || !input.trim()}
            style={{ width: 36, height: 36, border: 0, borderRadius: '50%', flex: '0 0 auto', background: brand, color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: busy || !input.trim() ? 0.5 : 1 }}>↑</button>
        </div>
      </form>
      {navStyle === 'below' && navPillRow('10px 12px 8px')}
      <div style={{ ...S.foot, color: C.muted }}>Powered by Howler <img src="/email-howler.png" alt="" style={{ height: 13, width: 13, borderRadius: '50%', verticalAlign: -2.5 }} /></div>
    </div>
  );
}

// The consent form: explicit, unticked-by-default marketing opt-in (POPIA/GDPR —
// spec §6b). The chat works fully without it; this is only ever a favour.
function LeadSheet({ brand, T, C, onSave, onClose }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ ...S.sheet, background: C.sheetBg, borderTop: `1px solid ${C.line}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong style={{ fontSize: 14.5 }}>{T.keepPosted}</strong>
        <button type="button" style={{ ...S.hBtn, color: C.muted, background: 'transparent' }} aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSave({ name, email, marketingConsent: consent }); } finally { setBusy(false); } }}>
        <input style={{ ...S.input, width: '100%', marginBottom: 8, background: C.inputBg, color: C.ink, border: `1px solid ${C.chipLine}` }} placeholder={T.namePh} value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ ...S.input, width: '100%', marginBottom: 8, background: C.inputBg, color: C.ink, border: `1px solid ${C.chipLine}` }} type="email" required placeholder={T.emailPh} value={email} onChange={(e) => setEmail(e.target.value)} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.45, marginBottom: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 2, width: 16, height: 16 }} />
          <span>{T.consent}</span>
        </label>
        <button type="submit" disabled={busy || !email} style={{ ...S.cta, background: brand, width: '100%', opacity: busy || !email ? 0.6 : 1 }}>{T.save}</button>
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
  foot: { textAlign: 'center', fontSize: 10.5, color: '#999', padding: '0 0 7px' },
  sheet: { borderTop: '1px solid #eee', padding: '12px 14px', background: '#fafafa' },
  savedNote: { padding: '10px 14px', fontSize: 13.5, background: '#f0faf2', borderTop: '1px solid #d8eedd', color: '#1d6b34' },
};
