import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactECharts from 'echarts-for-react/lib/core';
import echarts from '../lib/echarts.js';
import { api } from '../lib/api.js';
import { chartPalette } from '../lib/brand.js';
import { useAuth } from '../lib/auth.jsx';
import { useTheme } from '../lib/theme.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useCountUp } from '../lib/useCountUp.js';
import { fmtR, fmtQty, deriveCategory, deriveSubCategory, variantLabel } from '../lib/money.js';
import { StatusBadge, KindBadge } from './SettlementsPage.jsx';
import InsightModal from '../components/InsightModal.jsx';
import AiMark from '../components/AiMark.jsx';
import { ScopeProvider } from '../lib/ScopeContext.jsx';

// Interactive settlement report: the money story (turnover → fees → advances →
// value due) as a waterfall, with every PDF section as a collapsible,
// searchable table underneath. Each section has its own Owl insight + notes.
export default function SettlementViewPage() {
  const { id } = useParams();
  const isMobile = useIsMobile();
  const { user, insightsEnabled } = useAuth();
  const { theme } = useTheme();
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState([]);
  const [noteMode, setNoteMode] = useState(false); // header toggle reveals per-section note editors
  const [owlCtx, setOwlCtx] = useState(null); // { tile, data }

  useEffect(() => {
    setS(null); setError(null);
    api.getSettlement(id).then((d) => { setS(d); setNotes(d.notes || []); }).catch((e) => setError(e.message));
  }, [id]);

  // Persist the whole notes array whenever it changes (after the initial load).
  const persist = useCallback((next) => {
    setNotes(next);
    api.saveSettlementNotes(id, next).then((r) => setNotes(r.notes)).catch(() => {});
  }, [id]);

  const addNote = useCallback((section, sectionLabel, text) => {
    const t = text.trim();
    if (!t) return;
    persist([...notes, { id: (crypto.randomUUID?.() || String(Math.random()).slice(2)), section, sectionLabel, text: t, author: user?.email || '', at: new Date().toISOString() }]);
  }, [notes, persist, user]);
  const deleteNote = useCallback((noteId) => persist(notes.filter((n) => n.id !== noteId)), [notes, persist]);

  const openOwl = useCallback((key, title, ctx, data) => {
    setOwlCtx({ tile: { id: `settlement-${id}-${key}`, title, vis: { type: 'looker_grid' }, aiContext: ctx }, data });
  }, [id]);

  if (error) return <Centered error>Error: {error}</Centered>;
  if (!s) return <Centered>Loading report…</Centered>;

  const d = s.data || {};
  const meta = d.meta || {};
  const dark = theme === 'dark';
  const advTotal = d.advances?.subtotal ?? 0;
  const MONEY_CTX = 'This is an event settlement report: gross ticketing turnover, Howler commissions/fees deducted (negative amounts), advance payments already paid to the client, and the final value due. Withholding tax lines are tax credits. Help the client understand where the money went.';

  const sectionProps = (key, label, ctx, owlData) => ({
    sectionKey: key, sectionLabel: label, notes, noteMode, onAddNote: addNote, onDeleteNote: deleteNote,
    owl: insightsEnabled ? () => openOwl(key, `${meta.eventName || s.title} — ${label}`, ctx, owlData) : null,
  });

  return (
    <ScopeProvider suiteId={null} dashboardContext="">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Header */}
        <div style={{ background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid var(--hairline)', padding: isMobile ? '12px 14px' : '14px 22px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link to="/settlements" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none', flexShrink: 0 }}>← Settlements</Link>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{meta.eventName || s.title}</h2>
              <KindBadge kind={s.kind} />
              <StatusBadge status={s.status} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {[meta.venue, meta.eventDates, meta.settlementDate && `Settled ${meta.settlementDate}`].filter(Boolean).join(' · ')}
            </div>
          </div>
          <button
            style={{ ...pillBtn, ...(noteMode ? { background: 'var(--brand)', color: '#fff' } : null) }}
            onClick={() => setNoteMode((v) => !v)}
            title={noteMode ? 'Done adding notes' : 'Add notes to sections'}
          >
            📝 {!isMobile && (noteMode ? 'Done' : 'Notes')}
            {notes.length > 0 && <span style={{ ...noteCount, ...(noteMode ? { background: '#fff', color: 'var(--brand)' } : null) }}>{notes.length}</span>}
          </button>
          {insightsEnabled && (
            <button className="btn-key" style={pillBtn} onClick={() => openOwl('overview', `${meta.eventName || s.title} — Settlement`, MONEY_CTX, buildOwlData(d))} title="Ask the Owl about the whole settlement">
              <AiMark size={18} /> {!isMobile && 'Ask the Owl'}
            </button>
          )}
          {s.hasFile && (
            <a href={`/api/settlements/${s.id}/file`} style={{ ...pillBtn, textDecoration: 'none' }} title="Download the original PDF">⤓ {!isMobile && 'PDF'}</a>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: isMobile ? 12 : 22 }}>
          <div style={{ maxWidth: 1060, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: isMobile ? 12 : 16 }}>

            {/* KPI strip */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: isMobile ? 10 : 14 }}>
              <Kpi label="Total turnover" value={d.turnover} delay={0} />
              <Kpi label="Howler commissions" value={d.commissionsTotal} delay={70} />
              <Kpi label="Advances paid" value={advTotal} delay={140} />
              <Kpi label="Value due to you" value={d.valueDue} delay={210} highlight />
            </div>

            {/* Notes summary across the whole report */}
            {notes.length > 0 && <NotesSummary notes={notes} onDelete={deleteNote} />}

            {/* The money story */}
            <Section title="Where the money went" subtitle="From gross turnover to your final settlement" defaultOpen {...sectionProps('money', 'Where the money went', MONEY_CTX, buildOwlData(d))}>
              <Waterfall d={d} dark={dark} isMobile={isMobile} />
            </Section>

            {/* Ticket sales */}
            {(d.sales || []).map((g, i) => (
              <Section key={i} title={g.name} defaultOpen={i === 0} summary={fmtR(g.subtotal?.total)} {...sectionProps(`sales-${i}`, g.name, `Ticket sales section "${g.name}" from an event settlement report (amounts in ZAR; negative = refunds/adjustments). Categories are derived from the ticket names.`, salesOwl(g))}>
                <SalesTable group={g} isMobile={isMobile} />
              </Section>
            ))}

            {/* Commissions */}
            {(d.commissions || []).length > 0 && (
              <Section title="Howler commissions & fees" summary={fmtR(d.commissionsTotal)} defaultOpen={false} {...sectionProps('commissions', 'Howler commissions & fees', 'Howler commission and fee lines deducted from the settlement (negative amounts). Withholding tax lines are tax credits.', commissionsOwl(d))}>
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '300px 1fr', gap: 16, alignItems: 'start' }}>
                  <CommissionDonut groups={d.commissions} dark={dark} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
                    {d.commissions.map((g, i) => (
                      <div key={i}>
                        <div style={groupHead}><span>{g.name}</span><span style={{ color: numColor(g.subtotal?.total) }}>{fmtR(g.subtotal?.total)}</span></div>
                        <CommissionTable group={g} isMobile={isMobile} />
                      </div>
                    ))}
                  </div>
                </div>
              </Section>
            )}

            {/* Advances + payment timeline */}
            {((d.advances?.rows || []).length > 0 || (d.settlementSummary || []).length > 0) && (
              <Section title="Payments to you" summary={d.settlementSummary?.length ? fmtR(d.settlementSummary.reduce((a, r) => a + (r.amount || 0), 0)) : ''} defaultOpen {...sectionProps('payments', 'Payments to you', 'Payments made to the client over time: net settlements paid, advance payments, and withheld portions (held then released). Amounts in ZAR.', paymentsOwl(d))}>
                {(d.settlementSummary || []).length > 0 && <PaymentsChart d={d} dark={dark} isMobile={isMobile} />}
                {(d.advances?.rows || []).length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={groupHead}><span>Advance payments</span><span style={{ color: numColor(d.advances.subtotal) }}>{fmtR(d.advances.subtotal)}</span></div>
                    <SimpleTable cols={['Date', 'Description', 'Amount']} rows={(d.advances.rows || []).map((r) => [r.date, r.desc, fmtR(r.value)])} numericFrom={2} />
                  </div>
                )}
                {(d.withheldSummary || []).length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={groupHead}><span>Withheld portion</span></div>
                    <SimpleTable cols={['Date', 'Description', 'Amount']} rows={(d.withheldSummary || []).map((r) => [r.date, r.desc, fmtR(r.amount)])} negIdx={2} numericFrom={2} />
                  </div>
                )}
              </Section>
            )}

            <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', padding: '4px 0 14px' }}>
              Generated from the official settlement report{meta.settlementPeriod ? ` · period ${meta.settlementPeriod}` : ''}. The PDF download is the authoritative document.
            </p>
          </div>
        </div>

        {owlCtx && <InsightModal key={owlCtx.tile.id} tile={owlCtx.tile} data={owlCtx.data} filters={{}} onClose={() => setOwlCtx(null)} />}
      </div>
    </ScopeProvider>
  );
}

