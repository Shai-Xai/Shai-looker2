import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactECharts from 'echarts-for-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useTheme } from '../lib/theme.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useCountUp } from '../lib/useCountUp.js';
import { fmtR, fmtQty } from '../lib/money.js';
import { StatusBadge } from './SettlementsPage.jsx';
import InsightModal from '../components/InsightModal.jsx';
import AiMark from '../components/AiMark.jsx';
import { ScopeProvider } from '../lib/ScopeContext.jsx';

// Interactive settlement report: the money story (turnover → fees → advances →
// value due) as a waterfall, with every PDF section as a collapsible,
// searchable table underneath. Rendered entirely from the extracted JSON.
export default function SettlementViewPage() {
  const { id } = useParams();
  const isMobile = useIsMobile();
  const { insightsEnabled } = useAuth();
  const { theme } = useTheme();
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [owlOpen, setOwlOpen] = useState(false);

  useEffect(() => {
    setS(null); setError(null);
    api.getSettlement(id).then(setS).catch((e) => setError(e.message));
  }, [id]);

  // Synthesized rows for the Owl. MUST be declared before the early returns
  // below — hooks can't sit after a conditional return.
  const owlData = useMemo(() => (s ? buildOwlData(s.data || {}) : null), [s]);

  if (error) return <Centered error>Error: {error}</Centered>;
  if (!s) return <Centered>Loading report…</Centered>;

  const d = s.data || {};
  const meta = d.meta || {};
  const dark = theme === 'dark';
  const advTotal = d.advances?.subtotal ?? 0;

  // Synthesized "tile" for the Owl: the report's key lines as rows so the
  // existing per-tile insight chat works unchanged on settlements.
  const owlTile = {
    id: `settlement-${s.id}`,
    title: `${meta.eventName || s.title} — Settlement`,
    vis: { type: 'looker_grid' },
    aiContext: 'This is an event settlement report: gross ticketing turnover, Howler commissions/fees deducted (negative amounts), advance payments already made to the client, and the final value due. Withholding tax lines are tax credits. Help the client understand where the money went.',
  };

  return (
    <ScopeProvider suiteId={null} dashboardContext="">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Header */}
        <div style={{ background: 'var(--frost)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid var(--hairline)', padding: isMobile ? '12px 14px' : '14px 22px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link to="/settlements" style={{ color: 'var(--muted)', fontSize: 13, textDecoration: 'none', flexShrink: 0 }}>← Settlements</Link>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, letterSpacing: '-0.02em' }}>{meta.eventName || s.title}</h2>
              <StatusBadge status={s.status} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {[meta.venue, meta.eventDates, meta.settlementDate && `Settled ${meta.settlementDate}`].filter(Boolean).join(' · ')}
            </div>
          </div>
          {insightsEnabled && (
            <button className="btn-key" style={pillBtn} onClick={() => setOwlOpen(true)} title="Ask the Owl about this settlement">
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

            {/* The money story */}
            <Card title="Where the money went" subtitle="From gross turnover to your final settlement">
              <Waterfall d={d} dark={dark} isMobile={isMobile} />
            </Card>

            {/* Ticket sales */}
            {(d.sales || []).map((g, i) => (
              <Section key={i} title={g.name} defaultOpen={i === 0} summary={fmtR(g.subtotal?.total)}>
                <SalesTable group={g} isMobile={isMobile} searchable={(g.rows || []).length > 10} />
              </Section>
            ))}

            {/* Commissions */}
            {(d.commissions || []).length > 0 && (
              <Section title="Howler commissions & fees" summary={fmtR(d.commissionsTotal)} defaultOpen={false}>
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
              <Section title="Payments to you" summary={d.settlementSummary?.length ? fmtR(d.settlementSummary.reduce((a, r) => a + (r.amount || 0), 0)) : ''} defaultOpen>
                {(d.settlementSummary || []).length > 0 && <PaymentsChart d={d} dark={dark} isMobile={isMobile} />}
                {(d.advances?.rows || []).length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={groupHead}><span>Advance payments</span><span style={{ color: numColor(d.advances.subtotal) }}>{fmtR(d.advances.subtotal)}</span></div>
                    <SimpleTable
                      cols={['Date', 'Description', 'Amount']}
                      rows={(d.advances.rows || []).map((r) => [r.date, r.desc, fmtR(r.value)])}
                      numericFrom={2}
                    />
                  </div>
                )}
                {(d.withheldSummary || []).length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={groupHead}><span>Withheld portion</span></div>
                    <SimpleTable
                      cols={['Date', 'Description', 'Amount']}
                      rows={(d.withheldSummary || []).map((r) => [r.date, r.desc, fmtR(r.amount)])}
                      negIdx={2}
                      numericFrom={2}
                    />
                  </div>
                )}
              </Section>
            )}

            <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', padding: '4px 0 14px' }}>
              Generated from the official settlement report{meta.settlementPeriod ? ` · period ${meta.settlementPeriod}` : ''}. The PDF download is the authoritative document.
            </p>
          </div>
        </div>

        {owlOpen && <InsightModal tile={owlTile} data={owlData} filters={{}} onClose={() => setOwlOpen(false)} />}
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

// ─── Waterfall: turnover → commission groups → advances → value due ───────────
function Waterfall({ d, dark, isMobile }) {
  const option = useMemo(() => {
    const steps = [
      { label: 'Turnover', delta: d.turnover || 0, color: '#7c3aed' },
      ...(d.commissions || []).map((g) => ({ label: shortName(g.name), delta: g.subtotal?.total || 0, color: '#ff6b35' })),
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
        formatter: (ps) => {
          const i = ps[0].dataIndex; const st = labels[i];
          const v = st.total !== undefined ? st.total : st.delta;
          return `<b>${st.label}</b><br/>${fmtR(v)}`;
        },
      },
      xAxis: {
        type: 'category', data: labels.map((s) => s.label),
        axisLabel: { color: axisC, fontSize: isMobile ? 9 : 11, interval: 0, rotate: isMobile ? 28 : 0 },
        axisLine: { lineStyle: { color: splitC } }, axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: axisC, fontSize: 10, formatter: (v) => fmtR(v, { compact: true }) },
        splitLine: { lineStyle: { color: splitC } },
      },
      series: [
        { type: 'bar', stack: 'w', itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } }, tooltip: { show: false }, data: base, barWidth: isMobile ? '52%' : '44%' },
        {
          type: 'bar', stack: 'w', data: bars,
          label: {
            show: !isMobile, position: 'top', fontSize: 10, fontWeight: 700,
            color: dark ? '#d6d6de' : '#48484e',
            formatter: (p) => { const st = labels[p.dataIndex]; const v = st.total !== undefined ? st.total : st.delta; return fmtR(v, { compact: true }); },
          },
        },
      ],
    };
  }, [d, dark, isMobile]);
  return <ReactECharts option={option} style={{ height: isMobile ? 240 : 320 }} notMerge />;
}

