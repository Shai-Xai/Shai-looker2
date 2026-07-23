// Require-contract check: every property a server module USES on a require()d
// sibling must actually be EXPORTED by that sibling. This is the cheap,
// deterministic net for the `listJourneys` class of bug — journeys.js kept
// calling actionTemplates.listJourneys() after a revert removed the export, and
// nothing caught it until production 500s paged the ops channel. A revert, a
// bad merge, or a rename that orphans a call site now fails CI instead.
//
// How: require each server module for its REAL export surface (spreads and
// computed keys included — static parsing would miss them), then statically
// scan every other server file for `binding.prop` accesses on require('./x')
// bindings and destructured requires. Deliberately conservative to stay
// false-positive-free:
//   • modules that throw on require (need env/config) are skipped
//   • function/class exports are skipped (props on functions are unusual)
//   • `binding.prop?.(...)` optional access is skipped — that syntax is the
//     author saying "this export may legitimately be absent"
//   • assignments (`binding.prop = ...`) are skipped (augmentation)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers'); // sets DATA_DIR/DB_FILE before any server module loads db

const SERVER = path.join(__dirname, '..', 'server');
// index.js is the composition root — requiring it boots the whole app.
const SKIP_REQUIRE = new Set(['index.js']);
// Object.prototype members a `binding.x` scan may hit without meaning exports.
const PROTO = new Set(['hasOwnProperty', 'toString', 'valueOf', 'constructor', 'call', 'apply', 'bind', 'length', 'name', 'prototype']);

const files = fs.readdirSync(SERVER).filter((f) => f.endsWith('.js'));

// Real export surfaces, by module basename (no extension).
const surfaces = new Map(); // name -> Set(keys) | null (unknown: skipped/function)
for (const f of files) {
  const name = f.replace(/\.js$/, '');
  if (SKIP_REQUIRE.has(f)) { surfaces.set(name, null); continue; }
  try {
    const m = require(path.join(SERVER, f));
    surfaces.set(name, m && typeof m === 'object' && !Array.isArray(m) ? new Set(Object.keys(m)) : null);
  } catch { surfaces.set(name, null); } // needs env/config we don't have — skip
}

// String/Array method names: a local variable shadowing a require binding
// inside a function (e.g. `const roles = row.roles; roles.split(',')`) would
// otherwise read as a missing export. No server module exports these names.
const BUILTIN_METHODS = new Set(['split', 'filter', 'map', 'join', 'slice', 'splice', 'forEach', 'includes', 'indexOf', 'lastIndexOf', 'replace', 'replaceAll', 'trim', 'concat', 'some', 'every', 'reduce', 'sort', 'reverse', 'find', 'findIndex', 'flat', 'flatMap', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'padStart', 'padEnd', 'charAt', 'charCodeAt', 'substring', 'push', 'pop', 'shift', 'unshift']);

// Remove comments without disturbing string/template contents (a naive
// `//.*` strip would eat code after any string containing a URL).
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = ''; // '', "'", '"', '`'
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === mode) mode = '';
      i += 1; continue;
    }
    if (c === "'" || c === '"' || c === '`') { mode = c; out += c; i += 1; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') { const end = src.indexOf('*/', i + 2); i = end === -1 ? src.length : end + 2; continue; }
    out += c; i += 1;
  }
  return out;
}

// Scan one source string for contract violations against `surfaces`.
// Returns [{ binding, module, prop }]. Exported for the self-test below.
function violationsIn(rawSrc, surfacesMap) {
  const src = stripComments(rawSrc);
  const out = [];
  const check = (moduleName, prop, binding) => {
    const surface = surfacesMap.get(moduleName);
    if (!surface || PROTO.has(prop) || BUILTIN_METHODS.has(prop)) return;
    if (!surface.has(prop)) out.push({ binding, module: moduleName, prop });
  };

  // const X = require('./mod');  →  every plain `X.prop` access must exist.
  const bindRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]\.\/([\w-]+)(?:\.js)?['"]\s*\)\s*[;\n]/g;
  const bindings = new Map();
  let m;
  while ((m = bindRe.exec(src))) bindings.set(m[1], m[2]);
  for (const [binding, moduleName] of bindings) {
    if (!surfacesMap.get(moduleName)) continue;
    // Shadowing guard: if the name is re-declared anywhere else in the file
    // (a scoped `const meta = JSON.parse(...)`, a callback param `(meta) =>`),
    // a regex scan can't tell module accesses from local ones — skip the whole
    // binding for this file. Losing coverage beats a false positive.
    const declRe = new RegExp(`(?:const|let|var)\\s+${binding}\\b`, 'g');
    const declCount = (src.match(declRe) || []).length;
    const paramRe = new RegExp(`\\(([^()]*\\b${binding}\\b[^()]*)\\)\\s*(?:=>|\\{)`);
    if (declCount > 1 || paramRe.test(src)) continue;
    // Lookbehind: `channels.tiktok.lastAt` is a property chain, not the module.
    const useRe = new RegExp(`(?<![.\\w$])${binding}\\.([A-Za-z_$][\\w$]*)`, 'g');
    let u;
    while ((u = useRe.exec(src))) {
      const after = src.slice(u.index + u[0].length, u.index + u[0].length + 2);
      if (after.startsWith('?.')) continue;                    // optional by design
      if (/^\s*=[^=]/.test(src.slice(u.index + u[0].length))) continue; // augmentation
      check(moduleName, u[1], binding);
    }
  }

  // const { a, b: c } = require('./mod');  →  a and b must exist. The negative
  // lookahead skips destructuring a CALL result (require('./x').fn()...).
  const destrRe = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"]\.\/([\w-]+)(?:\.js)?['"]\s*\)(?!\s*[.(])/g;
  while ((m = destrRe.exec(src))) {
    const moduleName = m[2];
    if (!surfacesMap.get(moduleName)) continue;
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) check(moduleName, key, '{destructure}');
    }
  }

  // Inline require('./mod').prop — the http.js → ops.alert pattern.
  const inlineRe = /require\(\s*['"]\.\/([\w-]+)(?:\.js)?['"]\s*\)\.([A-Za-z_$][\w$]*)/g;
  while ((m = inlineRe.exec(src))) check(m[1], m[2], '(inline)');

  return out;
}

test('every used export on a required server module actually exists (listJourneys-class guard)', () => {
  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(SERVER, f), 'utf8');
    for (const v of violationsIn(src, surfaces)) {
      problems.push(`server/${f}: ${v.binding === '(inline)' ? `require('./${v.module}')` : v.binding}.${v.prop} — server/${v.module}.js does not export '${v.prop}'`);
    }
  }
  assert.deepEqual(problems, [], `\nBroken require contracts (call site survived a revert/rename?):\n${problems.join('\n')}\n`);
});

test('the scanner really catches the listJourneys class of bug (self-test)', () => {
  // A synthetic module surface WITHOUT listJourneys + the exact call shape
  // journeys.js used. If the scanner ever regresses, this fails first.
  const fakeSurfaces = new Map([['actionTemplates', new Set(['get', 'list', 'resolveAudience'])]]);
  const src = "const actionTemplates = require('./actionTemplates');\nres.json({ recipes: actionTemplates.listJourneys() });\n";
  const v = violationsIn(src, fakeSurfaces);
  assert.equal(v.length, 1);
  assert.equal(v[0].prop, 'listJourneys');
  // …and the guarded/optional forms are respected (no false positives):
  assert.equal(violationsIn("const a = require('./actionTemplates');\na.get('x'); a.maybe?.();\n", fakeSurfaces).length, 0);
});
