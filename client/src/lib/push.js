// Web Push client helpers. Registers the (push-only) service worker and manages
// this device's subscription. All best-effort: unsupported browsers (or no
// permission) just no-op so nothing breaks.
import { api } from './api.js';

const SUPPORTED = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function pushSupported() { return SUPPORTED; }
export function pushPermission() { return SUPPORTED ? Notification.permission : 'denied'; }

// Register the service worker once at startup. Returns the registration (or null).
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); }
  catch (e) { console.warn('[push] SW registration failed', e); return null; }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Is this device currently subscribed?
export async function isSubscribed() {
  if (!SUPPORTED) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return !!(await reg.pushManager.getSubscription());
  } catch { return false; }
}

// Ask permission, subscribe, and register with the server. Returns true on success.
export async function enablePush() {
  if (!SUPPORTED) throw new Error('This browser does not support notifications.');
  const { enabled, publicKey } = await api.getPushKey();
  if (!enabled || !publicKey) throw new Error('Notifications are not available right now.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were blocked. Enable them in your browser settings.');
  const reg = (await navigator.serviceWorker.ready) || (await registerServiceWorker());
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  }
  await api.pushSubscribe(sub.toJSON());
  return true;
}

// Unsubscribe this device.
export async function disablePush() {
  if (!SUPPORTED) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api.pushUnsubscribe(sub.endpoint); await sub.unsubscribe(); }
  } catch { /* ignore */ }
}

// Best-effort: if permission is already granted (e.g. on another device of the
// same browser profile), make sure this device's subscription is on file.
export async function syncPush() {
  if (!SUPPORTED || Notification.permission !== 'granted') return;
  try {
    const { enabled } = await api.getPushKey();
    if (enabled) await enablePush();
  } catch { /* ignore */ }
}
