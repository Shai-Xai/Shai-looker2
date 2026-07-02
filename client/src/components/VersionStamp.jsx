import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Tiny build stamp for the bottom-left profile footers (client shell + admin
// console) — answers "what version is this user on?" at a glance. The server
// resolves it once at boot (build date · git commit, /api/version); fetched once
// per app load and cached module-wide.
let cache = null;
export default function VersionStamp() {
  const [v, setV] = useState(cache);
  useEffect(() => {
    if (cache) return undefined;
    let alive = true;
    api.version().then((r) => { cache = r?.version || ''; if (alive) setV(cache); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!v) return null;
  return <div title="App version — build date · commit" style={{ padding: '3px 10px 0', fontSize: 10, color: 'var(--muted)', opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>v{v}</div>;
}
