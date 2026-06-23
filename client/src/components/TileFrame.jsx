import SingleValueTile from './tiles/SingleValueTile.jsx';
import ChartTile from './tiles/ChartTile.jsx';
import TableTile from './tiles/TableTile.jsx';
import BarGaugeTile from './tiles/BarGaugeTile.jsx';
import { useState, useEffect } from 'react';
import TextTile from './tiles/TextTile.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import InsightModal from './InsightModal.jsx';
import AiMark from './AiMark.jsx';
import { usePins } from '../lib/PinContext.jsx';
import { useTileData, isRunnableQuery } from '../lib/useTileData.js';
import { ANY_VALUE } from '../lib/filterConstants.js';
import { useAuth } from '../lib/auth.jsx';
import { useScope } from '../lib/ScopeContext.jsx';
import { api } from '../lib/api.js';
import { useAccess, PERMS } from '../lib/access.js';
import CreateSegmentModal from './CreateSegmentModal.jsx';
import TileLockModal from './TileLockModal.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

// Renders a single tile (vis or text). In edit mode it shows hover controls
// (edit / duplicate / delete) and a drag handle on the title bar.
export default function TileFrame({ tile, filterValues, editable, onEdit, onDuplicate, onRemove, onMoveOut, onToggleHide, inCarousel }) {
  const { data, loading, error } = useTileData(tile, filterValues);
  const { insightsEnabled } = useAuth();
  const { entityId, dashboardId, suiteId, canLockTiles, tileLocks = {}, lockFilters = [], onSaveTileLock } = useScope();
  const [showTileLock, setShowTileLock] = useState(false);
  // Admin per-tile lock affordance: only when in a suite, the tile is queryable
  // and it actually listens to a dashboard filter (otherwise there's nothing to lock).
  const tileLockCount = Object.keys(tileLocks?.[tile.id] || {}).length;
  const canLockThisTile = !!(canLockTiles && editable && tile.type !== 'text' && Object.keys(tile.listenTo || {}).length > 0 && onSaveTileLock);
  const { can } = useAccess();
  const isMobile = useIsMobile();
  const [showInsight, setShowInsight] = useState(false);
  const [showSegment, setShowSegment] = useState(false);
  // On phones the per-tile owl/pin/segment buttons clutter every card, so they
  // stay hidden until you tap the tile (desktop shows them on hover as before).
  const [tapped, setTapped] = useState(false);
  // Open the Owl on this tile, recording it as a feature-usage signal (Admin → Onboarding).
  const openInsight = () => { if (entityId) api.trackUsage(entityId, { kind: 'feature', name: 'insight', event: 'use' }); setShowInsight(true); };

  // The filters in effect for this tile (its own query filters + the dashboard
  // filters it listens to) — passed to the AI for context.
  function appliedFilters() {
    const f = { ...(tile.query?.filters || {}) };
    for (const [filterName, queryField] of Object.entries(tile.listenTo || {})) {
      const val = filterValues?.[filterName];
      if (val === ANY_VALUE) delete f[queryField]; // "any value" → no restriction on this field
      else if (val && String(val).trim()) f[queryField] = String(val).trim();
    }
    return f;
  }

  const canInsight = insightsEnabled && tile.type !== 'text' && data && !loading && !error;

  // "Segment from a tile": offer it (view mode only) when the tile lists people —
  // i.e. its data has an email-like column — and the viewer can manage campaigns.
  const tileFields = data ? [...(data.fields?.dimensions || []), ...(data.fields?.measures || []), ...(data.fields?.table_calculations || [])].map((f) => ({ name: f.name, label: f.label_short || f.label || f.name })) : [];
  const hasEmailField = tileFields.some((f) => /email/i.test(f.name) || /email/i.test(f.label));
  const canSegment = !editable && data && !loading && !error && !!entityId && !!dashboardId && hasEmailField && can(PERMS.CAMPAIGNS_APPROVE);
  // Dashboard filters currently in effect for this tile, keyed by query field —
  // captured into the segment so it resolves the same cohort (ANY_VALUE rides
  // through; the server drops it). Mirrors useTileData's override logic.
  function capturedFilters() {
    const o = {};
    for (const [filterName, queryField] of Object.entries(tile.listenTo || {})) {
      const val = filterValues?.[filterName];
      if (val === ANY_VALUE) o[queryField] = ANY_VALUE;
      else if (val && String(val).trim()) o[queryField] = String(val).trim();
    }
    return o;
  }

  // Metric-style tiles (single value, gauge) show their label *below* the
  // number (Looker convention), so they don't get a top title bar in view mode.
  const visType = tile.vis?.type;
  const isMetric = visType === 'single_value' || visType === 'single_value_period_over_period' || (visType || '').includes('bar_gauge');
  // Metric (single-value) tiles never take a header row — even in edit mode — so the
  // big number stays fully visible; their edit controls float in the corners instead.
  const showHeader = !isMetric && (editable || !!tile.title);

  return (
    <div
      // Hover-lift in view mode (matches the home cards). Not while editing — it
      // would fight the drag-to-rearrange transform.
      className={`howler-tile${editable ? '' : ' lift'}`}
      // Mobile: tap the card to reveal/hide its owl + controls.
      onClick={isMobile && !editable ? () => setTapped((v) => !v) : undefined}
      style={{
        background: 'var(--tile-bg, #fff)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-sm)',
        // Hidden tiles are dimmed in the editor (and not rendered at all for
        // viewers — the parent filters them out).
        opacity: editable && tile.hidden ? 0.4 : 1,
      }}
    >
      {showHeader && (
        <div
          // Inside a scrolling carousel the tile must NOT carry the grid's
          // drag-handle class — that would drag the whole carousel. Reorder there
          // is via the ⠿ grip instead.
          className={editable && !inCarousel ? 'tile-drag-handle' : undefined}
          style={{
            padding: '10px 14px',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text)',
            letterSpacing: '-0.01em',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: editable && !inCarousel ? 'move' : 'default',
          }}
        >
          <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {isMetric ? null : (tile.title || <em style={{ color: '#bbb', fontWeight: 400 }}>Untitled</em>)}
          </span>
          {!editable && (!isMobile || tapped) && canSegment && <SegmentButton onClick={() => setShowSegment(true)} isMobile={isMobile} />}
          {!editable && (!isMobile || tapped) && canInsight && (
            <>
              <PinButton tileId={tile.id} isMobile={isMobile} />
              <InsightButton onClick={openInsight} isMobile={isMobile} />
            </>
          )}
          {editable && (
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }} onMouseDown={(e) => e.stopPropagation()}>
              {inCarousel && <ReorderGrip tileId={tile.id} />}
              <IconBtn title="Edit" onClick={onEdit}>✎</IconBtn>
              <IconBtn title="Duplicate" onClick={onDuplicate}>⧉</IconBtn>
              {onMoveOut && <IconBtn title="Move out to the dashboard grid" onClick={onMoveOut}>⤴</IconBtn>}
              {onToggleHide && <IconBtn title={tile.hidden ? 'Show to viewers' : 'Hide from viewers'} onClick={onToggleHide}>{tile.hidden ? <EyeOff /> : <Eye />}</IconBtn>}
              {canLockThisTile && <LockTileButton onClick={() => setShowTileLock(true)} count={tileLockCount} isMobile={isMobile} />}
              <IconBtn title="Delete" onClick={onRemove} danger>✕</IconBtn>
            </span>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, position: 'relative', padding: tile.type === 'text' ? 12 : 0 }}>
        {/* Grid/section tiles get a top-right ⠿ to drag INTO a carousel. Tiles
            already in a carousel reorder via the grip in their control cluster. */}
        {editable && !inCarousel && (
          <span
            draggable
            onDragStart={(e) => { e.dataTransfer.setData('text/plain', tile.id); e.dataTransfer.effectAllowed = 'move'; }}
            title="Drag into a carousel"
            style={{ position: 'absolute', top: 6, left: 6, zIndex: 6, cursor: 'grab', fontSize: 12, color: '#999', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 5, padding: '1px 5px', lineHeight: 1.3 }}
          >⠿</span>
        )}
        {/* No header (metric tiles): the insight button floats in the corner,
            with the pin just left of it. Hidden while editing to free the corners. */}
        {!editable && (!isMobile || tapped) && canInsight && !showHeader && (
          <>
            <PinButton tileId={tile.id} isMobile={isMobile} corner />
            <InsightButton onClick={openInsight} isMobile={isMobile} corner />
          </>
        )}
        {!editable && (!isMobile || tapped) && canSegment && !showHeader && <SegmentButton onClick={() => setShowSegment(true)} isMobile={isMobile} corner />}
        {/* Editable metric tile (no header): the move handle + edit controls float
            in the top-RIGHT corner, so the value below stays fully visible. The
            move handle reorders within a carousel (⠿) or moves on the grid (✥). */}
        {editable && !showHeader && (
          <span style={{ position: 'absolute', top: 6, right: 6, zIndex: 7, display: 'flex', gap: 4, alignItems: 'center', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 8, padding: 2 }} onMouseDown={(e) => e.stopPropagation()}>
            {inCarousel
              ? <ReorderGrip tileId={tile.id} />
              : <span className="tile-drag-handle" title="Drag to move" style={{ cursor: 'move', color: '#999', fontSize: 13, padding: '2px 5px', lineHeight: 1.2 }}>✥</span>}
            <IconBtn title="Edit" onClick={onEdit}>✎</IconBtn>
            <IconBtn title="Duplicate" onClick={onDuplicate}>⧉</IconBtn>
            {onMoveOut && <IconBtn title="Move out to the dashboard grid" onClick={onMoveOut}>⤴</IconBtn>}
            {onToggleHide && <IconBtn title={tile.hidden ? 'Show to viewers' : 'Hide from viewers'} onClick={onToggleHide}>{tile.hidden ? <EyeOff /> : <Eye />}</IconBtn>}
            {canLockThisTile && <LockTileButton onClick={() => setShowTileLock(true)} count={tileLockCount} isMobile={isMobile} />}
            <IconBtn title="Delete" onClick={onRemove} danger>✕</IconBtn>
          </span>
        )}
        {tile.type === 'text' ? (
          <TextTile tile={tile} />
        ) : !isRunnableQuery(tile.query) ? (
          <Centered faint>{editable ? 'Pick an explore and at least one field →' : 'Not configured'}</Centered>
        ) : loading && !data ? (
          <Skeleton metric={isMetric} chart={!!(visType || '').match(/column|bar|line|area|scatter|pie|donut/)} />
        ) : error ? (
          <Centered error>⚠ {error}</Centered>
        ) : data ? (
          // First data → fade-rise in, staggered by grid position. On refetch
          // (filter change) the stale data stays visible, dimmed, until the new
          // result lands — no flash back to a loading state.
          <div
            className={`tile-enter tile-live${loading ? ' tile-refreshing' : ''}`}
            style={{ height: '100%', animationDelay: `${enterDelay(tile)}ms` }}
          >
            <ErrorBoundary resetKey={data}>
              <TileContent tile={tile} data={data} />
            </ErrorBoundary>
          </div>
        ) : null}
      </div>

      {showInsight && (
        <InsightModal tile={tile} data={data} filters={appliedFilters()} onClose={() => setShowInsight(false)} />
      )}
      {showSegment && (
        <CreateSegmentModal
          entityId={entityId}
          dashboardId={dashboardId}
          tileId={tile.id}
          tileTitle={tile.title || ''}
          fields={tileFields}
          lookerFilters={capturedFilters()}
          onClose={() => setShowSegment(false)}
        />
      )}
      {showTileLock && (
        <TileLockModal
          tile={tile}
          filters={lockFilters}
          suiteId={suiteId}
          current={tileLocks?.[tile.id] || {}}
          onSave={onSaveTileLock}
          onClose={() => setShowTileLock(false)}
        />
      )}
    </div>
  );
}

