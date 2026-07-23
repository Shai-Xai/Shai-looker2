// Event picker for anywhere Pulse asks "which Howler event?" — a dropdown of
// the client's events (suites with a linked howler_event_id, read from
// /api/my/suites which admins can call too) instead of a bare numeric field.
// Falls back to manual entry when the client has no linked events, when the
// current value isn't in the list, or when the user picks "Type an ID…".
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/** The entity's events as [{id, name}] — linked suites first, then any extra
 * ids the caller already knows about (e.g. event communities). */
export function useEntityEvents(entityId, extraIds = []) {
  const [events, setEvents] = useState([]);
  const extraKey = extraIds.filter(Boolean).join(',');
  useEffect(() => {
    let on = true;
    api.mySuites()
      .then((suites) => {
        if (!on) return;
        const out = [];
        const seen = new Set();
        for (const s of suites || []) {
          if (s.entityId === entityId && s.howlerEventId && !seen.has(s.howlerEventId)) {
            seen.add(s.howlerEventId);
            out.push({ id: s.howlerEventId, name: s.name });
          }
        }
        for (const id of extraKey ? extraKey.split(',') : []) {
          if (!seen.has(id)) { seen.add(id); out.push({ id, name: `Event ${id}` }); }
        }
        setEvents(out);
      })
      .catch(() => { /* dropdown is progressive enhancement — input remains */ });
    return () => { on = false; };
  }, [entityId, extraKey]);
  return events;
}

export default function EventSelect({ value, onChange, events, style = {}, inputStyle = {} }) {
  const [manual, setManual] = useState(false);
  const known = events.some((e) => e.id === value);
  const showInput = events.length === 0 || manual || (!!value && !known);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {events.length > 0 && (
        <select
          style={style}
          value={showInput ? '__manual' : (value || '')}
          onChange={(e) => {
            if (e.target.value === '__manual') { setManual(true); onChange(''); }
            else { setManual(false); onChange(e.target.value); }
          }}
        >
          <option value="">Pick an event…</option>
          {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.name} · {ev.id}</option>)}
          <option value="__manual">✏️ Type an ID…</option>
        </select>
      )}
      {showInput && (
        <input
          style={inputStyle}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
          placeholder="Event ID"
          inputMode="numeric"
        />
      )}
    </span>
  );
}
