import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Engage → Journeys (J1). The easy-setup front door for multi-step journeys:
// the promoter either picks a pre-wired RECIPE or DESCRIBES what they want in
// plain language and an AI drafts it. Either way they get a read-only,
// plain-language review of the whole journey, then create it as a draft campaign
// (which they finish — audience + final copy — in the Campaigns tab). The graph
// is generated, never hand-built; the AI proposes, a human always reviews.
//
// J1 runs as a linear, timed sequence on the existing drip engine. Per-step
// channel switching + behavioural branching ("if they open but don't click")
// are shown in the review as intent (`reactsTo`) and land with the full engine.

const fmtDelay = (h) => {
  if (!h) return 'right away';
  if (h % 24 === 0) { const d = h / 24; return `after ${d} day${d === 1 ? '' : 's'}`; }
  if (h < 24) return `after ${h} hour${h === 1 ? '' : 's'}`;
  return `after ${Math.round((h / 24) * 10) / 10} days`;
};

const channelChip = (channel) => {
  const email = channel === 'email';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.04em', borderRadius: 980, padding: '2px 8px',
      background: email ? 'rgba(124,58,237,0.12)' : 'rgba(16,185,129,0.14)',
      color: email ? 'var(--brand)' : 'var(--success, #10b981)',
    }}>
      {email ? '✉️ Email' : '💬 SMS'}
    </span>
  );
};