// Drag handle for reordering a tile within a carousel (HTML5 drag; the carousel
// reads the id on drop). Deliberately NOT a .tile-drag-handle so it never drags
// the parent carousel.
function ReorderGrip({ tileId }) {
  return (
    <span
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', tileId); e.dataTransfer.effectAllowed = 'move'; }}
      title="Drag to reorder"
      style={{ cursor: 'grab', color: '#999', fontSize: 13, padding: '2px 5px', lineHeight: 1.2 }}
    >⠿</span>
  );
}

function Eye() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>;
}
function EyeOff() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></svg>;
}

// Admin: lock this tile's filter(s) for the client. Brand-tinted when it has
// active locks. Corner variant floats bottom-left (clear of the owl/segment).
function LockTileButton({ onClick, count, isMobile, corner }) {
  const base = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: `1px solid ${count ? 'var(--brand)' : 'var(--hairline)'}`, background: 'var(--card)', color: count ? 'var(--brand)' : 'var(--muted)', borderRadius: 7, fontSize: isMobile ? 13 : 11, lineHeight: 1, minWidth: isMobile ? 28 : 24, height: isMobile ? 28 : 24, padding: '0 5px', fontWeight: 700 };
  const cornerStyle = corner ? { position: 'absolute', bottom: 6, left: 6, zIndex: 6 } : null;
  return (
    <button className="no-print" title="Lock this tile's filters for this client" onClick={(e) => { e.stopPropagation(); onClick(); }} style={{ ...base, ...cornerStyle }}>🔒{count ? ` ${count}` : ''}</button>
  );
}

