import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { ImageField, HtmlField, Toggle } from './CampaignManager.jsx';

// Reusable email templates (the Engage → Templates tab). Create the email content
// once; apply it when building a campaign. Same content fields as the campaign editor.
export default function TemplateManager({ entityId, scope = 'admin' }) {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | template object | null
  const load = () => api.listCampaignTemplates(entityId).then((r) => setList(r.templates || [])).catch(() => setList([]));
  useEffect(() => { load(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (editing) return <TemplateEditor entityId={entityId} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Save email content once, then apply it to any campaign — subject, body or custom HTML, hero image and button.</p>
        <button style={primary} onClick={() => setEditing('new')}>+ New template</button>
      </div>
      {list === null ? null : list.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '18px 0' }}>No templates yet — create one, then pick it when building a campaign.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((t) => (
            <div key={t.id} style={{ border: '1px solid var(--hairline)', borderRadius: 14, padding: '14px 16px', background: 'var(--card)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{t.name}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 980, padding: '2px 9px', background: 'rgba(128,128,128,0.14)', color: 'var(--muted)' }}>{t.contentMode === 'html' ? 'Custom HTML' : 'Built template'}</span>
                </div>
                {t.subject && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Subject: {t.subject}</div>}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button style={mini} onClick={() => setEditing(t)}>Edit</button>
                <button style={{ ...mini, color: 'var(--error,#ef4444)' }} onClick={() => { if (confirm(`Delete template “${t.name}”?`)) api.deleteCampaignTemplate(entityId, t.id).then(load); }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateEditor({ entityId, template, onClose, onSaved }) {
  const [f, setF] = useState({
    name: template?.name || '',
    subject: template?.subject || '',
    contentMode: template?.contentMode || 'template',
    body: template?.body || '',
    customHtml: template?.customHtml || '',
    heroImage: template?.heroImage || '',
    ctaText: template?.ctaText || 'Complete your order',
  });
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState('');
  const debounce = useRef();

  // Live email preview via the same renderer campaigns use.
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      api.actionPreviewEmail(entityId, { channel: 'email', contentMode: f.contentMode, subject: f.subject, body: f.body, customHtml: f.customHtml, heroImage: f.heroImage, ctaText: f.ctaText, ctaUrl: 'https://example.com' })
        .then((r) => setPreview(r.html || '')).catch(() => {});
    }, 350);
    return () => clearTimeout(debounce.current);
  }, [entityId, f.contentMode, f.subject, f.body, f.customHtml, f.heroImage, f.ctaText]);

  const save = async () => {
    if (!f.name.trim()) { alert('Give the template a name.'); return; }
    setBusy(true);
    try {
      if (template) await api.updateCampaignTemplate(entityId, template.id, f);
      else await api.createCampaignTemplate(entityId, f);
      onSaved();
    } catch (e) { alert('Save failed: ' + e.message); } finally { setBusy(false); }
  };

  return (
    <div>
      <button style={{ ...mini, marginBottom: 12 }} onClick={onClose}>← Back to templates</button>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <Field label="Template name"><input style={input} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Abandoned cart — VIP" /></Field>
          <Field label="Content">
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <Toggle on={f.contentMode === 'template'} onClick={() => set('contentMode', 'template')}>Built template</Toggle>
              <Toggle on={f.contentMode === 'html'} onClick={() => set('contentMode', 'html')}>Custom HTML</Toggle>
            </div>
            <input style={{ ...input, fontWeight: 700, marginBottom: 8 }} value={f.subject} onChange={(e) => set('subject', e.target.value)} placeholder="Subject line" />
            {f.contentMode === 'template' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <ImageField label="Hero image (optional)" value={f.heroImage} onChange={(v) => set('heroImage', v)} />
                <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={7} value={f.body} onChange={(e) => set('body', e.target.value)} placeholder={'Hi {{name}},\n\nYour {{ticketType}} tickets are still waiting…'} />
                <input style={input} value={f.ctaText} onChange={(e) => set('ctaText', e.target.value)} placeholder="Button text (e.g. Complete my purchase)" />
                <div style={hintS}>Tokens: <b>{'{{name}}'}</b>, <b>{'{{ticketType}}'}</b>, <b>{'{{promo}}'}</b> — and any audience column. The buy link is set on the campaign.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <HtmlField value={f.customHtml} onChange={(v) => set('customHtml', v)} />
                <div style={hintS}>Tokens work inside your HTML: <b>{'{{name}}'}</b>, <b>{'{{cta}}'}</b> (tracked buy link), <b>{'{{unsubscribe}}'}</b>.</div>
              </div>
            )}
          </Field>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button style={primary} onClick={save} disabled={busy}>{busy ? 'Saving…' : template ? 'Save changes' : 'Create template'}</button>
            <button style={mini} onClick={onClose}>Cancel</button>
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={lbl}>Preview</div>
          {preview ? <iframe title="Template preview" srcDoc={preview} style={{ width: '100%', height: 520, border: '1px solid var(--hairline)', borderRadius: 12, background: '#fff' }} /> : <div style={{ ...hintS, padding: 20 }}>Type to see a live preview…</div>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) { return <div><div style={lbl}>{label}</div>{children}</div>; }
const input = { width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const mini = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
const primary = { padding: '9px 18px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const hintS = { fontSize: 11.5, color: 'var(--muted)', marginTop: 4 };
const lbl = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', marginBottom: 5 };