// ─── Commission mix donut ─────────────────────────────────────────────────────
function CommissionDonut({ groups, dark }) {
  const option = useMemo(() => ({
    animationDuration: 700,
    tooltip: {
      backgroundColor: dark ? '#26262c' : '#fff', borderColor: dark ? '#3a3a42' : '#e5e5ea',
      textStyle: { color: dark ? '#f3f3f6' : '#1d1d1f', fontSize: 12 },
      formatter: (p) => `<b>${p.name}</b><br/>${fmtR(-p.value)} (${p.percent}%)`,
    },
    series: [{
      type: 'pie', radius: ['52%', '78%'], center: ['50%', '50%'],
      itemStyle: { borderColor: dark ? '#1a1a1f' : '#fff', borderWidth: 2 },
      label: { show: true, fontSize: 10, color: dark ? '#9a9aa2' : '#6e6e73', formatter: '{b}\n{d}%' },
      data: groups.map((g, i) => ({ name: shortName(g.name), value: Math.abs(g.subtotal?.total || 0), itemStyle: { color: ['#ff385c', '#ff6b35', '#7c3aed', '#06b6d4'][i % 4] } })),
    }],
  }), [groups, dark]);
  return <ReactECharts option={option} style={{ height: 230 }} notMerge />;
}

// ─── Payments over time (net settlements vs withheld) ─────────────────────────
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
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' },
        backgroundColor: dark ? '#26262c' : '#fff', borderColor: dark ? '#3a3a42' : '#e5e5ea',
        textStyle: { color: dark ? '#f3f3f6' : '#1d1d1f', fontSize: 12 },
        valueFormatter: (v) => fmtR(v),
      },
      xAxis: { type: 'category', data: dates, axisLabel: { color: axisC, fontSize: 10 }, axisLine: { lineStyle: { color: splitC } }, axisTick: { show: false } },
      yAxis: { type: 'value', axisLabel: { color: axisC, fontSize: 10, formatter: (v) => fmtR(v, { compact: true }) }, splitLine: { lineStyle: { color: splitC } } },
      series: [
        { name: 'Paid to you', type: 'bar', data: paid, itemStyle: { color: '#34c759', borderRadius: [5, 5, 0, 0] }, barWidth: '32%' },
        { name: 'Withheld / released', type: 'bar', data: withheld, itemStyle: { color: '#f59e0b', borderRadius: [5, 5, 0, 0] }, barWidth: '32%' },
      ],
    };
  }, [d, dark]);
  return <ReactECharts option={option} style={{ height: isMobile ? 200 : 240 }} notMerge />;
}

