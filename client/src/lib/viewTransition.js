import { flushSync } from 'react-dom';

// Cross-fade between routes using the native View Transitions API where it's
// supported (Chrome/Edge/Safari 18+). Elsewhere — or when the user prefers
// reduced motion — it just navigates instantly. flushSync forces React to
// commit the route change inside the transition so the API captures the new
// DOM, not the old one.
const reduced = typeof window !== 'undefined'
  && window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function vtNavigate(navigate, to) {
  if (reduced || typeof document === 'undefined' || !document.startViewTransition) {
    navigate(to);
    return;
  }
  try {
    document.startViewTransition(() => flushSync(() => navigate(to)));
  } catch {
    navigate(to);
  }
}
