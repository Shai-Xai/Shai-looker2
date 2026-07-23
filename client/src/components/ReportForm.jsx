// The report form modal (bug / improvement / idea + attachments). Shared by the
// app-wide floating ReportWidget and the "+ New report" button in the Product
// section, so there's one form and one submit path. Controlled via `open`.
//
// Because the form is a full-screen overlay it would hide the very screen the
// user wants to capture. Two escapes avoid losing a half-filled form:
//   • Minimize — collapse to a small floating pill so the screen underneath is
//     visible/recordable (works everywhere, incl. mobile → OS screen recorder),
//     then tap the pill to restore with all state intact.
//   • Record the screen — getDisplayMedia capture that auto-minimizes while it
//     runs, then attaches the clip for you (desktop browsers).
import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';
import { getReportTiles, REPORT_TILES_EVENT } from '../lib/reportContext.js';

const TYPES = [
  ['bug', '🐞 Bug', 'Something is broken or wrong'],
  ['improvement', '✨ Improvement', 'Make something better'],
  ['idea', '💡 Idea', 'A new capability or innovation'],
];
const URGENCIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
// Per-file and TOTAL caps. Attachments ride as base64 JSON to a small server —
// the server parses the whole body in memory (60mb limit there), so the total
// here must stay comfortably under it after the ~1.37× base64 overhead.
const MAX_FILES = 4, MAX_MB = 20, MAX_TOTAL_MB = 40;
const MAX_REC_SECS = 45; // cap a screen recording so the upload stays small
// Screen recording uses getDisplayMedia — desktop browsers only (mobile Safari/
// Chrome don't expose it). On a phone the video-file picker records via camera.
const canScreenRecord = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && typeof window !== 'undefined' && !!window.MediaRecorder;

