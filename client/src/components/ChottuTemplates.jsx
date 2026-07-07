import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Link templates — one click creates every link an event needs (Phase 2 of the
// ChottuLink module; see docs/CHOTTULINK_INTEGRATION_SCOPE.md). Rendered inside
// ChottuLinks on both surfaces. Flow: pick template → pick event + paste the
// event page URL → preview (tick/untick, fix warnings) → create all → per-item
// results with one-tap retry for failures. Mobile-first: everything stacks.
export default function ChottuTemplates({ entityId, scope, suites, onLinksChanged }) {
  const [templates, setTemplates] = useState(null);
  const [applying, setApplying] = useState(null); // template being applied
  const [editing, setEditing] = useState(null);   // 'new' | template object
  const [error, setError] = useState('');

  const load = () => api.chottuTemplates(scope, entityId).then((d) => setTemplates(d.templates || [])).catch((e) => setError(e.message));
  useEffect(() => { setTemplates(null); setApplying(null); setEditing(null); load(); }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!templates) return error ? <p style={{ color: 'var(--error,#ef4444)', fontSize: 13 }}>{error}</p> : null;

  const canEdit = (t) => scope === 'admin' || !t.platform;

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>⚡ Templates</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>Create every link an event needs in one go.</div>
        </div>
        {!editing && <button style={btnGhost} onClick={() => { setApplying(null); setEditing('new'); }}>＋ New</button>}
      </div>

      {templates.map((t) => (
        <div key={t.id} style={{ borderTop: '1px solid var(--hairline)', marginTop: 10, paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                {t.name} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>· {t.items.length} links{t.platform ? ' · Howler template' : ''}</span>
              </div>
              {t.description && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{t.description}</div>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {canEdit(t) && <button style={btnGhost} onClick={() => { setApplying(null); setEditing(t); }}>Edit</button>}
              <button style={btnPrimarySm} onClick={() => { setEditing(null); setApplying(applying?.id === t.id ? null : t); }}>
                {applying?.id === t.id ? 'Close' : 'Apply to event…'}
              </button>
            </div>
          </div>
          {applying?.id === t.id && (
            <ApplyWizard
              template={t} entityId={entityId} scope={scope} suites={suites}
              onDone={() => { setApplying(null); onLinksChanged?.(); }}
            />
          )}
        </div>
      ))}

      {editing && (
        <TemplateEditor
          template={editing === 'new' ? null : editing} entityId={entityId} scope={scope}
          onDone={async (changed) => { setEditing(null); if (changed) await load(); }}
        />
      )}
    </div>
  );
}

// Pick event + base URL → preview → tick/edit → create → results (retry failures).
function ApplyWizard({ template, entityId, scope, suites, onDone }) {
  const [suiteId, setSuiteId] = useState(suites[0]?.id || '');
  const [base, setBase] = useState('');
  const [preview, setPreview] = useState(null);   // resolved items
  const [picked, setPicked] = useState({});       // key -> { on, path, name }
  const [results, setResults] = useState(null);   // apply outcome
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const needsBase = template.items.some((i) => JSON.stringify(i).includes('{{base}}'));

  async function runPreview() {
    setBusy('preview'); setError(''); setResults(null);
    try {
      const p = await api.chottuPreviewTemplate(scope, entityId, template.id, { suiteId, base });
      setPreview(p);
      setPicked(Object.fromEntries(p.items.map((i) => [i.key, { on: !i.warnings.length, path: i.path, name: i.name }])));
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  async function runApply(onlyKeys) {
    setBusy('apply'); setError('');
    try {
      const items = preview.items
        .filter((i) => (onlyKeys ? onlyKeys.includes(i.key) : picked[i.key]?.on))
        .map((i) => ({ key: i.key, path: picked[i.key]?.path ?? i.path, name: picked[i.key]?.name ?? i.name }));
      const r = await api.chottuApplyTemplate(scope, entityId, template.id, { suiteId, base, items });
      setResults((prev) => {
        if (!prev) return r;
        // A retry replaces just the retried keys' outcomes.
        const merged = prev.results.map((x) => r.results.find((y) => y.key === x.key) || x);
        return { results: merged, created: merged.filter((x) => x.ok).length, failed: merged.filter((x) => !x.ok).length };
      });
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  const failedKeys = (results?.results || []).filter((r) => !r.ok).map((r) => r.key);
  const nPicked = preview ? preview.items.filter((i) => picked[i.key]?.on).length : 0;

  return (
    <div style={{ ...panel, marginTop: 10 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Event">
          <select style={input} value={suiteId} onChange={(e) => { setSuiteId(e.target.value); setPreview(null); setResults(null); }}>
            {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {!suites.length && <option value="">No events yet</option>}
          </select>
        </Field>
        {needsBase && (
          <Field label="Event page URL" hint="Pasted into every {{base}} — e.g. https://www.howler.co.za/event/40848">
            <input style={input} value={base} onChange={(e) => { setBase(e.target.value); setPreview(null); setResults(null); }} placeholder="https://www.howler.co.za/event/…" inputMode="url" autoComplete="off" />
          </Field>
        )}
        {!preview && <button style={btnPrimarySm} disabled={!!busy || !suiteId || (needsBase && !base.trim())} onClick={runPreview}>{busy === 'preview' ? 'Working…' : 'Preview links'}</button>}

        {preview && !results && (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Will create <b style={{ color: 'var(--text)' }}>{nPicked}</b> of {preview.items.length} links — untick any you don’t need, tweak paths inline.</div>
            {preview.items.map((i) => {
              const p = picked[i.key] || {};
              return (
                <div key={i.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', borderTop: '1px solid var(--hairline)', paddingTop: 8 }}>
                  <input type="checkbox" checked={!!p.on} onChange={(e) => setPicked((s) => ({ ...s, [i.key]: { ...p, on: e.target.checked } }))} style={{ width: 20, height: 20, marginTop: 3 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <input style={{ ...input, fontWeight: 600, marginBottom: 4 }} value={p.name ?? i.name} onChange={(e) => setPicked((s) => ({ ...s, [i.key]: { ...p, name: e.target.value } }))} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12.5 }}>
                      <span style={{ color: 'var(--muted)', flexShrink: 0 }}>…/</span>
                      <input style={{ ...input, minHeight: 32, padding: '5px 8px', fontSize: 12.5 }} value={p.path ?? i.path} onChange={(e) => setPicked((s) => ({ ...s, [i.key]: { ...p, path: e.target.value } }))} />
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>→ {i.destination || '(no destination)'}</div>
                    {i.warnings.map((w, ix) => <div key={ix} style={{ fontSize: 12, color: 'var(--warn,#b25000)', marginTop: 3 }}>⚠ {w}</div>)}
                  </div>
                </div>
              );
            })}
            <button style={btnPrimary} disabled={!!busy || !nPicked} onClick={() => runApply()}>
              {busy === 'apply' ? 'Creating…' : `Create ${nPicked} link${nPicked === 1 ? '' : 's'}`}
            </button>
          </>
        )}

        {results && (
          <>
            <div style={{ fontSize: 13.5, fontWeight: 700 }}>
              {results.failed ? `✓ ${results.created} created · ✗ ${results.failed} failed` : `✓ All ${results.created} links created`}
            </div>
            {results.results.map((r) => (
              <div key={r.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5, borderTop: '1px solid var(--hairline)', paddingTop: 6 }}>
                <span style={{ flexShrink: 0, fontWeight: 700, color: r.ok ? 'var(--success,#10b981)' : 'var(--error,#ef4444)' }}>{r.ok ? '✓' : '✗'}</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.ok ? <>{r.link.linkName} — <span style={{ color: 'var(--brand,#ff385c)' }}>{r.link.shortUrl.replace(/^https?:\/\//, '')}</span></> : <>{r.key}: <span style={{ color: 'var(--error,#ef4444)' }}>{r.error}</span></>}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              {failedKeys.length > 0 && <button style={btnPrimarySm} disabled={!!busy} onClick={() => runApply(failedKeys)}>{busy === 'apply' ? 'Retrying…' : `Retry ${failedKeys.length} failed`}</button>}
              <button style={btnGhost} onClick={() => onDone()}>Done</button>
            </div>
          </>
        )}

        {error && <div style={{ color: 'var(--error,#ef4444)', fontSize: 13 }}>{error}</div>}
      </div>
    </div>
  );
}

// Template CRUD — items as stacked cards; placeholder cheatsheet up top.
function TemplateEditor({ template, entityId, scope, onDone }) {
  const [name, setName] = useState(template?.name || '');
  const [description, setDescription] = useState(template?.description || '');
  const [items, setItems] = useState(template?.items?.length ? template.items : [blankItem()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function blankItem() { return { key: `item-${Math.random().toString(36).slice(2, 7)}`, name: '', destination: '', path: '', utm: {}, social: {}, iosBehavior: 2, androidBehavior: 2 }; }
  const setItem = (ix, patch) => setItems((arr) => arr.map((it, i) => (i === ix ? { ...it, ...patch } : it)));

  async function save() {
    setBusy(true); setError('');
    try {
      await api.chottuSaveTemplate(scope, entityId, template?.id || null, {
        name, description, items: items.filter((i) => i.name.trim() || i.destination.trim()),
        ...(scope === 'admin' && template?.platform ? { platform: true } : {}),
      });
      onDone(true);
    } catch (e) { setError(e.message); setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Delete the template “${template.name}”? Links already created stay untouched.`)) return;
    setBusy(true);
    try { await api.chottuDeleteTemplate(scope, entityId, template.id); onDone(true); }
    catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div style={{ ...panel, marginTop: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Placeholders fill in per event: <code>{'{{event.name}}'}</code> · <code>{'{{event.slug}}'}</code> (url-safe name) · <code>{'{{client.name}}'}</code> · <code>{'{{base}}'}</code> (the event page URL, pasted when applying).
        </div>
        <Field label="Template name"><input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard event set" autoComplete="off" /></Field>
        <Field label="Description · optional"><input style={input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this set is for" autoComplete="off" /></Field>
        {items.map((it, ix) => (
          <div key={it.key} style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Link {ix + 1}</span>
              {items.length > 1 && <button style={{ ...btnGhost, minHeight: 28, padding: '3px 10px', fontSize: 12 }} onClick={() => setItems((arr) => arr.filter((_, i) => i !== ix))}>Remove</button>}
            </div>
            <input style={input} value={it.name} onChange={(e) => setItem(ix, { name: e.target.value })} placeholder="Name — e.g. {{event.name}} (lineup)" autoComplete="off" />
            <input style={input} value={it.destination} onChange={(e) => setItem(ix, { destination: e.target.value })} placeholder="Destination — e.g. {{base}}?dest=my-lineup" autoComplete="off" />
            <input style={input} value={it.path} onChange={(e) => setItem(ix, { path: e.target.value })} placeholder="Path — e.g. {{event.slug}}-lineup" autoComplete="off" />
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>Campaign tags (UTM) · optional</div>
            <input style={input} value={it.utm?.source || ''} onChange={(e) => setItem(ix, { utm: { ...it.utm, source: e.target.value } })} placeholder="source — e.g. instagram" autoComplete="off" />
            <input style={input} value={it.utm?.medium || ''} onChange={(e) => setItem(ix, { utm: { ...it.utm, medium: e.target.value } })} placeholder="medium — e.g. social" autoComplete="off" />
            <input style={input} value={it.utm?.campaign || ''} onChange={(e) => setItem(ix, { utm: { ...it.utm, campaign: e.target.value } })} placeholder="campaign — e.g. {{event.slug}}" autoComplete="off" />
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>Social preview · optional</div>
            <input style={input} value={it.social?.title || ''} onChange={(e) => setItem(ix, { social: { ...it.social, title: e.target.value } })} placeholder="Preview title — e.g. {{event.name}} 🎟️" autoComplete="off" />
            <input style={input} value={it.social?.description || ''} onChange={(e) => setItem(ix, { social: { ...it.social, description: e.target.value } })} placeholder="Preview description — one enticing line" autoComplete="off" />
          </div>
        ))}
        <button style={btnGhost} onClick={() => setItems((arr) => [...arr, blankItem()])}>＋ Add a link</button>
        {error && <div style={{ color: 'var(--error,#ef4444)', fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnPrimary} disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save template'}</button>
          <button style={btnGhost} disabled={busy} onClick={() => onDone(false)}>Cancel</button>
          {template && (scope === 'admin' || !template.platform) && <button style={{ ...btnGhost, color: 'var(--error,#ef4444)', marginLeft: 'auto' }} disabled={busy} onClick={remove}>Delete</button>}
        </div>
      </div>
    </div>
  );
}

const Field = ({ label, hint, children }) => (
  <label style={{ display: 'block' }}>
    <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
    {children}
    {hint && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
  </label>
);

const card = { background: 'var(--card)', border: '1px solid var(--border,var(--hairline))', borderRadius: 14, padding: '14px 16px', boxShadow: 'var(--shadow-sm,none)' };
const panel = { background: 'var(--bg)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '12px 14px' };
const input = { width: '100%', minHeight: 40, padding: '9px 11px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' };
const btnPrimary = { minHeight: 42, padding: '10px 18px', borderRadius: 12, border: 'none', background: 'var(--brand,#ff385c)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const btnPrimarySm = { minHeight: 36, padding: '7px 14px', borderRadius: 10, border: 'none', background: 'var(--brand,#ff385c)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' };
const btnGhost = { minHeight: 36, padding: '7px 12px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
