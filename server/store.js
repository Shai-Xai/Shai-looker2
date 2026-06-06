// ─── Dashboard store ─────────────────────────────────────────────────────────
// File-backed persistence for editable dashboard definitions. Each dashboard is
// one JSON file under data/dashboards/. Intentionally dependency-free so it runs
// anywhere; the interface (list/get/create/update/remove) can later be swapped
// for Postgres/Mongo without touching callers.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data', 'dashboards');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileFor(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

function readFile(id) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
  } catch {
    return null;
  }
}

function list() {
  ensureDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readFile(path.basename(f, '.json')))
    .filter(Boolean)
    .map(({ id, title, description, updatedAt, createdAt, source, tiles, tenantId }) => ({
      id,
      title,
      description: description || '',
      tileCount: (tiles || []).length,
      source: source || null,
      tenantId: tenantId || null,
      createdAt,
      updatedAt,
    }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function get(id) {
  ensureDir();
  return readFile(id);
}

function create(def) {
  ensureDir();
  const now = new Date().toISOString();
  const dashboard = {
    id: crypto.randomUUID(),
    title: def.title || 'Untitled dashboard',
    description: def.description || '',
    theme: def.theme || defaultTheme(),
    filters: def.filters || [],
    tiles: def.tiles || [],
    carousels: def.carousels || [],
    source: def.source || null,
    tenantId: def.tenantId || null,
    createdAt: now,
    updatedAt: now,
  };
  fs.writeFileSync(fileFor(dashboard.id), JSON.stringify(dashboard, null, 2));
  return dashboard;
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  const updated = {
    ...existing,
    ...patch,
    id: existing.id, // never allow id reassignment
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(fileFor(id), JSON.stringify(updated, null, 2));
  return updated;
}

function remove(id) {
  try {
    fs.unlinkSync(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

function defaultTheme() {
  return {
    brand: '#ff385c',
    background: '#f5f6f8',
    tileBackground: '#ffffff',
    text: '#222222',
  };
}

module.exports = { list, get, create, update, remove, defaultTheme };