// "Create segment" affordance — same visual language as the insight/pin buttons.
function SegmentButton({ onClick, isMobile, corner }) {
  const base = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 7, fontSize: isMobile ? 13 : 12, lineHeight: 1, width: isMobile ? 28 : 24, height: isMobile ? 28 : 24 };
  // Top-right holds the pin/insight cluster on metric tiles, so the rare corner
  // segment button sits top-left (free in view mode).
  const cornerStyle = corner ? { position: 'absolute', top: 6, left: 6, zIndex: 6 } : null;
  return (
    <button className="no-print" title="Create a reusable segment from this tile" onClick={onClick} style={{ ...base, ...cornerStyle }}>🎯</button>
  );
}

// Stagger the entrance by grid position (top-left first, bottom-right last)
// so the dashboard "composes" itself instead of popping in at random.
function enterDelay(tile) {
  const lay = tile.layout || {};
  return Math.min((lay.y ?? 0) * 40 + (lay.x ?? 0) * 7, 480);
}

// Shimmering placeholder shaped roughly like the tile it's standing in for.
function Skeleton({ metric, chart }) {
  if (metric) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16 }}>
        <div className="skel" style={{ width: '55%', height: 26 }} />
        <div className="skel" style={{ width: '38%', height: 11 }} />
      </div>
    );
  }
  if (chart) {
    const heights = [38, 62, 48, 78, 56, 88, 70];
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '6%', padding: '18% 12% 14%' }}>
        {heights.map((h, i) => (
          <div key={i} className="skel" style={{ width: '9%', height: `${h}%`, borderRadius: '5px 5px 2px 2px' }} />
        ))}
      </div>
    );
  }
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 10, padding: 16 }}>
      {[88, 100, 96, 100, 92].map((w, i) => (
        <div key={i} className="skel" style={{ width: `${w}%`, height: 12, opacity: 1 - i * 0.14 }} />
      ))}
    </div>
  );
}