export default function ReportForm({ open, onClose, screen, onSubmitted, prefill }) {
  const isMobile = useIsMobile();
  const [type, setType] = useState('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [urgency, setUrgency] = useState('normal');
  const [files, setFiles] = useState([]); // { name, mime, data, isImage }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  // Pre-submit AI review: 'compose' → (AI tidies the report) → 'review' where the
  // reporter edits the drafted ticket before it's filed. If the preview fails or
  // AI is off, we submit directly — a report is never blocked on the drafter.
  const [step, setStep] = useState('compose');
  const [aiTitle, setAiTitle] = useState('');
  const [aiSummary, setAiSummary] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [minimized, setMinimized] = useState(false); // collapsed to a pill so the screen shows
  // Which dashboard tile this is about (published by the dashboard view). Empty =
  // whole screen / not tile-specific. `tiles` is the pickable list for this screen.
  const [tiles, setTiles] = useState([]);
  const [tileId, setTileId] = useState('');
  // In-app screen recording (desktop). Live elapsed seconds; the recorder handle
  // lives in a ref so re-renders don't reset it.
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const recRef = useRef(null);

  // Fresh form each time it opens — optionally pre-typed (e.g. the "Interested?
  // Tell us" CTA on the What's in Pulse matrix seeds a ready-to-send request).
  // Also pull the current screen's tiles and keep them in sync (a dashboard may
  // finish loading its definition after the form opens).
  useEffect(() => {
    if (!open) return undefined;
    reset();
    if (prefill) {
      if (prefill.type) setType(prefill.type);
      if (prefill.title) setTitle(prefill.title);
      if (prefill.body) setBody(prefill.body);
    }
    const sync = () => setTiles(getReportTiles());
    sync();
    window.addEventListener(REPORT_TILES_EVENT, sync);
    return () => window.removeEventListener(REPORT_TILES_EVENT, sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill]);

  // Stop any in-flight recording if the modal is closed or unmounts, so the
  // browser's screen-share doesn't keep running in the background.
  useEffect(() => { if (!open) stopRecording(); }, [open]);
  useEffect(() => () => stopRecording(), []);

  function reset() {
    setType('bug'); setTitle(''); setBody(''); setUrgency('normal'); setFiles([]);
    setTileId(''); setBusy(false); setDone(false); setError(''); setMinimized(false);
    setStep('compose'); setAiTitle(''); setAiSummary(''); setReviewed(false);
  }
  const tileName = () => (tiles.find((t) => t.id === tileId) || {}).title || '';

  async function addFiles(e) {
    const picked = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-picking the same file
    setError('');
    for (const f of picked) {
      if (files.length >= MAX_FILES) { setError(`Up to ${MAX_FILES} files.`); break; }
      const isImage = f.type.startsWith('image/');
      const isVideo = f.type.startsWith('video/');
      if (!isImage && !isVideo) { setError('Only images and videos can be attached.'); continue; }
      if (f.size > MAX_MB * 1024 * 1024) { setError(`Each file must be under ${MAX_MB}MB.`); continue; }
      try {
        // Downscale images to keep the upload small; videos pass through as-is.
        const data = isImage ? await downscaleImage(f) : await readAsDataURL(f);
        setFiles((prev) => {
          if (prev.length >= MAX_FILES) return prev;
          const total = prev.reduce((n, x) => n + (x.data?.length || 0), 0) + data.length;
          if (total > MAX_TOTAL_MB * 1024 * 1024 * 1.37) { setError(`Attachments together must stay under ${MAX_TOTAL_MB}MB — remove one first.`); return prev; }
          return [...prev, { name: f.name, mime: isImage ? 'image/jpeg' : f.type, data, isImage }];
        });
      } catch { setError('Could not read that file.'); }
    }
  }
  const removeFile = (i) => setFiles((prev) => prev.filter((_, j) => j !== i));

  // ── Screen recording ──────────────────────────────────────────────────────
  // Capture the screen with getDisplayMedia + MediaRecorder, then attach the
  // result as a video (alongside — or instead of — a screenshot). Auto-stops at
  // MAX_REC_SECS and when the user ends the share from the browser's own UI.
  async function startRecording() {
    setError('');
    if (recording) return;
    if (files.length >= MAX_FILES) { setError(`Up to ${MAX_FILES} files.`); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); }
    catch { return; } // the user cancelled the screen-picker — not an error
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((m) => window.MediaRecorder.isTypeSupported?.(m)) || 'video/webm';
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime }); }
    catch { stream.getTracks().forEach((t) => t.stop()); setError('Screen recording isn’t supported in this browser.'); return; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = async () => {
      if (recRef.current?.timer) clearInterval(recRef.current.timer);
      stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
      setRecording(false); setRecSecs(0);
      setMinimized(false); // bring the form back so they can see it attached
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) return;
      if (blob.size > MAX_MB * 1024 * 1024) { setError(`Recording is over ${MAX_MB}MB — keep it shorter.`); return; }
      try {
        const data = await readAsDataURL(blob);
        setFiles((prev) => prev.length < MAX_FILES ? [...prev, { name: 'screen-recording.webm', mime, data, isImage: false }] : prev);
      } catch { setError('Could not save the recording.'); }
    };
    // Ending the share from Chrome's "Stop sharing" bar fires 'ended'.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (rec.state !== 'inactive') rec.stop(); });
    const timer = setInterval(() => setRecSecs((s) => {
      const n = s + 1;
      if (n >= MAX_REC_SECS && rec.state !== 'inactive') rec.stop();
      return n;
    }), 1000);
    recRef.current = { rec, timer };
    rec.start();
    setRecording(true); setRecSecs(0);
    setMinimized(true); // get out of the way so the screen is recordable
  }
  function stopRecording() {
    const r = recRef.current;
    if (r?.rec && r.rec.state !== 'inactive') { try { r.rec.stop(); } catch { /* already stopping */ } }
  }

  function handleClose() { stopRecording(); onClose?.(); }
  // Step 1: the AI tidies the raw report into the ticket the team will work
  // from, and the reporter gets to see + edit it BEFORE it's filed. Fail-soft:
  // no draft (AI off / error) → submit directly, exactly the old behaviour.
  async function submit() {
    if (!body.trim() && !title.trim()) { setError('Add a title or a description.'); return; }
    if (recording) stopRecording();
    setBusy(true); setError('');
    try {
      const d = await api.previewTicket({ type, title: title.trim(), body: body.trim(), screen, tile: tileName() });
      if (d && (d.aiTitle || '').trim() && (d.aiSummary || '').trim()) {
        setAiTitle(d.aiTitle); setAiSummary(d.aiSummary);
        setStep('review'); setBusy(false);
        return;
      }
    } catch { /* preview is best-effort — fall through to a direct submit */ }
    await sendFinal(false);
  }

  // Step 2 (or the direct path): actually file it. withDraft = the reporter
  // reviewed/edited the AI draft, which then lands as the ticket's canonical spec.
  async function sendFinal(withDraft) {
    setBusy(true); setError('');
    try {
      await api.submitTicket({
        type, title: title.trim(), body: body.trim(), urgency, screen, tileId, tileName: tileName(),
        ...(withDraft && aiSummary.trim() ? { aiTitle: aiTitle.trim(), aiSummary: aiSummary.trim() } : {}),
        attachments: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })),
      });
      setReviewed(!!withDraft);
      setDone(true);
      onSubmitted?.();
    } catch (e) {
      setError(e.message || 'Could not submit — please try again.');
    } finally { setBusy(false); }
  }

  if (!open) return null;

  // Collapsed: a small floating pill so the underlying screen is visible/recordable.
  if (minimized) {
    return (
      <div style={{
        position: 'fixed', zIndex: 200, bottom: 'calc(16px + env(safe-area-inset-bottom))',
        left: isMobile ? 12 : 'auto', right: isMobile ? 12 : 20,
        display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
        borderRadius: 999, background: 'var(--card)', border: '1px solid var(--hairline)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
      }}>
        {recording ? (
          <>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#e5484d', flexShrink: 0, animation: 'pulse-rec 1s ease-in-out infinite' }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>Recording {fmt(recSecs)}</span>
            <button onClick={stopRecording} style={{ ...btnPrimary, padding: '7px 12px', fontSize: 13 }}>⏹ Stop &amp; attach</button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>📝 Report paused</span>
            <button onClick={() => setMinimized(false)} style={{ ...btnPrimary, padding: '7px 12px', fontSize: 13 }}>Resume</button>
          </>
        )}
        <style>{'@keyframes pulse-rec{0%,100%{opacity:1}50%{opacity:.35}}'}</style>
      </div>
    );
  }

  const bodyLabel = type === 'bug'
    ? 'What went wrong? What did you expect instead?'
    : "What's the objective? What outcome do you want?";

  return (
    <div
      onClick={handleClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center',
        padding: isMobile ? 0 : 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: isMobile ? 'none' : 460, background: 'var(--card)',
          borderRadius: isMobile ? '18px 18px 0 0' : 16, border: '1px solid var(--hairline)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)', maxHeight: isMobile ? '92dvh' : '88vh',
          overflowY: 'auto', paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <div style={{ padding: '18px 18px 20px' }}>
          {done ? (
            <div style={{ textAlign: 'center', padding: '24px 8px' }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>🙌</div>
              <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Thank you — logged.</h3>
              <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 18 }}>
                {reviewed
                  ? 'It’s on the board exactly as you approved it — the team will pick it up.'
                  : type === 'bug'
                    ? 'The team can see it on the product board and will pick it up.'
                    : "We're turning your note into a clear ticket now — the team will review it on the board."}
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button onClick={reset} style={btnGhost}>Report another</button>
                <button onClick={handleClose} style={btnPrimary}>Done</button>
              </div>
            </div>
          ) : step === 'review' ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <h3 style={{ fontSize: 18, fontWeight: 700 }}>Review your ticket</h3>
                <button onClick={handleClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1 }}>×</button>
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>
                We tidied your report into the ticket the team will work from. Edit anything — what you send is what they see.
              </p>

              <label style={lbl}>Title</label>
              <input className="fld" value={aiTitle} onChange={(e) => setAiTitle(e.target.value)}
                style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box' }} />

              <label style={lbl}>Ticket</label>
              <textarea className="fld" value={aiSummary} onChange={(e) => setAiSummary(e.target.value)}
                rows={isMobile ? 10 : 13}
                style={{ width: '100%', marginBottom: 8, boxSizing: 'border-box', resize: 'vertical', lineHeight: 1.45, fontSize: 13.5 }} />
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 14 }}>
                Your original words{files.length ? ' and attachments' : ''} travel with the ticket too.
              </p>

              {error && <p style={{ color: 'var(--brand)', fontSize: 13, marginBottom: 10 }}>{error}</p>}

              <div style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column-reverse' : 'row' }}>
                <button onClick={() => { setStep('compose'); setError(''); }} disabled={busy} style={{ ...btnGhost, flex: isMobile ? 'none' : '0 0 auto' }}>← Edit report</button>
                <button onClick={() => sendFinal(true)} disabled={busy} style={{ ...btnPrimary, flex: 1, opacity: busy ? 0.6 : 1 }}>
                  {busy ? 'Sending…' : 'Send report'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <h3 style={{ fontSize: 18, fontWeight: 700 }}>Report</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => setMinimized(true)} aria-label="Minimize to see the screen"
                    title="Minimize to see/record the screen"
                    style={{ background: 'none', border: 'none', fontSize: 20, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}>—</button>
                  <button onClick={handleClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1 }}>×</button>
                </div>
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>
                On <strong style={{ color: 'var(--text)' }}>{screen}</strong>. Tell us what's up — a person and the AI will pick it up.
              </p>

              {/* Type */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                {TYPES.map(([key, label]) => (
                  <button key={key} onClick={() => setType(key)} style={segBtn(type === key)}>{label}</button>
                ))}
              </div>

              <label style={lbl}>Title <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
              <input className="fld" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder={type === 'bug' ? 'Short summary of the problem' : 'Short summary of the idea'}
                style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box' }} />

              <label style={lbl}>{bodyLabel}</label>
              <textarea className="fld" value={body} onChange={(e) => setBody(e.target.value)} rows={5}
                placeholder={type === 'bug' ? 'e.g. When I click Export on the sales dashboard, nothing happens…' : 'e.g. It would help if we could…'}
                style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box', resize: 'vertical' }} />

              {/* Tile picker — only when the current screen (a dashboard) has
                  published its tiles. Lets the reporter pinpoint the offending
                  tile so triage doesn't have to guess. A native select is the
                  most reliable, mobile-friendly picker for a long tile list. */}
              {tiles.length > 0 && (
                <>
                  <label style={lbl}>Which tile is this about? <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
                  <select className="fld" value={tileId} onChange={(e) => setTileId(e.target.value)}
                    style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box' }}>
                    <option value="">Whole dashboard / not tile-specific</option>
                    {tiles.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                </>
              )}

              {/* Attachments: screenshot / image / video / screen recording */}
              <label style={lbl}>Screenshot, image or {canScreenRecord ? 'screen recording' : 'video'} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                {files.map((f, i) => (
                  <div key={i} style={{ position: 'relative', width: 64, height: 64, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--hairline)', background: 'rgba(128,128,128,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {f.isImage ? <img src={f.data} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 24 }}>🎬</span>}
                    <button onClick={() => removeFile(i)} aria-label="Remove" style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 11, lineHeight: 1, cursor: 'pointer' }}>×</button>
                  </div>
                ))}
                {files.length < MAX_FILES && !recording && (
                  <label style={{ width: 64, height: 64, borderRadius: 8, border: '1px dashed var(--hairline)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, cursor: 'pointer', color: 'var(--muted)' }} title="Add a screenshot, image or video">
                    ＋
                    <input type="file" accept="image/*,video/*" multiple onChange={addFiles} style={{ display: 'none' }} />
                  </label>
                )}
                {/* Record the screen (desktop) — the alternative to a screenshot
                    for intermittent / interaction bugs. */}
                {canScreenRecord && files.length < MAX_FILES && !recording && (
                  <button type="button" onClick={startRecording} title="Record your screen"
                    style={{ width: 64, height: 64, borderRadius: 8, border: '1px dashed var(--hairline)', display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center', justifyContent: 'center', fontSize: 20, cursor: 'pointer', color: 'var(--muted)', background: 'transparent' }}>
                    🎥<span style={{ fontSize: 9, fontWeight: 600 }}>Record</span>
                  </button>
                )}
                {recording && (
                  <div style={{ minWidth: 64, height: 64, padding: '0 10px', borderRadius: 8, border: '1px solid var(--brand)', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center', justifyContent: 'center', background: 'rgba(var(--brand-rgb), 0.08)' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: 'var(--brand)' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--brand)' }} />
                      {recSecs}s
                    </span>
                    <button type="button" onClick={stopRecording} style={{ padding: '3px 8px', borderRadius: 6, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Stop</button>
                  </div>
                )}
              </div>

              {/* Capture a recording of the buggy screen without losing this form. */}
              {files.length < MAX_FILES && !recording && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <button onClick={() => setMinimized(true)} style={{ ...btnGhost, padding: '8px 12px', fontSize: 13 }}>
                    — Minimize to record
                  </button>
                </div>
              )}
              <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -2, marginBottom: 12 }}>
                {canScreenRecord
                  ? '🎥 Record attaches a clip automatically. Or minimize to capture with your own recorder, then attach it.'
                  : 'Minimize the form to record the screen with your device, then reopen and attach the clip.'}
              </p>

              {type === 'bug' && (
                <>
                  <label style={lbl}>How urgent is it?</label>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                    {URGENCIES.map(([key, label]) => (
                      <button key={key} onClick={() => setUrgency(key)} style={segBtn(urgency === key)}>{label}</button>
                    ))}
                  </div>
                </>
              )}

              {error && <p style={{ color: 'var(--brand)', fontSize: 13, marginBottom: 10 }}>{error}</p>}

              <button onClick={submit} disabled={busy} style={{ ...btnPrimary, width: '100%', opacity: busy ? 0.6 : 1 }}>
                {busy ? 'Tidying it into a ticket…' : 'Continue'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// mm:ss for the recording timer.
function fmt(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Read a file/blob straight to a data-URL (used for video, kept as-is).
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
// Downscale an image to a small JPEG data-URL before upload (keeps the DB sane).
function downscaleImage(file, max = 1600, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject; img.src = reader.result;
    };
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}

const lbl = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 };
const btnPrimary = { padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const btnGhost = { padding: '10px 16px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
function segBtn(active) {
  return {
    flex: 1, padding: '8px 6px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--brand)' : 'var(--hairline)'}`,
    background: active ? 'rgba(var(--brand-rgb), 0.12)' : 'transparent',
    color: active ? 'var(--brand)' : 'var(--text)', whiteSpace: 'nowrap',
  };
}
