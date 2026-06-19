import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// The keystone "Segment from a tile" flow: turn the people in a Looker tile
// (with the dashboard filters currently applied) into a named, reusable segment.
// The segment stores a *definition* (tile + captured filters + email field) and
// re-resolves live — it's not a frozen list. From Engage it can then be messaged,
// synced or tracked. Resolution + the org-scope boundary are enforced server-side.
export default function CreateSegmentModal({ entityId, dashboardId, tileId, tileTitle, fields = [], lookerFilters = {}, onClose }) {
  const isMobile = useIsMobile();
  const guessEmail = fields.find((f) => /email/i.test(f.name) || /email/i.test(f.label))?.name || '';
  const guessName = fields.find((f) => /(^|[_.])name$|full.?name|first.?name/i.test(f.name) || /name/i.test(f.label))?.name || '';
  const guessPhone = fields.find((f) => /phone|mobile|cell|msisdn/i.test(f.name) || /phone|mobile|cell/i.test(f.label))?.name || '';
  const guessEmailConsent = fields.find((f) => /allow.*e-?mail|e-?mail.*(consent|opt|allow)|marketing.*e-?mail/i.test(`${f.label} ${f.name}`))?.name || '';
  const guessSmsConsent = fields.find((f) => /allow.*sms|sms.*(consent|opt|allow)|marketing.*sms/i.test(`${f.label} ${f.name}`))?.name || '';
  const [name, setName] = useState(tileTitle ? `${tileTitle}`.slice(0, 120) : 'New segment');
  const [emailField, setEmailField] = useState(guessEmail);
  const [nameField, setNameField] = useState(guessName);
  const [phoneField, setPhoneField] = useState(guessPhone);
  const [emailConsentField, setEmailConsentField] = useState(guessEmailConsent);
  const [smsConsentField, setSmsConsentField] = useState(guessSmsConsent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // created segment
  const [reach, setReach] = useState(null); // live { total, email, sms }

  const filterCount = Object.keys(lookerFilters || {}).length;
  const definition = () => ({ mode: 'tile', dashboardId, tileId, emailField, nameField, phoneField, emailConsentField, smsConsentField, lookerFilters });

  // Live reach preview — "N people · X emailable · Y SMS" before creating.
  useEffect(() => {
    if (!emailField) { setReach(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      api.actionAudiencePreview(entityId, { audience: definition() })
        .then((r) => { if (!cancelled) setReach(r.reach || { total: r.count, email: 0, sms: 0 }); })
        .catch(() => { if (!cancelled) setReach(null); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailField, nameField, phoneField, emailConsentField, smsConsentField]);

  const save = async () => {
    if (!emailField) { setError('Pick which column holds the email address.'); return; }
    setBusy(true); setError('');
    try {
      const { segment } = await api.createSegment(entityId, { name: name.trim() || 'New segment', definition: definition() });
      setDone(segment);
    } catch (e) {
      setError(e.message || 'Could not create the segment.');
    } finally { setBusy(false); }
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={{ ...modal, width: isMobile ? '100%' : 460 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)', flex: 1 }}>🎯 Create segment</div>
          <button onClick={onClose} style={xBtn}>✕</button>
        </div>

        {done ? (
          <div>
            <p style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>“{done.name}” created</p>
            <p style={{ color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5, marginBottom: 16 }}>
              It's a live audience — it re-resolves from this tile each time. Find it under <b>Engage → Segments</b> to message, sync or track it.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={primary} onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, margin: '2px 0 14px' }}>
              Turns the people in this tile into a reusable audience.
              {filterCount > 0 ? ` It captures the ${filterCount} filter${filterCount === 1 ? '' : 's'} you have applied and resolves live.` : ' It resolves live each time it is used.'}
            </p>

            <Label>Segment name</Label>
            <input style={input} value={name} onChange={(e) => setName(e.target.value)} autoFocus />

            <Label>Email column</Label>
            <Select value={emailField} onChange={setEmailField} fields={fields} placeholder="Select the email field…" />
            {!emailField && <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>Required — the segment needs an email address per person.</p>}

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <div style={{ flex: 1 }}>
                <Label>Name column <span style={opt}>· optional</span></Label>
                <Select value={nameField} onChange={setNameField} fields={fields} placeholder="—" allowEmpty />
              </div>
              <div style={{ flex: 1 }}>
                <Label>Phone column <span style={opt}>· optional</span></Label>
                <Select value={phoneField} onChange={setPhoneField} fields={fields} placeholder="—" allowEmpty />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <div style={{ flex: 1 }}>
                <Label>Email consent <span style={opt}>· optional</span></Label>
                <Select value={emailConsentField} onChange={setEmailConsentField} fields={fields} placeholder="—" allowEmpty />
              </div>
              <div style={{ flex: 1 }}>
                <Label>SMS consent <span style={opt}>· optional</span></Label>
                <Select value={smsConsentField} onChange={setSmsConsentField} fields={fields} placeholder="—" allowEmpty />
              </div>
            </div>

            {reach && (
              <div style={{ marginTop: 12, padding: '9px 12px', borderRadius: 10, background: 'rgba(var(--brand-rgb),0.08)', fontSize: 13 }}>
                <b style={{ color: 'var(--brand)' }}>{reach.total}</b> {reach.total === 1 ? 'person' : 'people'} · <b>{reach.email}</b> emailable · <b>{reach.sms}</b> SMS
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Set the consent columns above for accurate reach. Resolves live whenever the segment is used.</span>
              </div>
            )}

            {error && <p style={{ color: 'var(--error)', fontSize: 13, marginTop: 12 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <button style={ghost} onClick={onClose} disabled={busy}>Cancel</button>
              <button style={primary} onClick={save} disabled={busy}>{busy ? 'Creating…' : 'Create segment'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Select({ value, onChange, fields, placeholder, allowEmpty }) {
  return (
    <select style={input} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {allowEmpty && value && <option value="">— none —</option>}
      {fields.map((f) => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
    </select>
  );
}

const Label = ({ children }) => <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '12px 0 4px' }}>{children}</label>;
const opt = { textTransform: 'none', letterSpacing: 0, fontWeight: 400 };
const backdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal = { background: 'var(--card)', borderRadius: 16, padding: 20, boxShadow: '0 12px 40px rgba(0,0,0,0.25)', maxHeight: '90dvh', overflowY: 'auto', boxSizing: 'border-box' };
const input = { width: '100%', padding: '9px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 14, outline: 'none', background: 'var(--card)', color: 'var(--text)', boxSizing: 'border-box' };
const primary = { padding: '9px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const ghost = { padding: '9px 16px', background: 'transparent', color: 'var(--text)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const xBtn = { background: 'none', border: 'none', fontSize: 16, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1 };
