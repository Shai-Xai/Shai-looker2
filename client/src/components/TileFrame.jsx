import { useState, useEffect, useRef } from 'react';
import SingleValueTile from './tiles/SingleValueTile.jsx';
import ChartTile from './tiles/ChartTile.jsx';
import TableTile from './tiles/TableTile.jsx';
import TextTile from './tiles/TextTile.jsx';

export default function TileFrame({ tile, filterValues }) {
  const [queryResult, setQueryResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  // Build filter overrides for this tile from global filter values
  function buildFilterOverrides() {
    const overrides = {};
    for (const [filterName, queryField] of Object.entries(tile.filterMap || {})) {
      const val = filterValues[filterName];
      if (val && val.trim()) {
        overrides[queryField] = val.trim();
      }
    }
    return overrides;
  }

  useEffect(() => {
    if (tile.type === 'text' || !tile.query) return;

    // Abort any in-flight request
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    fetch('/api/run-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: tile.query, filterOverrides: buildFilterOverrides() }),
      signal: controller.signal,
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setQueryResult(data);
      })
      .catch(err => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [tile.id, JSON.stringify(filterValues)]);

  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e0e0e0',
      borderRadius: 8,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    }}>
      {/* Tile header */}
      {tile.title && (
        <div style={{
          padding: '8px 12px',
          fontSize: 12,
          fontWeight: 600,
          color: '#555',
          borderBottom: '1px solid #f0f0f0',
          flexShrink: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {tile.title}
        </div>
      )}

      {/* Tile content */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', padding: tile.type === 'text' ? 12 : 0 }}>
        {tile.type === 'text' ? (
          <TextTile tile={tile} />
        ) : loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} />
        ) : queryResult ? (
          <TileContent tile={tile} data={queryResult} />
        ) : null}
      </div>
    </div>
  );
}

function TileContent({ tile, data }) {
  const visType = tile.vis_config?.type;

  if (visType === 'single_value' || visType === 'single_value_period_over_period') {
    return <SingleValueTile data={data} visConfig={tile.vis_config} />;
  }

  if (visType === 'looker_grid' || visType === 'table' || visType === 'looker_legacy_table') {
    return <TableTile data={data} visConfig={tile.vis_config} />;
  }

  if (visType === 'looker_column' || visType === 'looker_bar' || visType === 'looker_line' ||
      visType === 'looker_area' || visType === 'looker_scatter' || visType === 'looker_pie' ||
      visType === 'looker_donut_multiples') {
    return <ChartTile data={data} visConfig={tile.vis_config} />;
  }

  // Fallback: render as table so data is always visible
  return <TableTile data={data} visConfig={tile.vis_config} />;
}

function LoadingState() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aaa', fontSize: 12 }}>
      <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block', marginRight: 6, fontSize: 16 }}>⏳</span>
      Loading…
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ErrorState({ message }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 12 }}>
      <p style={{ color: 'var(--error)', fontSize: 11, textAlign: 'center', lineHeight: 1.4 }}>{message}</p>
    </div>
  );
}
