import { useState, useEffect, useRef } from 'react';

// Rotating one-liners shown while the Owl is thinking — keeps the wait warm
// instead of a dead spinner. Quips rotate every ~2.4s with a soft fade, in a
// shuffled order so repeat visits don't feel canned.
const QUIPS = [
  'Counting tickets twice, so you don’t have to…',
  'Interrogating the bar sales… they’re talking.',
  'Asking the data to name its sources…',
  'Cross-examining yesterday vs today…',
  'Hooting at slow queries to hurry them up…',
  'Reading the queue like a setlist…',
  'Comparing this to every Friday on record…',
  'Following the money — through the fees…',
  'Checking who actually used their comps…',
  'Sweeping the dashboards for plot twists…',
  'Doing the maths so the maths doesn’t do you…',
  'Owl eyes on. Spreadsheets fear me.',
  'Sorting the signal from the confetti…',
  'Tallying the till, one beep at a time…',
  'Politely asking Looker to step on it…',
  'Triangulating the hype against the numbers…',
  'Counting heads, not just hopes…',
  'Listening for what the refunds aren’t saying…',
  'Turning rows and columns into a story…',
  'Almost there — just sanity-checking a spike…',
];

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export default function OwlQuips({ prefix = '🦉', style }) {
  const order = useRef(shuffled(QUIPS));
  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setInterval(() => {
      setVisible(false);
      setTimeout(() => { setIdx((i) => (i + 1) % order.current.length); setVisible(true); }, 260);
    }, 2400);
    return () => clearInterval(t);
  }, []);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--muted)', fontSize: 12.5, fontStyle: 'italic', minHeight: 18, transition: 'opacity 0.25s', opacity: visible ? 1 : 0, ...style }}>
      <span style={{ fontStyle: 'normal' }}>{prefix}</span> {order.current[idx]}
    </span>
  );
}
