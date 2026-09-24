'use strict';

/**
 * Anonymous install identity for a public, client-side plugin.
 *
 * A Figma plugin bundle is downloadable, so any secret shipped inside it is
 * public. The service therefore issues credentials instead of expecting one:
 * the plugin asks /register once, the server mints a token signed with a secret
 * that never leaves the server, and the plugin presents that token afterwards.
 *
 * This is not authentication — nothing proves the caller is the real plugin,
 * and an abuser can register again. What it buys is a stable per-install
 * handle to meter, and a credential that can be revoked or re-keyed without
 * shipping a new plugin version. The actual backstop against cost is the
 * per-install daily quota here plus per-IP rate limiting at the edge.
 */

const crypto = require('crypto');
const storage = require('./storage');

const SECRET = process.env.INSTALL_SIGNING_SECRET || '';
const DAILY_CAPTURES = Number(process.env.DAILY_CAPTURE_QUOTA || 60);
const DAILY_REGISTRATIONS_PER_IP = Number(process.env.DAILY_REGISTRATIONS_PER_IP || 25);

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  return b64(crypto.createHmac('sha256', SECRET).update(payload).digest());
}

/** A token is `installId.issuedAt.signature`; the id and date are readable, the signature is not forgeable. */
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
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload);
  // Constant-time: a timing oracle on an HMAC is how forgery starts.
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { installId: parts[0], issuedAt: parseInt(parts[1], 36) };
}

const today = () => new Date().toISOString().slice(0, 10);

async function bump(key, limit) {
  const path = `meter/${today()}/${key}.json`;
  let used = 0;
  try {
    const raw = await storage.get(path);
    if (raw) used = JSON.parse(raw.toString('utf8')).used || 0;
  } catch (e) { /* unreadable counter must not deny service */ }
  if (used >= limit) return { ok: false, used, limit };
  await storage.put(path, Buffer.from(JSON.stringify({ used: used + 1 })), 'application/json')
    .catch(() => {});
  return { ok: true, used: used + 1, limit };
}

const countCapture = (installId) => bump('install-' + installId, DAILY_CAPTURES);
const countRegistration = (ip) =>
  bump('ip-' + crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16),
       DAILY_REGISTRATIONS_PER_IP);

module.exports = {
  enabled: !!SECRET, mint, verify, countCapture, countRegistration,
  DAILY_CAPTURES, DAILY_REGISTRATIONS_PER_IP
};
