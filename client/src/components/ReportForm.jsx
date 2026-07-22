// The report form modal (bug / improvement / idea + attachments). Shared by the
// app-wide floating ReportWidget and the "+ New report" button in the Product
// section, so there's one form and one submit path. Controlled via `open`.
//
// Because the form is a full-screen overlay, it used to hide the very screen the
// user wants to record. Two escapes make capturing a recording possible without
// losing the half-filled form:
//   • Minimize — collapse to a small floating pill so the screen underneath is
//     visible/recordable (works everywhere, incl. mobile → OS screen recorder),
//     then tap the pill to restore with all state intact.
//   • Record the screen — one tap uses the browser's screen-capture API to record
//     directly, auto-minimizing while it runs, then attaches the video for you.
import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

const TYPES = [
  ['bug', '🐞 Bug', 'Something is broken or wrong'],
  ['improvement', '✨ Improvement', 'Make something better'],
  ['idea', '💡 Idea', 'A new capability or innovation'],
];
const URGENCIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
const MAX_FILES = 4, MAX_MB = 30;

// Can this browser record the screen itself? (Desktop Chromium/Firefox yes; iOS
// Safari no — those users minimize + use the OS recorder instead.)
const canRecordScreen = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia &&
  typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';

export default function ReportForm({ open, onClose, screen, onSubmitted }) {
  const isMobile = useIsMobile();
  const [type, setType] = useState('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [urgency, setUrgency] = useState('normal');
  const [files, setFiles] = useState([]); // { name, mime, data, isImage }
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [minimized, setMinimized] = useState(false); // collapsed to a pill so the screen shows
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0); // recording seconds, for the timer

  // Live recording plumbing (refs so callbacks/cleanup always see the latest).
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);

  // Fresh form each time it opens.
  useEffect(() => { if (open) reset(); }, [open]);
  // Always tear down any live capture when the host unmounts.
  useEffect(() => () => stopTracks(), []);

  function reset() {
    setType('bug'); setTitle(''); setBody(''); setUrgency('normal'); setFiles([]);
    setBusy(false); setDone(false); setError('');
    setMinimized(false); stopRecording();
  }

  // Stop the underlying screen-capture stream + timer (does not attach anything).
  function stopTracks() {
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    streamRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

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
        setFiles((prev) => prev.length < MAX_FILES ? [...prev, { name: f.name, mime: isImage ? 'image/jpeg' : f.type, data, isImage }] : prev);
      } catch { setError('Could not read that file.'); }
    }
  }
  const removeFile = (i) => setFiles((prev) => prev.filter((_, j) => j !== i));

  // --- Screen recording -----------------------------------------------------
  async function startRecording() {
    if (files.length >= MAX_FILES) { setError(`Up to ${MAX_FILES} files.`); return; }
    if (!canRecordScreen()) {
      setError('This browser can\'t record the screen. Tap Minimize, capture with your device\'s recorder, then attach it here.');
      return;
    }
    setError('');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 12 }, audio: false });
    } catch {
      setError('Screen recording was cancelled or blocked.');
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType = pickVideoMime();
    let rec;
    try {
      rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 2_500_000 });
    } catch {
      stopTracks(); setError('Could not start recording on this browser.'); return;
    }
    recorderRef.current = rec;
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunksRef.current.push(ev.data); };
    rec.onstop = () => finishRecording(rec.mimeType || mimeType || 'video/webm');
    // If the user ends sharing via the browser's own "Stop sharing" control, wrap up.
    stream.getVideoTracks().forEach((t) => { t.onended = () => stopRecording(); });
    rec.start(1000);
    setRecording(true);
    setElapsed(0);
    setMinimized(true); // get out of the way so the screen is recordable
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  }

  // Ask the recorder to stop; the actual attach happens in onstop → finishRecording.
  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* noop */ } }
    else { stopTracks(); setRecording(false); }
  }

  async function finishRecording(mimeType) {
    stopTracks();
    setRecording(false);
    const chunks = chunksRef.current; chunksRef.current = [];
    recorderRef.current = null;
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: mimeType });
    setMinimized(false); // bring the form back so they can see it attached
    if (blob.size > MAX_MB * 1024 * 1024) {
      setError(`That recording is over ${MAX_MB}MB — keep it shorter, or attach a trimmed clip.`);
      return;
    }
    try {
      const data = await readAsDataURL(blob);
      const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
      setFiles((prev) => prev.length < MAX_FILES
        ? [...prev, { name: `screen-recording.${ext}`, mime: mimeType, data, isImage: false }]
        : prev);
    } catch { setError('Could not save that recording.'); }
  }

  function handleClose() { stopRecording(); onClose?.(); }

  async function submit() {
    if (!body.trim() && !title.trim()) { setError('Add a title or a description.'); return; }
    setBusy(true); setError('');
    try {
      await api.submitTicket({ type, title: title.trim(), body: body.trim(), urgency, screen, attachments: files.map((f) => ({ name: f.name, mime: f.mime, data: f.data })) });
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
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>Recording {fmt(elapsed)}</span>
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
                {type === 'bug'
                  ? 'The team can see it on the product board and will pick it up.'
                  : "We're turning your note into a clear ticket now — the team will review it on the board."}
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button onClick={reset} style={btnGhost}>Report another</button>
                <button onClick={handleClose} style={btnPrimary}>Done</button>
              </div>
            </div>
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

              {/* Attachments: screenshot / image / video */}
              <label style={lbl}>Screenshot, image or video <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {files.map((f, i) => (
                  <div key={i} style={{ position: 'relative', width: 64, height: 64, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--hairline)', background: 'rgba(128,128,128,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {f.isImage ? <img src={f.data} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 24 }}>🎬</span>}
                    <button onClick={() => removeFile(i)} aria-label="Remove" style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 11, lineHeight: 1, cursor: 'pointer' }}>×</button>
                  </div>
                ))}
                {files.length < MAX_FILES && (
                  <label style={{ width: 64, height: 64, borderRadius: 8, border: '1px dashed var(--hairline)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, cursor: 'pointer', color: 'var(--muted)' }}>
                    ＋
                    <input type="file" accept="image/*,video/*" multiple onChange={addFiles} style={{ display: 'none' }} />
                  </label>
                )}
              </div>

              {/* Capture a recording of the buggy screen without losing this form. */}
              {files.length < MAX_FILES && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {canRecordScreen() && (
                    <button onClick={startRecording} style={{ ...btnGhost, padding: '8px 12px', fontSize: 13 }}>🎥 Record the screen</button>
                  )}
                  <button onClick={() => setMinimized(true)} style={{ ...btnGhost, padding: '8px 12px', fontSize: 13 }}>
                    — Minimize to record
                  </button>
                </div>
              )}
              <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: -2, marginBottom: 12 }}>
                {canRecordScreen()
                  ? 'Record the screen attaches a clip automatically. Or minimize to capture with your own recorder, then attach it.'
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
                {busy ? 'Sending…' : 'Submit'}
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

// Pick a video container/codec the browser can actually record.
function pickVideoMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
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
