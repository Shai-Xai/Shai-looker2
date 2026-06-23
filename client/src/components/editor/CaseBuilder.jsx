// A no-code builder for the common Looker "bucketing" table calculation:
//   case( when(matches_filter(${field}, `value`), "Label"), …, "Everything else" )
// Non-technical users pick a field and add value → label rows; we generate the
// expression. Expressions that don't fit this shape fall back to the raw editor
// (the parent decides), and `parseCaseWhen` returns null for them.

// Split a string on TOP-LEVEL commas, ignoring commas inside (), `back-ticks`
// and "quotes".
function splitTop(s) {
  const parts = [];
  let depth = 0, buf = '', inBack = false, inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inBack) { buf += ch; if (ch === '`') inBack = false; continue; }
    if (inQuote) { buf += ch; if (ch === '"') inQuote = false; continue; }
    if (ch === '`') { inBack = true; buf += ch; continue; }
    if (ch === '"') { inQuote = true; buf += ch; continue; }
    if (ch === '(') { depth++; buf += ch; continue; }
    if (ch === ')') { depth--; buf += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((p) => p.trim());
}

// Parse a case/when bucketing expression into { field, rows:[{value,label}],
// elseMode:'label'|'passthrough', elseLabel }. Returns null if it isn't this
// exact shape (mixed fields, non-string results, other conditions, …).
export function parseCaseWhen(expr) {
  const e = (expr || '').trim();
  const m = e.match(/^case\s*\(([\s\S]*)\)\s*$/i);
  if (!m) return null;
  const parts = splitTop(m[1]);
  if (!parts.length) return null;
  const rows = [];
  let field = null;
  let elseMode = 'label';
  let elseLabel = '';
  let elseFromCatchAll = false; // a when(yes, …) — wins over any trailing default
  for (const p of parts) {
    const wm = p.match(/^when\s*\(([\s\S]*)\)$/i);
    if (wm) {
      const inner = splitTop(wm[1]);
      if (inner.length < 2) return null;
      const cond = inner[0].trim();
      const result = inner.slice(1).join(',').trim();
      const lm = result.match(/^"([\s\S]*)"$/);
      if (!lm) return null;
      const label = lm[1];
      if (/^yes$/i.test(cond)) { elseMode = 'label'; elseLabel = label; elseFromCatchAll = true; continue; }
      const fm = cond.match(/^matches_filter\s*\(\s*\$\{([^}]+)\}\s*,\s*`([\s\S]*)`\s*\)$/i);
      if (!fm) return null;
      const f = fm[1].trim();
      if (field && field !== f) return null;
      field = f;
      rows.push({ value: fm[2], label });
    } else {
      // Trailing default — only meaningful when no catch-all when(yes) preceded
      // it (Looker returns the catch-all first, leaving this unreachable).
      if (elseFromCatchAll) continue;
      const lm = p.match(/^"([\s\S]*)"$/);
      if (lm) { elseMode = 'label'; elseLabel = lm[1]; }
      else if (/^concat\s*\(/i.test(p)) { elseMode = 'passthrough'; }
      else return null;
    }
  }
  if (!rows.length || !field) return null;
  return { field, rows, elseMode, elseLabel };
}

export function buildCaseWhen({ field, rows, elseMode, elseLabel }) {
  const lines = (rows || []).map((r) => `  when(matches_filter(\${${field}}, \`${r.value}\`), "${r.label}")`);
  const elseLine = elseMode === 'passthrough' ? `  concat(\${${field}}, "")` : `  "${elseLabel || ''}"`;
  return `case(\n${[...lines, elseLine].join(',\n')}\n)`;
}

// A raw matcher value ↔ a friendly { op, text }. matches_filter takes Looker
// filter syntax: `%x%` = contains, `NULL` = blank, plain = exact.
function valToOp(value) {
  if (/^NULL$/i.test(value)) return { op: 'blank', text: '' };
  const c = value.match(/^%([\s\S]*)%$/);
  if (c) return { op: 'contains', text: c[1] };
  return { op: 'is', text: value };
}
function opToVal(op, text) {
  if (op === 'blank') return 'NULL';
  if (op === 'contains') return `%${text}%`;
  return text;
}