// ─── KPI card ─────────────────────────────────────────────────────────────────
function Kpi({ label, value, delay, highlight }) {
  const text = useCountUp(value != null ? fmtR(value) : '—');
  return (
    <div className="tile-enter" style={{
      animationDelay: `${delay}ms`,
      background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: '14px 16px',
      ...(highlight ? { borderColor: 'rgba(52,199,89,0.5)', background: 'linear-gradient(135deg, rgba(52,199,89,0.10), transparent 70%) var(--tile-bg, var(--card))' } : null),
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'clamp(15px, 2.1vw, 24px)', fontWeight: 800, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: highlight ? '#2da44e' : numColor(value) }}>{text}</div>
    </div>
  );
}

// ─── Section with Owl + notes ─────────────────────────────────────────────────
// The Owl button is hover-revealed (same .insight-btn treatment as dashboard
// tiles; always visible on touch). Note editors stay hidden until the report's
// header "Notes" toggle turns note mode on — then every section shows its
// editor and auto-expands.
function Section({ title, subtitle, summary, defaultOpen = true, sectionKey, sectionLabel, notes = [], noteMode, onAddNote, onDeleteNote, owl, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const mine = notes.filter((n) => n.section === sectionKey);
  const expanded = open || noteMode;
  return (
    <div className="howler-tile" style={{ background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px' }}>
        <button onClick={() => setOpen((v) => !v)} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text)', textAlign: 'left', padding: 0 }}>
          <span className="nav-caret" style={{ fontSize: 10, color: 'var(--muted)', transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .2s', flexShrink: 0 }}>▶</span>
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
            {subtitle && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>{subtitle}</span>}
          </span>
        </button>
        {summary && <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--muted-2)', flexShrink: 0 }}>{summary}</span>}
        {mine.length > 0 && !noteMode && <span title={`${mine.length} note${mine.length === 1 ? '' : 's'}`} style={{ ...noteCount, flexShrink: 0 }}>{mine.length}</span>}
        {owl && (
          <button className="insight-btn btn-key" onClick={owl} title="Ask the Owl about this section" style={{ ...iconAction, padding: '4px 6px', border: '1px solid var(--ai-border)', background: 'var(--ai-bg)', borderRadius: 7 }}>
            <AiMark size={17} />
          </button>
        )}
      </div>
      <div className={`collapsey${expanded ? ' open' : ''}`}>
        <div className="collapsey-inner">
          <div style={{ padding: '2px 14px 16px' }}>
            {noteMode && <NotesPanel notes={mine} onAdd={(t) => onAddNote(sectionKey, sectionLabel, t)} onDelete={onDeleteNote} />}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Notes ────────────────────────────────────────────────────────────────────
function NotesPanel({ notes, onAdd, onDelete }) {
  const [text, setText] = useState('');
  return (
    <div style={{ background: 'var(--elevated)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 12, marginBottom: 14 }}>
      {notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {notes.map((n) => <NoteRow key={n.id} n={n} onDelete={onDelete} />)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Add a note about this section…"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { onAdd(text); setText(''); } }}
          style={{ flex: 1, border: '1px solid var(--hairline)', borderRadius: 9, padding: '8px 10px', fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit', background: 'var(--card)', color: 'var(--text)' }}
        />
        <button onClick={() => { onAdd(text); setText(''); }} disabled={!text.trim()} style={{ ...miniSolid, opacity: text.trim() ? 1 : 0.5 }}>Add</button>
      </div>
    </div>
  );
}

function NoteRow({ n, onDelete }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
      <span style={{ color: 'var(--brand)', lineHeight: 1.5 }}>•</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{n.text}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{n.author || 'someone'} · {fmtWhen(n.at)}</div>
      </div>
      <button onClick={() => onDelete(n.id)} title="Delete note" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 2, flexShrink: 0 }}>✕</button>
    </div>
  );
}

// All notes across the report, grouped by section.
function NotesSummary({ notes, onDelete }) {
  const [open, setOpen] = useState(true);
  const bySection = [];
  for (const n of notes) {
    let g = bySection.find((x) => x.section === n.section);
    if (!g) { g = { section: n.section, label: n.sectionLabel || n.section, items: [] }; bySection.push(g); }
    g.items.push(n);
  }
  return (
    <div className="howler-tile" style={{ background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text)', textAlign: 'left' }}>
        <span style={{ fontSize: 15 }}>📝</span>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>Notes</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{notes.length} note{notes.length === 1 ? '' : 's'}</span>
        <span className="nav-caret" style={{ fontSize: 10, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
      </button>
      <div className={`collapsey${open ? ' open' : ''}`}>
        <div className="collapsey-inner">
          <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {bySection.map((g) => (
              <div key={g.section}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6 }}>{g.label}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {g.items.map((n) => <NoteRow key={n.id} n={n} onDelete={onDelete} />)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Waterfall ────────────────────────────────────────────────────────────────
function Waterfall({ d, dark, isMobile }) {
  const option = useMemo(() => {
    const steps = [
      { label: 'Turnover', delta: d.turnover || 0, color: '#7c3aed' },
      ...(d.commissions || []).map((g) => ({ label: shortName(g.name), delta: g.subtotal?.total || 0, color: chartPalette()[1] })),
      { label: 'Advances paid', delta: d.advances?.subtotal || 0, color: '#8e8e93' },
      { label: 'Due to you', total: d.valueDue || 0, color: '#34c759' },
    ];
    let cum = 0;
    const base = [], bars = [], labels = [];
    for (const st of steps) {
      if (st.total !== undefined) { base.push(0); bars.push({ value: st.total, itemStyle: { color: st.color, borderRadius: [6, 6, 0, 0] } }); labels.push(st); continue; }
      const next = cum + st.delta;
      base.push(Math.min(cum, next));
      bars.push({ value: Math.abs(st.delta), itemStyle: { color: st.color, borderRadius: st.delta >= 0 ? [6, 6, 0, 0] : [0, 0, 6, 6] } });
      labels.push(st);
      cum = next;
    }
    const axisC = dark ? '#9a9aa2' : '#86868b';
    const splitC = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';
    return {
      animationDuration: 800, animationEasing: 'cubicOut',
      grid: { left: 8, right: 8, top: 30, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: dark ? '#26262c' : '#fff', borderColor: dark ? '#3a3a42' : '#e5e5ea',
        textStyle: { color: dark ? '#f3f3f6' : '#1d1d1f', fontSize: 12 },
        formatter: (ps) => { const i = ps[0].dataIndex; const st = labels[i]; const v = st.total !== undefined ? st.total : st.delta; return `<b>${st.label}</b><br/>${fmtR(v)}`; },
      },
      xAxis: { type: 'category', data: labels.map((s) => s.label), axisLabel: { color: axisC, fontSize: isMobile ? 9 : 11, interval: 0, rotate: isMobile ? 28 : 0 }, axisLine: { lineStyle: { color: splitC } }, axisTick: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: axisC, fontSize: 10, formatter: (v) => fmtR(v, { compact: true }) }, splitLine: { lineStyle: { color: splitC } } },
      series: [
        { type: 'bar', stack: 'w', itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } }, tooltip: { show: false }, data: base, barWidth: isMobile ? '52%' : '44%' },
        { type: 'bar', stack: 'w', data: bars, label: { show: !isMobile, position: 'top', fontSize: 10, fontWeight: 700, color: dark ? '#d6d6de' : '#48484e', formatter: (p) => { const st = labels[p.dataIndex]; const v = st.total !== undefined ? st.total : st.delta; return fmtR(v, { compact: true }); } } },
      ],
    };
  }, [d, dark, isMobile]);
  return <ReactECharts echarts={echarts} option={option} style={{ height: isMobile ? 240 : 320 }} notMerge />;
}

// ─── Commission mix donut ─────────────────────────────────────────────────────
function CommissionDonut({ groups, dark }) {
  const option = useMemo(() => ({
    animationDuration: 700,
    tooltip: { backgroundColor: dark ? '#26262c' : '#fff', borderColor: dark ? '#3a3a42' : '#e5e5ea', textStyle: { color: dark ? '#f3f3f6' : '#1d1d1f', fontSize: 12 }, formatter: (p) => `<b>${p.name}</b><br/>${fmtR(-p.value)} (${p.percent}%)` },
    series: [{
      type: 'pie', radius: ['52%', '78%'], center: ['50%', '50%'],
      itemStyle: { borderColor: dark ? '#1a1a1f' : '#fff', borderWidth: 2 },
      label: { show: true, fontSize: 10, color: dark ? '#9a9aa2' : '#6e6e73', formatter: '{b}\n{d}%' },
      data: groups.map((g, i) => ({ name: shortName(g.name), value: Math.abs(g.subtotal?.total || 0), itemStyle: { color: chartPalette()[i % 4] } })),
    }],
  }), [groups, dark]);
  return <ReactECharts echarts={echarts} option={option} style={{ height: 230 }} notMerge />;
}

// ─── Payments over time ───────────────────────────────────────────────────────
function PaymentsChart({ d, dark, isMobile }) {
  const option = useMemo(() => {
    const dates = [...new Set([...(d.settlementSummary || []).map((r) => r.date), ...(d.withheldSummary || []).map((r) => r.date)])].sort();
    const paid = dates.map((dt) => (d.settlementSummary || []).filter((r) => r.date === dt).reduce((a, r) => a + (r.amount || 0), 0));
    const withheld = dates.map((dt) => (d.withheldSummary || []).filter((r) => r.date === dt).reduce((a, r) => a + (r.amount || 0), 0));
    const axisC = dark ? '#9a9aa2' : '#86868b';
    const splitC = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';
    return {
      animationDuration: 700,
      grid: { left: 8, right: 8, top: 30, bottom: 4, containLabel: true },
      legend: { top: 0, textStyle: { color: axisC, fontSize: 11 }, itemWidth: 14, itemHeight: 9 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: dark ? '#26262c' : '#fff', borderColor: dark ? '#3a3a42' : '#e5e5ea', textStyle: { color: dark ? '#f3f3f6' : '#1d1d1f', fontSize: 12 }, valueFormatter: (v) => fmtR(v) },
      xAxis: { type: 'category', data: dates, axisLabel: { color: axisC, fontSize: 10 }, axisLine: { lineStyle: { color: splitC } }, axisTick: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: axisC, fontSize: 10, formatter: (v) => fmtR(v, { compact: true }) }, splitLine: { lineStyle: { color: splitC } } },
      series: [
        { name: 'Paid to you', type: 'bar', data: paid, itemStyle: { color: '#34c759', borderRadius: [5, 5, 0, 0] }, barWidth: '32%' },
        { name: 'Withheld / released', type: 'bar', data: withheld, itemStyle: { color: '#f59e0b', borderRadius: [5, 5, 0, 0] }, barWidth: '32%' },
      ],
    };
  }, [d, dark]);
  return <ReactECharts echarts={echarts} option={option} style={{ height: isMobile ? 200 : 240 }} notMerge />;
}

// ─── Sales table: flat or grouped-by-category, with search ────────────────────
function SalesTable({ group, isMobile }) {
  const rows = useMemo(() => group.rows || [], [group]);
  // Two-level roll-up: Category → Sub-category (phase) → line items.
  const cats = useMemo(() => {
    const acc = (o, r) => { o.qty += r.qty || 0; o.sales += r.sales || 0; o.fees += r.fees || 0; o.total += r.total || 0; };
    const map = new Map();
    for (const r of rows) {
      const c = deriveCategory(r.desc);
      if (!map.has(c)) map.set(c, { category: c, rows: [], subMap: new Map(), qty: 0, sales: 0, fees: 0, total: 0 });
      const g = map.get(c);
      g.rows.push(r); acc(g, r);
      const sub = deriveSubCategory(r.desc) || '—';
      if (!g.subMap.has(sub)) g.subMap.set(sub, { sub, rows: [], qty: 0, sales: 0, fees: 0, total: 0 });
      const sg = g.subMap.get(sub); sg.rows.push(r); acc(sg, r);
    }
    return [...map.values()].map((g) => ({
      ...g,
      subs: [...g.subMap.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
      // Only worth a sub-category level when the category actually splits into
      // more than one phase (otherwise nest straight to the rows).
      nested: g.subMap.size > 1,
    })).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  }, [rows]);
  const canGroup = cats.length > 1 && rows.length > 6;
  const [grouped, setGrouped] = useState(canGroup);
  const [q, setQ] = useState('');
  const st = group.subtotal || {};
  const flat = !grouped || q.trim();
  const filtered = rows.filter((r) => !q.trim() || (r.desc || '').toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        {rows.length > 6 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search line items…" style={{ flex: 1, minWidth: 180, maxWidth: 320, border: '1px solid var(--hairline)', borderRadius: 980, padding: '7px 14px', fontSize: 13, outline: 'none', boxSizing: 'border-box', background: 'var(--card)', color: 'var(--text)' }} />
        )}
        {canGroup && (
          <div style={{ display: 'inline-flex', background: 'var(--elevated)', border: '1px solid var(--hairline)', borderRadius: 980, padding: 2 }}>
            <Toggle on={grouped && !q.trim()} onClick={() => { setGrouped(true); setQ(''); }}>By category</Toggle>
            <Toggle on={!grouped || !!q.trim()} onClick={() => setGrouped(false)}>All items</Toggle>
          </div>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={tbl}>
          <thead>
            <tr>
              <th style={th}>{flat ? 'Item' : 'Category'}</th>
              {!isMobile && flat && <th style={th}>Type</th>}
              <th style={{ ...th, textAlign: 'right' }}>Qty</th>
              {!isMobile && <th style={{ ...th, textAlign: 'right' }}>Sales</th>}
              {!isMobile && <th style={{ ...th, textAlign: 'right' }}>Fees</th>}
              <th style={{ ...th, textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {flat
              ? filtered.map((r, i) => (
                <tr key={i} style={{ background: i % 2 ? 'var(--row-stripe)' : 'transparent' }}>
                  <td style={td}>{r.desc}</td>
                  {!isMobile && <td style={{ ...td, color: 'var(--muted)' }}>{r.type}</td>}
                  <td style={{ ...td, ...num, color: numColor(r.qty) }}>{fmtQty(r.qty)}</td>
                  {!isMobile && <td style={{ ...td, ...num, color: numColor(r.sales) }}>{fmtR(r.sales)}</td>}
                  {!isMobile && <td style={{ ...td, ...num, color: numColor(r.fees) }}>{fmtR(r.fees)}</td>}
                  <td style={{ ...td, ...num, fontWeight: 600, color: numColor(r.total) }}>{fmtR(r.total)}</td>
                </tr>
              ))
              : cats.map((c) => <CategoryRows key={c.category} cat={c} isMobile={isMobile} />)}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--hairline)' }}>
              <td style={{ ...td, fontWeight: 700 }}>Sub total</td>
              {!isMobile && flat && <td style={td} />}
              <td style={{ ...td, ...num, fontWeight: 700 }}>{fmtQty(st.qty)}</td>
              {!isMobile && <td style={{ ...td, ...num, fontWeight: 700, color: numColor(st.sales) }}>{fmtR(st.sales)}</td>}
              {!isMobile && <td style={{ ...td, ...num, fontWeight: 700, color: numColor(st.fees) }}>{fmtR(st.fees)}</td>}
              <td style={{ ...td, ...num, fontWeight: 700, color: numColor(st.total) }}>{fmtR(st.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// A category roll-up that expands to its sub-categories (phases), each of which
// expands to its individual line items.
function CategoryRows({ cat, isMobile }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr onClick={() => setOpen((v) => !v)} style={{ cursor: 'pointer', background: 'var(--elevated)' }}>
        <td style={{ ...td, fontWeight: 700 }}>
          <Caret open={open} />
          {cat.category} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11 }}>({cat.rows.length})</span>
        </td>
        <td style={{ ...td, ...num, fontWeight: 700, color: numColor(cat.qty) }}>{fmtQty(cat.qty)}</td>
        {!isMobile && <td style={{ ...td, ...num, fontWeight: 700, color: numColor(cat.sales) }}>{fmtR(cat.sales)}</td>}
        {!isMobile && <td style={{ ...td, ...num, fontWeight: 700, color: numColor(cat.fees) }}>{fmtR(cat.fees)}</td>}
        <td style={{ ...td, ...num, fontWeight: 700, color: numColor(cat.total) }}>{fmtR(cat.total)}</td>
      </tr>
      {open && (cat.nested
        ? cat.subs.map((sub, i) => <SubRows key={i} sub={sub} isMobile={isMobile} />)
        : cat.rows.map((r, i) => <LeafRow key={i} r={r} indent={26} isMobile={isMobile} />))}
    </>
  );
}

// A sub-category (phase) roll-up. A single-item phase renders as a plain leaf —
// no point in a roll-up over one row.
function SubRows({ sub, isMobile }) {
  const [open, setOpen] = useState(false);
  if (sub.rows.length === 1) return <LeafRow r={sub.rows[0]} indent={26} isMobile={isMobile} label={sub.sub !== '—' ? sub.sub : undefined} />;
  return (
    <>
      <tr onClick={() => setOpen((v) => !v)} style={{ cursor: 'pointer' }}>
        <td style={{ ...td, paddingLeft: 26, fontWeight: 600, color: 'var(--text)' }}>
          <Caret open={open} />
          {sub.sub} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11 }}>({sub.rows.length})</span>
        </td>
        <td style={{ ...td, ...num, fontWeight: 600, color: numColor(sub.qty) }}>{fmtQty(sub.qty)}</td>
        {!isMobile && <td style={{ ...td, ...num, fontWeight: 600, color: numColor(sub.sales) }}>{fmtR(sub.sales)}</td>}
        {!isMobile && <td style={{ ...td, ...num, fontWeight: 600, color: numColor(sub.fees) }}>{fmtR(sub.fees)}</td>}
        <td style={{ ...td, ...num, fontWeight: 600, color: numColor(sub.total) }}>{fmtR(sub.total)}</td>
      </tr>
      {open && sub.rows.map((r, i) => <LeafRow key={i} r={r} indent={46} isMobile={isMobile} variant />)}
    </>
  );
}

// An individual line item. Within a phase we show the variant (cashless add-on
// / base) plus the unit price so same-named, different-priced rows are clear.
function LeafRow({ r, indent, isMobile, label, variant }) {
  const text = variant ? variantLabel(r.desc) : (label || phaseName(r.desc));
  return (
    <tr style={{ background: 'transparent' }}>
      <td style={{ ...td, paddingLeft: indent, color: 'var(--muted-2)' }}>
        {text}
        {r.price != null && <span style={{ color: 'var(--muted)', fontSize: 11 }}> · @ {fmtR(r.price)}</span>}
      </td>
      <td style={{ ...td, ...num, color: numColor(r.qty) }}>{fmtQty(r.qty)}</td>
      {!isMobile && <td style={{ ...td, ...num, color: numColor(r.sales) }}>{fmtR(r.sales)}</td>}
      {!isMobile && <td style={{ ...td, ...num, color: numColor(r.fees) }}>{fmtR(r.fees)}</td>}
      <td style={{ ...td, ...num, color: numColor(r.total) }}>{fmtR(r.total)}</td>
    </tr>
  );
}

function Caret({ open }) {
  return <span className="nav-caret" style={{ display: 'inline-block', width: 12, fontSize: 9, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>;
}

function CommissionTable({ group, isMobile }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={tbl}>
        <thead>
          <tr>
            {!isMobile && <th style={th}>Code</th>}
            <th style={th}>Service</th>
            <th style={{ ...th, textAlign: 'right' }}>Rate</th>
            {!isMobile && <th style={{ ...th, textAlign: 'right' }}>Value/Qty</th>}
            <th style={{ ...th, textAlign: 'right' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {(group.rows || []).map((r, i) => (
            <tr key={i} style={{ background: i % 2 ? 'var(--row-stripe)' : 'transparent' }}>
              {!isMobile && <td style={{ ...td, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{r.code}</td>}
              <td style={td}>{r.desc}</td>
              <td style={{ ...td, ...num, color: 'var(--muted-2)' }}>{r.rate}</td>
              {!isMobile && <td style={{ ...td, ...num }}>{typeof r.value === 'number' ? fmtR(r.value) : r.value}</td>}
              <td style={{ ...td, ...num, fontWeight: 600, color: numColor(r.total) }}>{fmtR(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SimpleTable({ cols, rows, numericFrom = 99, negIdx = -1 }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={tbl}>
        <thead><tr>{cols.map((c, i) => <th key={i} style={{ ...th, textAlign: i >= numericFrom ? 'right' : 'left' }}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: i % 2 ? 'var(--row-stripe)' : 'transparent' }}>
              {r.map((cell, j) => (
                <td key={j} style={{ ...td, ...(j >= numericFrom ? num : null), ...(j === negIdx && String(cell).startsWith('-') ? { color: 'var(--error)' } : null), fontWeight: j >= numericFrom ? 600 : 400 }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Toggle({ on, onClick, children }) {
  return <button onClick={onClick} style={{ border: 'none', borderRadius: 980, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--muted-2)' }}>{children}</button>;
}

// ─── Owl data builders (report lines → pseudo-tile rows) ──────────────────────
function makeOwl(dims, measures, rows) { return { fields: { dimensions: dims, measures }, data: rows }; }
function buildOwlData(d) {
  const rows = [];
  const add = (item, amount) => { if (amount != null) rows.push({ item: { value: item }, amount: { value: amount, rendered: fmtR(amount) } }); };
  for (const g of d.sales || []) add(`${g.name} (subtotal)`, g.subtotal?.total);
  add('Total event turnover', d.turnover);
  for (const g of d.commissions || []) add(`${g.name} (subtotal)`, g.subtotal?.total);
  add('Total Howler commissions', d.commissionsTotal);
  add('Advances paid (subtotal)', d.advances?.subtotal);
  add('VALUE DUE TO CLIENT', d.valueDue);
  return makeOwl([{ name: 'item', label: 'Item' }], [{ name: 'amount', label: 'Amount (ZAR)' }], rows);
}
function salesOwl(group) {
  return makeOwl(
    [{ name: 'category', label: 'Category' }, { name: 'phase', label: 'Sub-category / phase' }, { name: 'item', label: 'Item' }],
    [{ name: 'qty', label: 'Qty' }, { name: 'sales', label: 'Sales (ZAR)' }, { name: 'total', label: 'Total incl VAT (ZAR)' }],
    (group.rows || []).map((r) => ({ category: { value: deriveCategory(r.desc) }, phase: { value: deriveSubCategory(r.desc) || '—' }, item: { value: r.desc }, qty: { value: r.qty, rendered: fmtQty(r.qty) }, sales: { value: r.sales, rendered: fmtR(r.sales) }, total: { value: r.total, rendered: fmtR(r.total) } })),
  );
}
function commissionsOwl(d) {
  const rows = [];
  for (const g of d.commissions || []) for (const r of g.rows || []) rows.push({ group: { value: g.name }, item: { value: `${r.desc}${r.rate ? ` @ ${r.rate}` : ''}` }, amount: { value: r.total, rendered: fmtR(r.total) } });
  return makeOwl([{ name: 'group', label: 'Group' }, { name: 'item', label: 'Service' }], [{ name: 'amount', label: 'Amount (ZAR)' }], rows);
}
function paymentsOwl(d) {
  const rows = [];
  for (const r of d.settlementSummary || []) rows.push({ item: { value: `Net settlement ${r.date}` }, amount: { value: r.amount, rendered: fmtR(r.amount) } });
  for (const r of d.advances?.rows || []) rows.push({ item: { value: `Advance ${r.date}` }, amount: { value: r.settled ?? -(r.value || 0), rendered: fmtR(r.settled ?? -(r.value || 0)) } });
  for (const r of d.withheldSummary || []) rows.push({ item: { value: `${r.desc} ${r.date}` }, amount: { value: r.amount, rendered: fmtR(r.amount) } });
  return makeOwl([{ name: 'item', label: 'Item' }], [{ name: 'amount', label: 'Amount (ZAR)' }], rows);
}

// ─── Bits ─────────────────────────────────────────────────────────────────────
const numColor = (v) => (v != null && v < 0 ? 'var(--error)' : 'var(--text)');
const shortName = (n) => (n || '').replace(/ Commissions?$/i, '').replace('Payment Processing', 'Processing') || 'Fees';
// In a category group, show just the tier/phase ("Phase 1") rather than repeat
// the whole "3-day Full Fest Main Arena - Phase 1".
function phaseName(desc) {
  const parts = String(desc).split(/\s[-–]\s/);
  if (parts.length > 1) return parts.slice(1).join(' – ');
  return desc;
}
function fmtWhen(at) {
  try { return new Date(at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; }
}
const pillBtn = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const iconAction = { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '4px 5px', borderRadius: 7, flexShrink: 0 };
const noteCount = { fontSize: 10, fontWeight: 700, background: 'var(--brand)', color: '#fff', borderRadius: 980, minWidth: 15, height: 15, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' };
const miniSolid = { border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
const tbl = { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 };
const th = { textAlign: 'left', padding: '7px 9px', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', borderBottom: '1px solid var(--hairline)', whiteSpace: 'nowrap' };
const td = { padding: '7px 9px', color: 'var(--text)', verticalAlign: 'top' };
const num = { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
const groupHead = { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, fontWeight: 700, padding: '4px 0 6px', color: 'var(--text)' };

function Centered({ children, error }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <p style={{ fontSize: 15, color: error ? 'var(--error)' : 'var(--muted)' }}>{children}</p>
    </div>
  );
}
