import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';

// Editable email branding/template with a live preview. Used at two scopes:
//   • platform  (entityId omitted) — Howler's default for all notifications
//   • client    (entityId set)     — a client's own branding, layered on top
// Blank fields inherit the tier below, so the placeholder shows what will be
// used if left empty. The HTML shell + "Powered by Howler Pulse" are fixed.
const FIELDS = [
  ['senderName', 'Sender name', 'text', 'Shown on the From line, e.g. "Kunye"'],
  ['brandColor', 'Primary colour', 'color', 'Buttons, accents, first chart series — across the platform and emails'],
  ['secondaryColor', 'Secondary colour', 'color', 'Gradient partner and second chart series'],
  ['chart3', 'Chart colour 3', 'color', 'Third chart series'],
  ['chart4', 'Chart colour 4', 'color', 'Fourth chart series'],
  ['chart5', 'Chart colour 5', 'color', 'Fifth chart series — further series are generated from your palette'],
  ['logo', 'Logo image', 'logo', 'Upload an image or paste a URL — blank uses the wordmark'],
  ['wordmark', 'Wordmark', 'text', 'Text shown if there is no logo'],
  ['header', 'Header text', 'textarea', 'Tagline shown under the logo, at the top of every email'],
  ['intro', 'Intro line', 'textarea', 'Optional line above the message, inside the card'],
  ['footer', 'Footer text', 'textarea', 'Small print under the card — supports multiple lines (e.g. contact details)'],
];

export default function MailTemplateEditor({ entityId, scope = 'platform', canTest = false }) {
  const [data, setData] = useState(null);     // { template|branding, resolved?, defaults }
  const [edits, setEdits] = useState({});     // local overrides being edited
  const [previewHtml, setPreviewHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testState, setTestState] = useState('');
  const debounce = useRef(null);

  const loadFn = scope === 'platform' ? () => api.getMailTemplate()
    : scope === 'admin-client' ? () => api.getEntityMailTemplate(entityId)
    : () => api.getMyMailTemplate(entityId);
  const saveFn = scope === 'platform' ? (p) => api.saveMailTemplate(p)
    : scope === 'admin-client' ? (p) => api.saveEntityMailTemplate(entityId, p)
    : (p) => api.saveMyMailTemplate(entityId, p);

  useEffect(() => {
    loadFn().then((d) => { setData(d); setEdits({ ...(d.template || d.branding || {}) }); });
  }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced live preview as the user types.
  useEffect(() => {
    if (!data) return;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      api.previewMail(edits, entityId).then((r) => setPreviewHtml(r.html)).catch(() => {});
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [edits, entityId, data]);

  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;
  const placeholderFor = (k) => (scope === 'platform' ? data.defaults?.[k] : data.resolved?.[k]) || '';
  const set = (k, v) => setEdits((e) => ({ ...e, [k]: v }));

  async function save() {
    setBusy(true);
    try { const d = await saveFn(edits); setData(d); setSaved(true); setTimeout(() => setSaved(false), 1600); }
    catch (e) { alert('Save failed: ' + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 20, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {FIELDS.map(([key, label, type, help]) => (
          <div key={key}>
            <div style={lbl}>{label}</div>
            {type === 'logo' ? (
              <LogoField value={edits[key] || ''} inherited={placeholderFor(key)} onChange={(v) => set(key, v)} />
            ) : type === 'textarea' ? (
              <textarea value={edits[key] || ''} onChange={(e) => set(key, e.target.value)} placeholder={placeholderFor(key)} rows={2} style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} />
            ) : type === 'color' ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(edits[key] || '') ? edits[key] : (placeholderFor(key) || '#FF385C')} onChange={(e) => set(key, e.target.value)} style={{ width: 44, height: 34, border: '1px solid var(--hairline)', borderRadius: 8, padding: 2, cursor: 'pointer' }} />
                <input value={edits[key] || ''} onChange={(e) => set(key, e.target.value)} placeholder={placeholderFor(key)} style={{ ...input, flex: 1 }} />
              </div>
            ) : (
              <input value={edits[key] || ''} onChange={(e) => set(key, e.target.value)} placeholder={placeholderFor(key)} style={input} />
            )}
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{help}{(edits[key] || '') === '' ? ' · inheriting' : ''}</div>
          </div>
        ))}
        <div style={{ fontSize: 11.5, color: 'var(--muted)', background: 'var(--elevated, #f7f7f8)', border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 10px' }}>
          The primary + secondary pair drives the look of the whole platform (buttons, accents, chart palettes) and these emails. Sends stay on Howler's verified domain, and a “Powered by Howler : Pulse” line stays in the footer.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <button style={saveBtn} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          {saved && <span style={{ color: 'var(--success, #10b981)', fontSize: 13, fontWeight: 600 }}>✓ Saved</span>}
          {canTest && (
            <button
              type="button"
              style={{ ...saveBtn, background: 'rgba(128,128,128,0.14)', color: 'var(--text)' }}
              disabled={testState === 'sending'}
              onClick={async () => { setTestState('sending'); try { const r = await api.sendMailTest(entityId); setTestState(`✓ Sent to ${r.to}`); } catch (e) { setTestState(`✗ ${e.message}`); } }}
            >{testState === 'sending' ? 'Sending…' : 'Send me a test'}</button>
          )}
          {testState && testState !== 'sending' && <span style={{ fontSize: 12, color: testState.startsWith('✓') ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>{testState}</span>}
        </div>
      </div>

      <div>
        <div style={lbl}>Live preview</div>
        <iframe title="Email preview" srcDoc={previewHtml} style={{ width: '100%', height: 460, border: '1px solid var(--hairline)', borderRadius: 12, background: '#fff' }} />
      </div>
    </div>
  );
}

// Logo: upload an image (resized client-side to ≤320px, stored as a data-URL —
// emails reference it via /mail-assets/logo/:scope since Gmail strips data-URLs)
// or paste a hosted URL. Shows the inherited logo when nothing is set here.
function LogoField({ value, inherited, onChange }) {
  const fileRef = useRef(null);
  const shown = value || inherited;
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 320, scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        onChange(c.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
    e.target.value = ''; // allow re-uploading the same file
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 120, height: 44, border: '1px dashed var(--hairline)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#fff' }}>
          {shown ? <img src={shown} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', opacity: value ? 1 : 0.45 }} /> : <span style={{ fontSize: 11, color: 'var(--muted)' }}>No logo</span>}
        </div>
        <button type="button" style={smallBtn} onClick={() => fileRef.current?.click()}>Upload image</button>
        {value && <button type="button" style={{ ...smallBtn, background: 'transparent', color: 'var(--error, #ef4444)' }} onClick={() => onChange('')}>Remove</button>}
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
      </div>
      {!value?.startsWith('data:') && (
        <input value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={inherited && !inherited.startsWith('data:') ? inherited : 'or paste an image URL: https://…/logo.png'} style={input} />
      )}
    </div>
  );
}

const smallBtn = { border: '1px solid var(--hairline)', background: 'rgba(128,128,128,0.10)', color: 'var(--text)', borderRadius: 980, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const lbl = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '0 0 5px' };
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const saveBtn = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