export default function CaseBuilder({ expression, fields = [], onChange }) {
  const parsed = parseCaseWhen(expression) || { field: fields[0] || '', rows: [{ value: '', label: '' }], elseMode: 'label', elseLabel: 'Other' };
  const push = (next) => onChange(buildCaseWhen(next));
  const setField = (f) => push({ ...parsed, field: f });
  const setRow = (i, patch) => push({ ...parsed, rows: parsed.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const addRow = () => push({ ...parsed, rows: [...parsed.rows, { value: '', label: '' }] });
  const removeRow = (i) => push({ ...parsed, rows: parsed.rows.filter((_, j) => j !== i) });

  // Field options: the query's fields plus the parsed field if it isn't listed.
  const fieldOpts = [...new Set([parsed.field, ...fields].filter(Boolean))];

  return (
    <div style={wrap}>
      <Lbl>Group by field</Lbl>
      <select style={input} value={parsed.field} onChange={(e) => setField(e.target.value)}>
        {parsed.field === '' && <option value="">Pick a field…</option>}
        {fieldOpts.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>

      <Lbl>Rules — first match wins</Lbl>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {parsed.rows.map((r, i) => {
          const { op, text } = valToOp(r.value);
          return (
            <div key={i} style={ruleCard}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={miniLbl}>If</span>
                <select style={{ ...input, flex: '0 0 96px', padding: '6px 8px' }} value={op} onChange={(e) => setRow(i, { value: opToVal(e.target.value, text) })}>
                  <option value="is">is</option>
                  <option value="contains">contains</option>
                  <option value="blank">is blank</option>
                </select>
                {op !== 'blank' && (
                  <input style={{ ...input, flex: 1, padding: '6px 8px' }} value={text} placeholder="value" onChange={(e) => setRow(i, { value: opToVal(op, e.target.value) })} />
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                <span style={miniLbl}>→</span>
                <input style={{ ...input, flex: 1, padding: '6px 8px' }} value={r.label} placeholder="label to show" onChange={(e) => setRow(i, { label: e.target.value })} />
                <button style={delBtn} title="Remove rule" onClick={() => removeRow(i)}>✕</button>
              </div>
            </div>
          );
        })}
      </div>
      <button style={addBtn} onClick={addRow}>+ Add rule</button>

      <Lbl>Everything else</Lbl>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select style={{ ...input, flex: '0 0 150px', padding: '6px 8px' }} value={parsed.elseMode} onChange={(e) => push({ ...parsed, elseMode: e.target.value })}>
          <option value="label">Show a label</option>
          <option value="passthrough">Keep original value</option>
        </select>
        {parsed.elseMode === 'label' && (
          <input style={{ ...input, flex: 1, padding: '6px 8px' }} value={parsed.elseLabel} placeholder="e.g. Other" onChange={(e) => push({ ...parsed, elseLabel: e.target.value })} />
        )}
      </div>
    </div>
  );
}

function Lbl({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '12px 0 5px' }}>{children}</div>;
}
const wrap = { marginTop: 6 };
const input = { width: '100%', padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--card)', color: 'var(--text)' };
const ruleCard = { border: '1px solid var(--hairline)', borderRadius: 8, padding: 8, background: 'var(--elevated, rgba(128,128,128,0.05))' };
const miniLbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', width: 18, flexShrink: 0 };
const addBtn = { marginTop: 8, padding: '7px 12px', background: 'var(--card)', border: '1.5px solid var(--hairline)', borderRadius: 980, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', color: 'var(--text)' };
const delBtn = { flexShrink: 0, border: 'none', background: 'transparent', color: 'var(--error)', cursor: 'pointer', fontSize: 13, fontWeight: 700 };
