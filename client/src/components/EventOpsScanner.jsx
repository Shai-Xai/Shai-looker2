import { useEffect, useRef, useState } from 'react';

// Full-screen device scanner for Event Ops. Two modes:
//  • "QR / barcode" — live camera via html5-qrcode (dynamically imported so it code-splits).
//  • "Read label" — OCR for PRINTED codes like SL006: snap a photo, Tesseract (also lazily
//    imported) reads it, we extract the code candidates for a one-tap confirm.
// A manual-entry box is always offered as the reliable fallback. The component is "dumb":
// it only resolves a code string back to the caller via onCode.
const REGION_ID = 'eventops-scan-region';

export default function EventOpsScanner({ onCode, onClose, title = 'Scan a device' }) {
  const [mode, setMode] = useState('scan'); // scan | ocr
  const [manual, setManual] = useState('');
  const [camState, setCamState] = useState('starting'); // starting | live | unavailable
  const scannerRef = useRef(null);
  const handledRef = useRef(false);

  // OCR state
  const [ocrPhoto, setOcrPhoto] = useState('');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrCandidates, setOcrCandidates] = useState([]);
  const [ocrPick, setOcrPick] = useState('');

  useEffect(() => {
    if (mode !== 'scan') { stopCamera(); return undefined; }
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('html5-qrcode');
        if (cancelled) return;
        setCamState('starting');
        const inst = new mod.Html5Qrcode(REGION_ID, { verbose: false });
        scannerRef.current = inst;
        await inst.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 170 } },
          (decoded) => emit(decoded), () => {});
        if (!cancelled) setCamState('live');
      } catch { if (!cancelled) setCamState('unavailable'); }
    })();
    return () => { cancelled = true; stopCamera(); };
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  function stopCamera() {
    const inst = scannerRef.current;
    scannerRef.current = null;
    if (inst) { try { inst.stop().then(() => inst.clear()).catch(() => {}); } catch { /* already stopped */ } }
  }
  function emit(code) {
    if (handledRef.current) return;
    handledRef.current = true;
    stopCamera();
    onCode(String(code || '').trim());
  }
  function submitManual(e) {
    e.preventDefault();
    if (manual.trim()) emit(manual.trim());
  }

  // ── OCR: photo → Tesseract → candidate codes ──
  async function onPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const url = await fileToDataUrl(file);
    setOcrPhoto(url); setOcrCandidates([]); setOcrPick(''); setOcrBusy(true);
    try {
      const T = await import('tesseract.js');
      const recognize = T.recognize || (T.default && T.default.recognize);
      const { data } = await recognize(url, 'eng');
      const cands = extractCodes(data.text || '');
      setOcrCandidates(cands);
      setOcrPick(cands[0] || '');
    } catch {
      setOcrPick('');
    }
    setOcrBusy(false);
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true">
      <div style={sheet}>
        <div style={head}>
          <strong style={{ fontSize: 16 }}>{title}</strong>
          <button onClick={() => { stopCamera(); onClose?.(); }} style={closeBtn} aria-label="Close">✕</button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button onClick={() => setMode('scan')} style={modeBtn(mode === 'scan')}>📷 QR / barcode</button>
          <button onClick={() => setMode('ocr')} style={modeBtn(mode === 'ocr')}>🔤 Read label</button>
        </div>

        {mode === 'scan' ? (
          <>
            {/* #REGION_ID is a LEAF — html5-qrcode owns its subtree; status is a sibling overlay. */}
            <div style={regionWrap}>
              <div id={REGION_ID} style={region} />
              {camState !== 'live' && (
                <div style={regionMsg}>{camState === 'starting' ? 'Starting camera…' : '📷 Camera unavailable — type the code below.'}</div>
              )}
            </div>
            {camState === 'live' && <p style={hintStyle}>Point at the QR code or barcode</p>}
          </>
        ) : (
          <div>
            <div style={regionWrap}>
              {ocrPhoto ? <img src={ocrPhoto} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <div style={regionMsg}>Snap a photo of the printed code (e.g. SL006)</div>}
              {ocrBusy && <div style={{ ...regionMsg, background: 'rgba(0,0,0,0.45)' }}>Reading…</div>}
            </div>
            <label style={{ ...secondaryBtn, display: 'block', textAlign: 'center', marginTop: 10, cursor: 'pointer' }}>
              📸 {ocrPhoto ? 'Retake photo' : 'Take a photo'}
              <input type="file" accept="image/*" capture="environment" onChange={onPhoto} style={{ display: 'none' }} />
            </label>
            {ocrCandidates.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Tap the code, or edit it below:</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {ocrCandidates.map((c) => (
                    <button key={c} onClick={() => setOcrPick(c)} style={candChip(ocrPick === c)}>{c}</button>
                  ))}
                </div>
              </div>
            )}
            {ocrPhoto && !ocrBusy && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input value={ocrPick} onChange={(e) => setOcrPick(e.target.value)} placeholder="Code" autoCapitalize="characters" style={input} />
                <button onClick={() => ocrPick.trim() && emit(ocrPick.trim())} style={goBtn} disabled={!ocrPick.trim()}>Use</button>
              </div>
            )}
          </div>
        )}

        <form onSubmit={submitManual} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or type a code (e.g. SL006)" autoCapitalize="characters" style={input} />
          <button type="submit" style={goBtn} disabled={!manual.trim()}>Go</button>
        </form>
      </div>
    </div>
  );
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
// Pull likely device codes out of OCR text: letters+digits (SL006, SL-006, SL 006), then any
// mixed alphanumeric token. Deduped, most-code-like first.
function extractCodes(text) {
  const up = (text || '').toUpperCase();
  const out = [];
  const push = (v) => { const s = v.trim(); if (s && !out.includes(s)) out.push(s); };
  (up.match(/[A-Z]{1,5}\s?-?\s?\d{2,6}/g) || []).forEach((m) => push(m.replace(/[\s-]/g, '')));
  (up.match(/[A-Z0-9]{3,12}/g) || []).forEach((m) => { if (/[A-Z]/.test(m) && /\d/.test(m)) push(m); });
  return out.slice(0, 6);
}

const overlay = { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const sheet = { width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', borderRadius: 18, padding: 16, boxShadow: 'var(--shadow-pop)' };
const head = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 };
const closeBtn = { width: 36, height: 36, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 16, cursor: 'pointer' };
const regionWrap = { position: 'relative', width: '100%', aspectRatio: '4 / 3', background: '#000', borderRadius: 12, overflow: 'hidden' };
const region = { width: '100%', height: '100%' };
const regionMsg = { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, textAlign: 'center', padding: 20 };
const hintStyle = { color: 'var(--muted)', fontSize: 12.5, textAlign: 'center', margin: '10px 0 0' };
const input = { flex: 1, minWidth: 0, padding: '12px 14px', fontSize: 16, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' };
const goBtn = { padding: '0 18px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' };
const modeBtn = (on) => ({ flex: 1, padding: '9px', borderRadius: 10, border: '1px solid ' + (on ? 'var(--brand)' : 'var(--border)'), background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--text)', fontWeight: on ? 700 : 500, fontSize: 13.5, cursor: 'pointer' });
const secondaryBtn = { padding: '11px 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontWeight: 600, fontSize: 14 };
const candChip = (on) => ({ padding: '8px 14px', borderRadius: 20, fontSize: 15, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--brand)' : 'var(--border)'), background: on ? 'var(--brand)' : 'transparent', color: on ? '#fff' : 'var(--text)' });
