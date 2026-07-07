import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import ChottuTemplates from './ChottuTemplates.jsx';

// ChottuLink deep links — the Links area, dual-surface (see server/chottuLink.js).
// `scope`: 'admin' (Admin → client → 🔗 Deep links) | 'my' (Engage → Links).
// Mobile-first: one column of event cards; the editor is a stacked form, never a
// side-by-side grid. Click counts come from the last stats refresh (on-demand).
export default function ChottuLinks({ entityId, scope = 'my' }) {
  const [data, setData] = useState(null);
  const [suites, setSuites] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | link id
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = () => api.chottuLinks(scope, entityId).then(setData).catch((e) => setError(e.message));
  useEffect(() => { setData(null); setEditing(null); load(); }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    (scope === 'admin' ? api.adminListSuites() : api.mySuites())
      .then((all) => setSuites((all || []).filter((s) => s.entityId === entityId)))
      .catch(() => setSuites([]));
  }, [entityId, scope]);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 2500); };
  const run = async (key, fn) => {
    setBusy(key); setError('');
    try { return await fn(); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  };

  const suiteName = (id) => suites.find((s) => s.id === id)?.name || 'Unknown event';
  const groups = useMemo(() => {
    const links = data?.links || [];
    const by = new Map();
    for (const l of links) {
      const k = l.suiteId || '';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(l);
    }
    // Event groups first (suite order), unassigned last.
    const out = [...by.entries()].map(([k, ls]) => ({ suiteId: k, title: k ? suiteName(k) : 'Not linked to an event', links: ls }));
    out.sort((a, b) => (a.suiteId ? 0 : 1) - (b.suiteId ? 0 : 1));
    return out;
  }, [data, suites]);

  if (error && !data) return <p style={{ color: 'var(--error,#ef4444)', fontSize: 14 }}>{error}</p>;
  if (!data) return <p style={{ color: 'var(--muted)' }}>Loading…</p>;

  const copy = async (url) => {
    try { await navigator.clipboard.writeText(url); flash('Copied — ready to paste anywhere.'); }
    catch { window.prompt('Copy the link:', url); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      {/* Connection / setup state */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: data.configured ? 'var(--success,#10b981)' : 'var(--muted)' }} />
          <div style={{ fontSize: 13.5, minWidth: 0, flex: 1 }}>
            {data.configured ? (
              <><b>Connected</b> — {data.domain} <span style={{ color: 'var(--muted)', fontSize: 12 }}>· {data.source === 'client' ? 'your own ChottuLink account' : 'Howler platform account'}</span></>
            ) : (
              <><b>Not connected.</b> <span style={{ color: 'var(--muted)' }}>{scope === 'admin' ? 'Add the ChottuLink API key + domain under Integrations (platform default or this client).' : 'Ask your Howler contact to connect ChottuLink, or add your own key under Settings → Integrations.'}</span></>
            )}
          </div>
        </div>
        {scope === 'admin' && data.configured && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button style={btnGhost} disabled={!!busy} onClick={() => run('test', async () => {
              const r = await api.chottuTest(entityId);
              flash(r.ok ? `✓ Connected — ${r.totalLinks} links on ${r.domain}` : `✗ ${r.error}`);
            })}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
            <button style={btnGhost} disabled={!!busy} onClick={() => run('import', async () => {
              const r = await api.chottuImport(entityId);
              flash(`Imported ${r.imported} new link${r.imported === 1 ? '' : 's'} (${r.refreshed} refreshed).`);
              await load();
            })}>{busy === 'import' ? 'Importing…' : '⬇ Import from ChottuLink'}</button>
            <button style={btnGhost} disabled={!!busy} onClick={() => run('stats', async () => {
              const r = await api.chottuRefreshStats(scope, entityId, {});
              flash(`Click counts refreshed for ${r.updated} link${r.updated === 1 ? '' : 's'}${r.failed ? ` (${r.failed} failed)` : ''}.`);
              await load();
            })}>{busy === 'stats' ? 'Refreshing…' : '⟳ Refresh clicks'}</button>
          </div>
        )}
        {scope === 'my' && data.configured && (data.links || []).length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button style={btnGhost} disabled={!!busy} onClick={() => run('stats', async () => {
              const r = await api.chottuRefreshStats(scope, entityId, {});
              flash(`Click counts refreshed for ${r.updated} link${r.updated === 1 ? '' : 's'}.`);
              await load();
            })}>{busy === 'stats' ? 'Refreshing…' : '⟳ Refresh clicks'}</button>
          </div>
        )}
      </div>

      {(notice || error) && (
        <div style={{ fontSize: 13, fontWeight: 600, color: error ? 'var(--error,#ef4444)' : 'var(--success,#10b981)' }}>{error || notice}</div>
      )}

      {data.configured && (editing === 'new'
        ? <LinkEditor scope={scope} entityId={entityId} suites={suites} onDone={async (changed) => { setEditing(null); if (changed) { flash('Link created — the short URL is live.'); await load(); } }} />
        : <button style={btnPrimary} onClick={() => setEditing('new')}>＋ New link</button>
      )}

      {data.configured && <ChottuTemplates entityId={entityId} scope={scope} suites={suites} onLinksChanged={load} />}

      {groups.length === 0 && data.configured && (
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>
          No links yet. Create the first one{scope === 'admin' ? ', or import what already exists in ChottuLink.' : '.'}
        </p>
      )}

      {groups.map((g) => (
        <div key={g.suiteId || 'none'} style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5, minWidth: 0 }}>{g.title}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
              {g.links.length} link{g.links.length === 1 ? '' : 's'} · {g.links.reduce((n, l) => n + (l.clicks?.total || 0), 0)} clicks
            </div>
          </div>
          {g.links.map((l) => (
            <div key={l.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: '1px solid var(--hairline)', opacity: l.enabled ? 1 : 0.55 }}>
                <button
                  onClick={() => setEditing(editing === l.id ? null : l.id)}
                  style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.linkName || '(unnamed link)'} {!l.enabled && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>· off</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--brand,#ff385c)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.shortUrl.replace(/^https?:\/\//, '')}</div>
                </button>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, fontVariantNumeric: 'tabular-nums' }}>{l.clicks?.at ? l.clicks.total : '—'}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>clicks</div>
                </div>
                <button title="Copy link" onClick={() => copy(l.shortUrl)} style={iconBtn}>⧉</button>
              </div>
              {editing === l.id && (
                <LinkEditor
                  scope={scope} entityId={entityId} suites={suites} link={l}
                  onDone={async (changed) => { setEditing(null); if (changed) await load(); }}
                />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Create/edit one link — stacked single-column form (mobile-first).
function LinkEditor({ scope, entityId, suites, link = null, onDone }) {
  const [name, setName] = useState(link?.linkName || '');
  const [suiteId, setSuiteId] = useState(link?.suiteId || '');
  const [destination, setDestination] = useState(link?.destinationUrl || '');
  const [path, setPath] = useState('');
  const [openInApp, setOpenInApp] = useState(link ? link.iosBehavior !== 1 : true);
  const [utm, setUtm] = useState(link?.utm || {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setU = (k, v) => setUtm((u) => ({ ...u, [k]: v }));
  const behavior = openInApp ? 2 : 1;

  async function save() {
    setBusy(true); setError('');
    try {
      if (link) {
        await api.chottuUpdateLink(scope, entityId, link.id, { linkName: name, suiteId, destinationUrl: destination, iosBehavior: behavior, androidBehavior: behavior, utm });
      } else {
        await api.chottuCreateLink(scope, entityId, { linkName: name, suiteId, destinationUrl: destination, path, iosBehavior: behavior, androidBehavior: behavior, utm });
      }
      onDone(true);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div style={{ ...card, background: 'var(--bg)', margin: link ? '0 0 10px' : 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Field label="Link name">
          <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tickets — Instagram bio" autoComplete="off" />
        </Field>
        <Field label="Event">
          <select style={input} value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
            <option value="">Not linked to an event</option>
            {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Destination URL">
          <input style={input} value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="https://www.howler.co.za/event/…" autoComplete="off" inputMode="url" />
        </Field>
        {!link && (
          <Field label="Short URL path · optional" hint="Leave blank for an auto-generated code. Letters, numbers and dashes only.">
            <input style={input} value={path} onChange={(e) => setPath(e.target.value)} placeholder="my-event-ig" autoComplete="off" />
          </Field>
        )}
        <Field label="If the app is installed, open…">
          <div style={{ display: 'flex', gap: 6 }}>
            <Seg on={openInApp} onClick={() => setOpenInApp(true)}>App</Seg>
            <Seg on={!openInApp} onClick={() => setOpenInApp(false)}>Browser</Seg>
          </div>
        </Field>
        <Field label="Campaign tags (UTM) · optional">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input style={input} value={utm.source || ''} onChange={(e) => setU('source', e.target.value)} placeholder="source — e.g. instagram" autoComplete="off" />
            <input style={input} value={utm.medium || ''} onChange={(e) => setU('medium', e.target.value)} placeholder="medium — e.g. social" autoComplete="off" />
            <input style={input} value={utm.campaign || ''} onChange={(e) => setU('campaign', e.target.value)} placeholder="campaign — e.g. summer-launch" autoComplete="off" />
          </div>
        </Field>
        {error && <div style={{ color: 'var(--error,#ef4444)', fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={btnPrimary} disabled={busy || !name.trim() || !destination.trim()} onClick={save}>
            {busy ? 'Saving…' : link ? 'Save changes' : 'Create link'}
          </button>
          <button style={btnGhost} disabled={busy} onClick={() => onDone(false)}>Cancel</button>
          {link && (
            <button
              style={{ ...btnGhost, color: link.enabled ? 'var(--error,#ef4444)' : 'var(--success,#10b981)', marginLeft: 'auto' }}
              disabled={busy}
              onClick={async () => {
                setBusy(true); setError('');
                try { await api.chottuSetLinkStatus(scope, entityId, link.id, !link.enabled); onDone(true); }
                catch (e) { setError(e.message); setBusy(false); }
              }}
            >{link.enabled ? 'Switch off' : 'Switch on'}</button>
          )}
        </div>
        {link && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>The short URL and path can’t change after creation — switch this link off and create a new one instead.</div>}
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
const Seg = ({ on, onClick, children }) => (
  <button type="button" onClick={onClick} style={{
    flex: 1, minHeight: 40, padding: '8px 12px', borderRadius: 10, cursor: 'pointer',
    border: on ? '1.5px solid var(--text)' : '1.5px solid var(--hairline)',
    background: on ? 'var(--text)' : 'var(--card)', color: on ? 'var(--bg)' : 'var(--muted-2,var(--muted))',
    fontWeight: 700, fontSize: 13.5,
  }}>{children}</button>
);

const card = { background: 'var(--card)', border: '1px solid var(--border,var(--hairline))', borderRadius: 14, padding: '14px 16px', boxShadow: 'var(--shadow-sm,none)' };
const input = { width: '100%', minHeight: 40, padding: '9px 11px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' };
const btnPrimary = { minHeight: 42, padding: '10px 18px', borderRadius: 12, border: 'none', background: 'var(--brand,#ff385c)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const btnGhost = { minHeight: 40, padding: '8px 14px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const iconBtn = { width: 40, height: 40, borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 15, cursor: 'pointer', flexShrink: 0 };
