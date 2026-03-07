import TileFrame from './TileFrame.jsx';

// Looker uses a 24-column grid. Each row unit ≈ 36px (Looker standard).
const COL_COUNT = 24;
const ROW_HEIGHT = 36; // px per grid row unit — matches Looker's grid
const GAP = 8;

export default function DashboardGrid({ tiles, filterValues }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${COL_COUNT}, 1fr)`,
        gridAutoRows: `${ROW_HEIGHT}px`,
        gap: GAP,
      }}
    >
      {tiles.map(tile => (
        <div
          key={tile.id}
          style={{
            gridColumn: `${tile.col + 1} / span ${Math.max(1, tile.width)}`,
            gridRow: `${tile.row + 1} / span ${Math.max(1, tile.height)}`,
            minHeight: 60,
            minWidth: 0,
          }}
        >
          <TileFrame tile={tile} filterValues={filterValues} />
        </div>
      ))}
    </div>
  );
}
