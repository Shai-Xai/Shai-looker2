import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import JourneyTree, { countDecisions } from './JourneyTree.jsx';

// Engage → Journeys. Journeys are built by talking to THE Owl — the same
// assistant behind the floating owl button — which drafts the branching
// decision tree in chat (its draftJourney tool) and shows a confirm card
// there. This tab is the front door: open the Owl with one tap, plus starter
// recipes you can preview as trees and hand to the Owl as a first message.
// No separate journey chatbot lives here.

const EXAMPLE_ASKS = [
  'Build an abandoned-cart journey — email right away, and if they don’t open within 2 days, send an SMS.',
  'Win back people who haven’t bought in a while; if they open but don’t buy, follow up with a different email.',
  'Pre-event journey: reminder email 3 days out, SMS on the day.',
];

export default function JourneyWizard({ entityId }) {
  const [recipes, setRecipes] = useState([]);
  const [preview, setPreview] = useState(null); // recipe being previewed as a tree

  useEffect(() => { api.journeyRecipes(entityId).then((r) => setRecipes(r.recipes || [])).catch(() => setRecipes([])); }, [entityId]);

  const openOwl = () => { try { window.dispatchEvent(new Event('howler:open-analyst')); } catch { /* ignore */ } };

  return (
    <div>
      {/* The front door: the Owl */}
      <div style={{ maxWidth: 720, padding: 18, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>🦉 Build a journey with the Owl</div>
        <p style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--muted)', margin: '0 0 12px' }}>
          Open the Owl and tell it what you want — it drafts the whole branching journey (steps, timing, copy) right in the chat, targets your saved audiences by name, and refines it as you talk. When you're happy, tap <strong style={{ color: 'var(--text)' }}>Create draft journey</strong> in the chat and it lands on the Campaigns tab for you to finish and approve.
        </p>
        <button onClick={openOwl} style={primaryBtn}>Ask the Owl</button>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>Try saying</div>
          {EXAMPLE_ASKS.map((t, i) => (
            <div key={i} style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic' }}>“{t}”</div>
          ))}
        </div>
      </div>

      {/* Starter recipes — previewable trees the Owl can run with */}
      {recipes.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Starter journeys — tap to preview</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {recipes.map((r) => {
              const on = preview?.key === r.key;
              return (
                <button key={r.key} onClick={() => setPreview(on ? null : r)} style={{ fontSize: 12.5, fontWeight: on ? 700 : 600, color: on ? '#fff' : 'var(--text)', background: on ? 'var(--brand)' : 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '7px 13px', cursor: 'pointer' }}>
                  {r.label}{countDecisions(r.nodes) > 0 ? ' ◆' : ''}
                </button>
              );
            })}
          </div>
          {preview && (
            <div style={{ marginTop: 14 }}>
              <p style={{ maxWidth: 720, fontSize: 13.5, lineHeight: 1.5, color: 'var(--muted)', margin: '0 0 4px' }}>{preview.summary}</p>
              <JourneyTree nodes={preview.nodes} />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <button onClick={openOwl} style={primaryBtn}>Build this with the Owl</button>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Ask it for “{preview.label.toLowerCase()}” and tweak anything — audience, timing, copy, branches.</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const primaryBtn = { minHeight: 40, padding: '9px 16px', border: 'none', borderRadius: 10, background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