function TileContent({ tile, data }) {
  const visType = tile.vis?.type;

  if (visType === 'single_value' || visType === 'single_value_period_over_period') {
    return <SingleValueTile data={data} visConfig={tile.vis} label={tile.title} />;
  }
  if (visType && visType.includes('bar_gauge')) {
    return <BarGaugeTile data={data} visConfig={tile.vis} label={tile.title} />;
  }
  if (visType === 'looker_grid' || visType === 'table' || visType === 'looker_legacy_table') {
    return <TableTile data={data} visConfig={tile.vis} />;
  }
  if (
    visType === 'looker_column' || visType === 'looker_bar' || visType === 'looker_line' ||
    visType === 'looker_area' || visType === 'looker_scatter' || visType === 'looker_pie' ||
    visType === 'looker_donut_multiples'
  ) {
    return <ChartTile data={data} visConfig={tile.vis} />;
  }
  // Fallback: always show the data.
  return <TableTile data={data} visConfig={tile.vis} />;
}

// AI insight trigger — the Howler owl mark. In the header it sits inline at the
// right; on metric tiles (no header) it floats in the top-right corner. Hidden
// until tile hover (via .insight-btn CSS) and theme-aware (purple accent that
// adapts to dark).
// Tile marks, two buttons:
//   📌 Pin   → the tile renders on the home page.
//   👁 Follow → the Owl always covers this tile in the home briefing.
// Desktop: hover-revealed (hidden until the tile is hovered). Touch: collapsed
// behind a single ghost ⋯ — tap to reveal the two buttons (auto-collapse) so
// dense KPI grids aren't littered with icons. Active marks stay visible.
function PinButton({ tileId, isMobile, corner }) {
  const { enabled, isPinned, isFollowed, toggle } = usePins();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), 5000);
    return () => clearTimeout(t);
  }, [open]);
  if (!enabled) return null;
  const pinned = isPinned(tileId);
  const followed = isFollowed(tileId);
  const base = (on) => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: 'none', background: 'transparent', cursor: 'pointer', lineHeight: 1,
    padding: isMobile ? 5 : 4, fontSize: isMobile ? 14 : 15,
    // No inline opacity on desktop — it would override the .insight-btn class
    // (inline beats CSS), defeating the hidden-until-hover behaviour.
    ...(isMobile ? { opacity: on ? 1 : 0.55 } : null),
    filter: on ? 'none' : 'grayscale(1)',
    flexShrink: 0,
  });
  const followBtn = (
    <button
      title={followed ? 'Unfollow — stop covering this in your briefing' : 'Follow — the Owl always covers this tile in your home briefing'}
      onClick={() => { toggle(tileId, 'follow'); setOpen(false); }}
      className={isMobile || followed ? undefined : 'insight-btn'}
      style={base(followed)}
    >👁</button>
  );
  const pinBtn = (
    <button
      title={pinned ? 'Unpin from your home page' : 'Pin — show this tile on your home page'}
      onClick={() => { toggle(tileId, 'pin'); setOpen(false); }}
      className={isMobile || pinned ? undefined : 'insight-btn'}
      style={base(pinned)}
    >📌</button>
  );
  const wrap = corner
    ? { position: 'absolute', top: isMobile ? 4 : 6, right: isMobile ? 30 : 38, zIndex: 5, display: 'inline-flex', alignItems: 'center' }
    : { display: 'inline-flex', alignItems: 'center', flexShrink: 0 };

  if (isMobile) {
    return (
      <span onMouseDown={(e) => e.stopPropagation()} style={wrap}>
        {(open || followed) && followBtn}
        {(open || pinned) && pinBtn}
        <button
          title="Pin or follow this tile"
          aria-label="Tile options"
          onClick={() => setOpen((v) => !v)}
          style={{ ...base(false), opacity: open ? 0.9 : 0.35, fontSize: 15, fontWeight: 700, color: 'var(--muted)' }}
        >⋯</button>
      </span>
    );
  }
  return (
    <span onMouseDown={(e) => e.stopPropagation()} style={wrap}>
      {followBtn}
      {pinBtn}
    </span>
  );
}