// ─── Collapsible section ──────────────────────────────────────────────────────
function Section({ title, summary, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="howler-tile" style={{ background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <button onClick={() => setOpen((v) => !v)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text)', textAlign: 'left' }}>
        <span className="nav-caret" style={{ fontSize: 10, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}>▶</span>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</span>
        {summary && <span style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--muted-2)' }}>{summary}</span>}
      </button>
      <div className={`collapsey${open ? ' open' : ''}`}>
        <div className="collapsey-inner">
          <div style={{ padding: '2px 16px 16px' }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

function Card({ title, subtitle, children }) {
  return (
    <div className="howler-tile tile-enter" style={{ animationDelay: '120ms', background: 'var(--tile-bg, var(--card))', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-sm)', padding: '14px 16px' }}>
      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{subtitle}</div>}
      {children}
    </div>
  );
}

// ─── Tables ───────────────────────────────────────────────────────────────────
function SalesTable({ group, isMobile, searchable }) {
  const [q, setQ] = useState('');
  const rows = (group.rows || []).filter((r) => !q.trim() || (r.desc || '').toLowerCase().includes(q.trim().toLowerCase()));
  const st = group.subtotal || {};
  return (
    <div>
      {searchable && (
        <input
          value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search line items…"
          style={{ width: '100%', maxWidth: 320, marginBottom: 10, border: '1px solid var(--hairline)', borderRadius: 980, padding: '7px 14px', fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
        />
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={tbl}>
          <thead>
            <tr>
              <th style={th}>Item</th>
              {!isMobile && <th style={th}>Type</th>}
              <th style={{ ...th, textAlign: 'right' }}>Qty</th>
              {!isMobile && <th style={{ ...th, textAlign: 'right' }}>Price</th>}
              <th style={{ ...th, textAlign: 'right' }}>Sales</th>
              {!isMobile && <th style={{ ...th, textAlign: 'right' }}>Fees</th>}
              <th style={{ ...th, textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ background: i % 2 ? 'var(--row-stripe)' : 'transparent' }}>
                <td style={td}>{r.desc}</td>
                {!isMobile && <td style={{ ...td, color: 'var(--muted)' }}>{r.type}</td>}
                <td style={{ ...td, ...num, color: numColor(r.qty) }}>{fmtQty(r.qty)}</td>
                {!isMobile && <td style={{ ...td, ...num }}>{fmtR(r.price)}</td>}
                <td style={{ ...td, ...num, color: numColor(r.sales) }}>{fmtR(r.sales)}</td>
                {!isMobile && <td style={{ ...td, ...num, color: numColor(r.fees) }}>{fmtR(r.fees)}</td>}
                <td style={{ ...td, ...num, fontWeight: 600, color: numColor(r.total) }}>{fmtR(r.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--hairline)' }}>
              <td style={{ ...td, fontWeight: 700 }}>Sub total{q.trim() ? ' (all rows)' : ''}</td>
              {!isMobile && <td style={td} />}
              <td style={{ ...td, ...num, fontWeight: 700 }}>{fmtQty(st.qty)}</td>
              {!isMobile && <td style={td} />}
              <td style={{ ...td, ...num, fontWeight: 700, color: numColor(st.sales) }}>{fmtR(st.sales)}</td>
              {!isMobile && <td style={{ ...td, ...num, fontWeight: 700, color: numColor(st.fees) }}>{fmtR(st.fees)}</td>}
              <td style={{ ...td, ...num, fontWeight: 700, color: numColor(st.total) }}>{fmtR(st.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
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

// ─── Owl data: report key lines as a pseudo-tile so InsightModal just works ───
function buildOwlData(d) {
  const rows = [];
  const add = (item, amount) => rows.push({ item: { value: item }, amount: { value: amount, rendered: fmtR(amount) } });
  for (const g of d.sales || []) add(`${g.name} (subtotal)`, g.subtotal?.total);
  add('Total event turnover', d.turnover);
  for (const g of d.commissions || []) {
    for (const r of g.rows || []) add(`${g.name}: ${r.desc}${r.rate ? ` @ ${r.rate}` : ''}`, r.total);
    add(`${g.name} (subtotal)`, g.subtotal?.total);
  }
  add('Total Howler commissions', d.commissionsTotal);
  for (const r of d.advances?.rows || []) add(`Advance payment ${r.date}`, r.settled ?? -(r.value || 0));
  add('Advances (subtotal)', d.advances?.subtotal);
  add('VALUE DUE TO CLIENT', d.valueDue);
  for (const r of d.settlementSummary || []) add(`Net settlement paid ${r.date}`, r.amount);
  for (const r of d.withheldSummary || []) add(`${r.desc} ${r.date}`, r.amount);
  return {
    fields: { dimensions: [{ name: 'item', label: 'Item' }], measures: [{ name: 'amount', label: 'Amount (ZAR)' }] },
    data: rows.filter((r) => r.amount.value != null),
  };
}

// ─── Bits ─────────────────────────────────────────────────────────────────────
const numColor = (v) => (v != null && v < 0 ? 'var(--error)' : 'var(--text)');
const shortName = (n) => (n || '').replace(/ Commissions?$/i, '').replace('Payment Processing', 'Processing') || 'Fees';
const pillBtn = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 14px', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 };
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