export default function JourneyWizard({ entityId, scope = 'admin' }) {
  const [recipes, setRecipes] = useState([]);
  const [stage, setStage] = useState('choose'); // choose | review | done
  const [journey, setJourney] = useState(null); // { name, goal, summary, steps[], source }
  const [desc, setDesc] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState('');

  useEffect(() => {
    api.journeyRecipes(entityId).then((r) => setRecipes(r.recipes || [])).catch(() => setRecipes([]));
  }, [entityId]);

  const pickRecipe = (r) => {
    setError('');
    setJourney({ name: r.label, goal: r.goal, summary: r.summary, steps: r.steps || [], source: 'recipe' });
    setStage('review');
  };

  const draftWithAI = async () => {
    if (!desc.trim()) return;
    setError(''); setDrafting(true);
    try {
      const out = await api.draftJourney(entityId, { description: desc.trim() });
      setJourney({ name: out.name || 'Untitled journey', goal: out.goal || '', summary: out.summary || '', steps: out.steps || [], source: 'ai' });
      setStage('review');
    } catch (e) {
      setError(e.message || 'Could not draft the journey. Try rephrasing what you want.');
    } finally { setDrafting(false); }
  };

  const createDraft = async () => {
    if (!journey) return;
    setError(''); setCreating(true);
    try {
      const channels = [...new Set((journey.steps || []).map((s) => (s.channel === 'sms' ? 'sms' : 'email')))];
      const channel = channels.length > 1 ? 'both' : (channels[0] || 'email');
      const steps = (journey.steps || []).map((s) => ({
        delayHours: Number(s.delayHours) || 0,
        subject: s.subject || '',
        body: s.body || '',
        ctaText: s.ctaText || '',
      }));
      const body = {
        title: journey.name,
        channel,
        campaignMode: 'sequence',
        dripStart: 'send',
        master: journey.name,
        subject: steps[0]?.subject || journey.name,
        body: steps[0]?.body || '',
        ctaText: steps[0]?.ctaText || '',
        steps,
      };
      const r = await api.createAction(entityId, body);
      setCreatedId(r?.action?.id || 'created');
      setStage('done');
    } catch (e) {
      setError(e.message || 'Could not create the draft campaign.');
    } finally { setCreating(false); }
  };

  const startOver = () => { setJourney(null); setDesc(''); setError(''); setCreatedId(''); setStage('choose'); };

  // ── Stage: review (read-only plain-language diagram) ──────────────────────
  if (stage === 'review' && journey) {
    const channels = [...new Set((journey.steps || []).map((s) => s.channel))];
    return (
      <div style={{ maxWidth: 640 }}>
        <button onClick={startOver} style={linkBtn}>← Start over</button>
        <div style={{ marginTop: 10, padding: '16px 16px 6px', border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
            {journey.source === 'ai' ? '✨ AI-drafted journey' : '📋 Recipe'} · review before creating
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', margin: '4px 0 6px' }}>{journey.name}</h2>
          {journey.goal && <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 8px' }}><strong style={{ color: 'var(--text)' }}>Goal:</strong> {journey.goal}</p>}
          {journey.summary && <p style={{ fontSize: 14, lineHeight: 1.5, margin: '0 0 4px' }}>{journey.summary}</p>}
        </div>

        {/* Read-only vertical flow — the "diagram" for J1. */}
        <div style={{ marginTop: 16 }}>
          {(journey.steps || []).map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 12 }}>
              {/* rail */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 28 }}>
                <div style={{ width: 28, height: 28, borderRadius: 999, background: 'var(--brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{i + 1}</div>
                {i < journey.steps.length - 1 && <div style={{ flex: 1, width: 2, background: 'var(--hairline)', minHeight: 18 }} />}
              </div>
              {/* card */}
              <div style={{ flex: 1, marginBottom: 14, padding: 14, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  {channelChip(s.channel)}
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{fmtDelay(s.delayHours)}</span>
                </div>
                {s.reactsTo && <div style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--muted)', marginBottom: 6 }}>↳ {s.reactsTo}</div>}
                {s.channel === 'email' && s.subject && <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 3 }}>{s.subject}</div>}
                {s.body && <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{s.body}</div>}
                {s.ctaText && <div style={{ marginTop: 8 }}><span style={{ display: 'inline-block', fontSize: 12, fontWeight: 700, color: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 8, padding: '3px 10px' }}>{s.ctaText} →</span></div>}
              </div>
            </div>
          ))}
        </div>

        {channels.length > 1 && (
          <div style={{ fontSize: 12, color: 'var(--muted)', background: 'rgba(128,128,128,0.08)', borderRadius: 8, padding: '8px 10px', marginBottom: 12 }}>
            This journey mixes email and SMS. In this first version the draft sends every step on both channels — per-step channel switching arrives with the full journey engine. You can adjust it in the Campaigns tab.
          </div>
        )}

        {error && <p style={{ color: 'var(--error)', fontSize: 13, marginBottom: 8 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={createDraft} disabled={creating} style={primaryBtn}>{creating ? 'Creating…' : 'Create as draft campaign'}</button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>You’ll add the audience and finalise copy before anything sends.</span>
        </div>
      </div>
    );
  }

  // ── Stage: done ───────────────────────────────────────────────────────────
  if (stage === 'done') {
    return (
      <div style={{ maxWidth: 560 }}>
        <div style={{ padding: 18, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)' }}>
          <div style={{ fontSize: 32, marginBottom: 6 }}>✅</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>Draft journey created</h2>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--muted)', margin: '0 0 14px' }}>
            “{journey?.name}” is saved as a <strong style={{ color: 'var(--text)' }}>draft</strong> on the <strong style={{ color: 'var(--text)' }}>Campaigns</strong> tab. Open it there to choose the audience, finalise the copy, and approve — nothing sends until you do.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a href="/engage/campaigns" style={{ ...primaryBtn, textDecoration: 'none', display: 'inline-block' }}>Go to Campaigns</a>
            <button onClick={startOver} style={secondaryBtn}>Build another</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Stage: choose (recipes + describe-with-AI) ────────────────────────────
  return (
    <div>
      {/* AI describe box */}
      <div style={{ padding: 16, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)', marginBottom: 22, maxWidth: 640 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>✨ Describe your journey</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>
          Tell us in plain language what you want — e.g. “Email people who didn’t finish checkout. If they still haven’t bought after two days, send an SMS with a reminder.”
        </p>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="When someone… then…"
          rows={3}
          style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--bg)', color: 'var(--text)', padding: 10, fontSize: 14, fontFamily: 'inherit' }}
        />
        {error && <p style={{ color: 'var(--error)', fontSize: 13, margin: '8px 0 0' }}>{error}</p>}
        <div style={{ marginTop: 10 }}>
          <button onClick={draftWithAI} disabled={drafting || !desc.trim()} style={{ ...primaryBtn, opacity: drafting || !desc.trim() ? 0.6 : 1 }}>
            {drafting ? 'Drafting…' : 'Draft with AI'}
          </button>
        </div>
      </div>

      {/* Recipe gallery */}
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Or start from a recipe</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {recipes.map((r) => (
          <button key={r.key} onClick={() => pickRecipe(r)} style={{
            textAlign: 'left', cursor: 'pointer', padding: 14, border: '1px solid var(--hairline)', borderRadius: 12,
            background: 'var(--card)', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ fontSize: 14.5, fontWeight: 700 }}>{r.label}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>{r.short}</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
              {(r.steps || []).map((s, i) => <span key={i}>{channelChip(s.channel)}</span>)}
            </div>
          </button>
        ))}
        {!recipes.length && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading recipes…</p>}
      </div>
    </div>
  );
}

const primaryBtn = { minHeight: 40, padding: '9px 16px', border: 'none', borderRadius: 10, background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const secondaryBtn = { minHeight: 40, padding: '9px 16px', border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--card)', color: 'var(--text)', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const linkBtn = { border: 'none', background: 'none', color: 'var(--muted)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 };