function InsightButton({ onClick, isMobile, corner }) {
  // On touch screens the button is ALWAYS visible (no hover to hide behind),
  // so the full purple treatment repeated on every tile is noisy — render a
  // small ghosted owl instead. Desktop keeps the full hover-revealed styling,
  // as do the Summary buttons and AI panels.
  if (isMobile) {
    return (
      <button
        title="AI insight"
        onClick={onClick}
        className="insight-btn"
        style={{
          ...(corner ? { position: 'absolute', top: 4, right: 4, zIndex: 5 } : { flexShrink: 0 }),
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', background: 'transparent', cursor: 'pointer', lineHeight: 1,
          padding: 6, opacity: 0.4,
        }}
      ><AiMark size={16} quiet /></button>
    );
  }
  return (
    <button
      title="AI insight"
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      className="insight-btn btn-key"
      style={{
        ...(corner ? { position: 'absolute', top: 6, right: 6, zIndex: 5 } : { flexShrink: 0 }),
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid var(--ai-border)', background: 'var(--ai-bg)', color: 'var(--ai)',
        borderRadius: 7, cursor: 'pointer', lineHeight: 1, fontWeight: 600, padding: 3,
        backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
      }}
    ><AiMark size={21} /></button>
  );
}

function IconBtn({ children, onClick, title, danger }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: 1,
        padding: 2,
        color: danger ? 'var(--error)' : '#888',
        borderRadius: 4,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f0f0')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  );
}

function Centered({ children, faint, error }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 12,
        textAlign: 'center',
        fontSize: 12,
        color: error ? 'var(--error)' : faint ? '#bbb' : '#555',
      }}
    >
      {children}
    </div>
  );
}
