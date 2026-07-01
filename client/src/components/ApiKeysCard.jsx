import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Per-entity API keys for the public surface (/api/v1 + the MCP server for AI
// agents). Same component on both surfaces via the scope prop (MailTemplateEditor
// pattern): 'admin-client' (Admin → client → Integrations) | 'my' (Settings →
// Integrations). The secret is shown ONCE at creation — after that only a masked
// hint ever comes back from the server.
export default function ApiKeysCard({ entityId, scope = 'my' }) {
  const listFn = scope === 'admin-client' ? () => api.listEntityApiKeys(entityId) : () => api.listMyApiKeys(entityId);
  const createFn = scope === 'admin-client' ? (p) => api.createEntityApiKey(entityId, p) : (p) => api.createMyApiKey(entityId, p);
  const revokeFn = scope === 'admin-client' ? (id) => api.revokeEntityApiKey(entityId, id) : (id) => api.revokeMyApiKey(entityId, id);

  const [keys, setKeys] = useState(null);
  const [denied, setDenied] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState(null); // { name, secret } — shown once
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setFresh(null);
    listFn().then((r) => setKeys(r.keys || [])).catch(() => { setKeys([]); setDenied(true); });
  }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!keys) return null;
  if (denied) return null; // no integrations.manage on this client — keep the section quiet

  const create = async () => {
    setCreating(true);
    try {
      const r = await createFn({ name: name.trim() || 'Untitled key', scopes: ['read'] });
      setFresh({ name: r.key.name, secret: r.secret });
      setName('');
      setKeys((await listFn()).keys || []);
    } catch (e) { alert('Couldn’t create the key: ' + e.message); }
    setCreating(false);
  };
  const revoke = async (k) => {
    if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working immediately.`)) return;
    try { await revokeFn(k.id); setKeys((await listFn()).keys || []); }
    catch (e) { alert('Couldn’t revoke the key: ' + e.message); }
  };
  const copy = () => {
    (navigator.clipboard?.writeText(fresh.secret) || Promise.reject()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
      .catch(() => window.prompt('Copy this key:', fresh.secret));
  };

  const active = keys.filter((k) => !k.revokedAt);
  const base = window.location.origin;
  return (
    <div style={card}>
      <div style={title}>🔌 API access &amp; AI agents</div>
      <p style={sub}>
        Read this client’s Pulse data from other tools: a REST API (<code style={inline}>{base}/api/v1</code>) and an
        MCP server for AI agents like Claude (<code style={inline}>{base}/mcp</code>). Keys are read-only, scoped to
        this client only, and sent as <code style={inline}>Authorization: Bearer …</code>.
      </p>

      {fresh && (
        <div style={freshBox}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>“{fresh.name}” — copy this key now. It won’t be shown again.</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <code style={{ ...pill, wordBreak: 'break-all' }}>{fresh.secret}</code>
            <button style={btn} onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
            <button style={ghostBtn} onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}

      {active.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {active.map((k) => (
            <div key={k.id} style={row}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  <code>{k.hint}</code> · {k.scopes.join(' + ')} · {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'never used'}
                </div>
              </div>
              <button style={dangerBtn} onClick={() => revoke(k)}>Revoke</button>
            </div>
          ))}
        </div>
      )}
      {active.length === 0 && !fresh && <p style={{ ...sub, marginBottom: 12 }}>No active keys yet.</p>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          style={input}
          placeholder="Key name (e.g. Reporting bot)"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <button style={btn} onClick={create} disabled={creating}>{creating ? 'Creating…' : '+ New read-only key'}</button>
      </div>
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 16, marginTop: 16 };
const title = { fontSize: 14, fontWeight: 700, marginBottom: 6 };
const sub = { fontSize: 13, color: 'var(--muted)', margin: '0 0 12px' };
const inline = { fontSize: 12, background: 'var(--elevated, #f3f3f5)', borderRadius: 5, padding: '1px 5px' };
const pill = { fontSize: 13, fontWeight: 600, background: 'var(--elevated, #f3f3f5)', border: '1px solid var(--hairline)', borderRadius: 8, padding: '8px 12px', userSelect: 'all' };
const freshBox = { border: '1px solid var(--brand)', borderRadius: 10, padding: 12, marginBottom: 12 };
const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, border: '1px solid var(--hairline)', borderRadius: 10, padding: '10px 12px' };
const input = { flex: '1 1 200px', minWidth: 0, border: '1px solid var(--hairline)', borderRadius: 8, padding: '9px 12px', fontSize: 13.5, background: 'var(--card)', color: 'inherit' };
const btn = { border: '1px solid var(--hairline)', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '9px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
const ghostBtn = { ...btn, background: 'transparent', color: 'var(--muted)' };
const dangerBtn = { ...ghostBtn, color: 'var(--danger, #dc2626)', flexShrink: 0 };
