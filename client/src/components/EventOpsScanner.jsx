import { useEffect, useRef, useState } from 'react';

// Full-screen camera scanner for Event Ops. The html5-qrcode lib is dynamically
// imported so it code-splits out of the main bundle (loads only when a scan starts).
// Camera/HTTPS aren't guaranteed on every device, so a manual-entry box is always
// offered as a reliable fallback. The component is "dumb": it only resolves a code
// string back to the caller via onCode — the parent decides what to do with it.
const REGION_ID = 'eventops-scan-region';

export default function EventOpsScanner({ onCode, onClose, title = 'Scan a device', hint = 'Point at the QR code or barcode' }) {
  const [manual, setManual] = useState('');
  const [camState, setCamState] = useState('starting'); // starting | live | unavailable
  const scannerRef = useRef(null);
  const handledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('html5-qrcode');
        if (cancelled) return;
        const inst = new mod.Html5Qrcode(REGION_ID, { verbose: false });
        scannerRef.current = inst;
        await inst.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 260, height: 170 } },
          (decoded) => emit(decoded),
          () => {}, // per-frame decode misses are normal — ignore
        );
        if (!cancelled) setCamState('live');
      } catch {
        if (!cancelled) setCamState('unavailable');
      }
    })();
    return () => { cancelled = true; stopCamera(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function stopCamera() {
    const inst = scannerRef.current;
    scannerRef.current = null;
    if (inst) { try { inst.stop().then(() => inst.clear()).catch(() => {}); } catch { /* already stopped */ } }
  }
  function emit(code) {
    if (handledRef.current) return; // ignore repeat frames of the same code
    handledRef.current = true;
    stopCamera();
    onCode(String(code || '').trim());
  }
  function submitManual(e) {
    e.preventDefault();
    const code = manual.trim();
    if (code) emit(code);
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true">
      <div style={sheet}>
        <div style={head}>
          <strong style={{ fontSize: 16 }}>{title}</strong>
          <button onClick={() => { stopCamera(); onClose?.(); }} style={closeBtn} aria-label="Close">✕</button>
        </div>

        {/* IMPORTANT: #REGION_ID is a LEAF — html5-qrcode injects its own <video>/overlay
            nodes here and owns this subtree. React must never render children into it, or
            unmount/update races throw "removeChild ... not a child" and crash the page. The
            status message is a SIBLING overlay, not a child of the camera div. */}
        <div style={regionWrap}>
          <div id={REGION_ID} style={region} />
          {camState !== 'live' && (
            <div style={regionMsg}>
              {camState === 'starting' ? 'Starting camera…' : '📷 Camera unavailable — enter the code below.'}
            </div>
          )}
        </div>
        {camState === 'live' && <p style={hintStyle}>{hint}</p>}

        <form onSubmit={submitManual} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Or type a code (e.g. SL005)"
            autoCapitalize="characters"
            style={input}
          />
          <button type="submit" style={goBtn} disabled={!manual.trim()}>Go</button>
        </form>
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' };
const sheet = { width: '100%', maxWidth: 460, background: 'var(--card)', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderRadius: 18, padding: 16, margin: 8, boxShadow: 'var(--shadow-pop)' };
const head = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 };
const closeBtn = { width: 36, height: 36, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 16, cursor: 'pointer' };
const regionWrap = { position: 'relative', width: '100%', aspectRatio: '4 / 3', background: '#000', borderRadius: 12, overflow: 'hidden' };
const region = { width: '100%', height: '100%' }; // html5-qrcode's container — keep it a leaf
const regionMsg = { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, textAlign: 'center', padding: 20, pointerEvents: 'none' };
const hintStyle = { color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', margin: '10px 0 0' };
const input = { flex: 1, minWidth: 0, padding: '12px 14px', fontSize: 16, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' };
const goBtn = { padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' };
