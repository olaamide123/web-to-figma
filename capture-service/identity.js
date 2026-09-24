'use strict';

/**
 * Anonymous install identity for a publicly distributed, client-side plugin.
 *
 * A plugin bundle is downloadable, so any secret shipped inside it is public.
 * The service issues one instead: /register mints a token signed with a key
 * that never leaves the server, and the plugin presents it afterwards.
 *
 * This is not authentication. Nothing proves the caller is the real plugin and
 * an abuser can register again. What it buys is a credential that can be
 * re-keyed without shipping a new plugin build, a cheap way to reject the
 * internet's background noise, and no extractable secret in the bundle.
 *
 * Per-install capture metering used to live here and is gone: enforcing it cost
 * a persistent write per capture, and that write was the single tightest limit
 * in the whole free tier. The real ceiling is the platform's own free
 * allowance, which stops the service rather than billing for it.
 */

const crypto = require('crypto');

const SECRET = process.env.INSTALL_SIGNING_SECRET || '';
const REGISTRATIONS_PER_IP_PER_HOUR = Number(process.env.REGISTRATIONS_PER_IP_PER_HOUR || 10);

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => b64(crypto.createHmac('sha256', SECRET).update(payload).digest());

/** `installId.issuedAt.signature` — the first two are readable, the third is not forgeable. */
function mint() {
  const installId = crypto.randomBytes(12).toString('hex');
  const issuedAt = Date.now().toString(36);
  const payload = `${installId}.${issuedAt}`;
  return { installId, token: `${payload}.${sign(payload)}` };
}

function verify(token) {
  if (!SECRET || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`);
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  // Constant-time: a timing oracle on an HMAC is where forgery starts.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { installId: parts[0], issuedAt: parseInt(parts[1], 36) };
}

/**
 * Registration throttle, held in the instance's own memory.
 *
 * Deliberately not backed by a store: persistence is what cost us the free
 * tier. A serverless instance is one of several and is recycled, so this slows
 * a naive loop rather than stopping a distributed one — the platform's DDoS
 * mitigation and its hard free ceiling are the real backstops. Registration is
 * also the cheap endpoint; /capture is the expensive one and needs a token.
 */
const seen = new Map();
function allowRegistration(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  if (seen.size > 5000) {
    for (const [k, v] of seen) if (now - v.start > hour) seen.delete(k);
  }
  const key = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
  const rec = seen.get(key);
  if (!rec || now - rec.start > hour) {
    seen.set(key, { start: now, count: 1 });
    return true;
  }
  rec.count++;
  return rec.count <= REGISTRATIONS_PER_IP_PER_HOUR;
}

module.exports = { enabled: !!SECRET, mint, verify, allowRegistration, REGISTRATIONS_PER_IP_PER_HOUR };
