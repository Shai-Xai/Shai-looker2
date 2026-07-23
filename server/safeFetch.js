// ─── SSRF-safe outbound fetch — shared library ────────────────────────────────
// For fetching USER-SUPPLIED URLs (Owl sheet/CSV uploads today). Plain fetch on
// a user URL is a read-SSRF: a client could point it at http://169.254.169.254/
// (cloud metadata) or an internal-only Render service and read the response back.
// This helper closes that:
//
//   • https only (http optional via allowHttp) — no file:, gopher:, etc.
//   • Resolves the host and REJECTS any private/loopback/link-local/reserved IP
//     (v4 and v6, including IPv4-mapped v6 and the 169.254.169.254 metadata IP).
//   • Pins the TCP connection to the validated address via a custom lookup, so a
//     DNS-rebind between check and connect can't swing it to an internal IP.
//   • Follows redirects MANUALLY, re-validating every hop (an external 302 →
//     internal target is a classic allow-list bypass).
//   • Hard timeout and streamed size cap (never buffer an unbounded body).
//   • Optional host allow-list (allowHosts) for callers that want to go further.
//
// Dependency-free (node http/https/dns/net). GET only — that's all the callers
// need; extend deliberately if that changes.

const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const net = require('net');

function ipIsPrivate(ip) {
  // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d) to the underlying v4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const fam = net.isIP(ip);
  if (fam === 4) {
    const p = ip.split('.').map(Number);
    if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → treat as unsafe
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;                 // this-network, private, loopback
    if (a === 169 && b === 254) return true;                            // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;                   // private
    if (a === 192 && b === 168) return true;                            // private
    if (a === 100 && b >= 64 && b <= 127) return true;                  // CGNAT
    if (a === 192 && b === 0) return true;                              // 192.0.0.0/24 (protocol assignments)
    if (a === 198 && (b === 18 || b === 19)) return true;              // benchmark
    if (a >= 224) return true;                                          // multicast + reserved (224-255)
    return false;
  }
  if (fam === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;                         // loopback / unspecified
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local fe80::/10
    if (v.startsWith('fc') || v.startsWith('fd')) return true;          // unique-local fc00::/7
    return false;
  }
  return true; // not a recognisable IP → refuse
}

async function assertPublicHost(hostname, allowHosts) {
  if (allowHosts && allowHosts.length && !allowHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
    throw new Error('URL host is not allowed');
  }
  // An IP literal in the URL never hits DNS — validate it directly.
  if (net.isIP(hostname)) {
    if (ipIsPrivate(hostname)) throw new Error('URL resolves to a non-public address');
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error('URL host did not resolve');
  for (const a of addrs) if (ipIsPrivate(a.address)) throw new Error('URL resolves to a non-public address');
}

// One request, no redirect following (caller loops). Resolves { status, headers,
// location, text() } — text() streams with the size cap.
function once(urlStr, { timeoutMs, maxBytes, allowHttp, allowHosts }) {
  const url = new URL(urlStr);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return Promise.reject(new Error('Only https URLs are allowed'));
  }
  const lib = url.protocol === 'https:' ? https : http;
  return assertPublicHost(url.hostname, allowHosts).then(() => new Promise((resolve, reject) => {
    const req = lib.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { Accept: 'text/csv, text/plain, */*', 'User-Agent': 'HowlerPulse/1.0' },
      timeout: timeoutMs,
      // Pin the connection to a freshly re-validated address (defeats DNS rebind
      // between assertPublicHost above and the actual connect).
      // Node ≥20 sockets (autoSelectFamily) call lookup with { all: true } and
      // expect an ARRAY of {address, family}; older callers expect (address,
      // family). Honour both — answering the wrong shape makes net see
      // `undefined` and die with "Invalid IP address: undefined".
      lookup(host, opts, cb) {
        dns.lookup(host, { all: true }).then((addrs) => {
          const ok = addrs.filter((a) => !ipIsPrivate(a.address));
          if (!ok.length) return cb(new Error('URL resolves to a non-public address'));
          if (opts && opts.all) return cb(null, ok);
          cb(null, ok[0].address, ok[0].family);
        }).catch(cb);
      },
    }, (res) => {
      resolve({
        status: res.statusCode,
        location: res.headers.location || '',
        text: () => new Promise((resolveText, rejectText) => {
          let buf = ''; let bytes = 0;
          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) { req.destroy(); res.destroy(); rejectText(new Error('Response is too large.')); return; }
            buf += chunk;
          });
          res.on('end', () => resolveText(buf));
          res.on('error', rejectText);
        }),
      });
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  }));
}

// Public: GET a user-supplied URL safely and return the body text.
async function safeGetText(urlStr, { timeoutMs = 15000, maxBytes = 6 * 1024 * 1024, allowHttp = false, allowHosts = null, maxRedirects = 3 } = {}) {
  let current = String(urlStr || '').trim();
  if (!current) throw new Error('No URL provided.');
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await once(current, { timeoutMs, maxBytes, allowHttp, allowHosts });
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, current).toString(); // re-validated on next once()
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`Fetch failed (${res.status})`);
    return res.text();
  }
  throw new Error('Too many redirects');
}

module.exports = { safeGetText, _ipIsPrivate: ipIsPrivate, _assertPublicHost: assertPublicHost };
