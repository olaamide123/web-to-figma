'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const storage = require('./storage');
const { assertFetchable } = require('./net-guard');
const identity = require('./identity');
const { capture, closeBrowser, discoverLinks } = require('./capture');
const { resolveAssets, getAsset } = require('./assets');
const { compare } = require('./diff');
const { rasterizeFallbacks } = require('./rasterize');

const PORT = process.env.PORT || 3000;
const RUNS_DIR = storage.RUNS_DIR;
// A public capture service is an open URL fetcher, so when one is deployed it
// gets a shared secret. Unset (i.e. on a laptop) the check is skipped entirely.
const ACCESS_TOKEN = process.env.CAPTURE_TOKEN || '';

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/diff-body', express.raw({ type: '*/*', limit: '64mb' }));

// The plugin UI runs in a null-origin iframe, so allow everything. This service
// is meant to run on localhost only — do not expose it to the internet.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // x-capture-token has to be listed or the browser's preflight rejects every
  // authenticated call before it is sent — which reads as "Failed to fetch".
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-capture-token, x-w2f-install, Authorization');
  // So the client can show how much of today's allowance is left.
  res.setHeader('Access-Control-Expose-Headers', 'x-w2f-quota-remaining');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const OPEN_PATHS = new Set(['/health', '/cleanup', '/register']);

/** Does this request carry the operator's own token? Self-hosters use this. */
function hasOperatorToken(req) {
  if (!ACCESS_TOKEN) return false;
  const sent = req.get('x-capture-token') || (req.get('authorization') || '').replace(/^Bearer /i, '');
  if (sent.length !== ACCESS_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(ACCESS_TOKEN));
}

app.use(async (req, res, next) => {
  // /cleanup and /register do their own checks; /health is public.
  if (OPEN_PATHS.has(req.path)) return next();

  // An operator token, when one is configured, is the self-host escape hatch:
  // full access, no metering, nothing to register.
  if (hasOperatorToken(req)) { req.metered = false; return next(); }

  // Otherwise the caller must present an install token this server issued.
  // Nothing secret ships in the plugin; it earns this on first run.
  if (identity.enabled) {
    const claim = identity.verify(req.get('x-w2f-install'));
    if (!claim) {
      return res.status(401).json({
        error: 'This plugin install is not registered yet. Reopen the plugin to set it up.',
        code: 'REGISTER_REQUIRED'
      });
    }
    req.installId = claim.installId;
    req.metered = true;
    return next();
  }

  // No signing secret and no operator token: a private/local deployment.
  if (ACCESS_TOKEN) {
    return res.status(401).json({ error: 'Wrong or missing access token.' });
  }
  next();
});

/**
 * POST /register -> { token }
 * Anonymous. Rate limited per IP so tokens cannot be minted without bound.
 */
app.post('/register', async (req, res) => {
  if (!identity.enabled) {
    return res.status(501).json({ error: 'This deployment does not issue install tokens.' });
  }
  const ip = (req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
  const quota = await identity.countRegistration(ip);
  if (!quota.ok) {
    return res.status(429).json({ error: 'Too many new installs from this network today. Try again tomorrow.' });
  }
  const { token, installId } = identity.mint();
  console.log('[register]', installId);
  res.json({ token, dailyCaptureQuota: identity.DAILY_CAPTURES });
});

app.get('/health', (req, res) => res.json({
  ok: true, version: 2, hosted: storage.useBlob,
  // What a client needs to know before its first call.
  publicAccess: identity.enabled, operatorToken: !!ACCESS_TOKEN,
  dailyCaptureQuota: identity.enabled ? identity.DAILY_CAPTURES : null
}));

/**
 * GET /cleanup — delete captures older than RETENTION_DAYS.
 * Runs daily from Vercel Cron; also callable by hand with the access token.
 */
app.get('/cleanup', async (req, res) => {
  // Vercel signs its own cron requests, which will not carry the plugin token.
  const fromCron = !!req.get('x-vercel-cron') ||
    (process.env.CRON_SECRET && req.get('authorization') === `Bearer ${process.env.CRON_SECRET}`);
  // Deny by default. Gating this on ACCESS_TOKEN being set meant that dropping
  // the token to open the service to plugin users also left a destructive
  // endpoint unauthenticated — anyone could have wiped every stored capture.
  if (!fromCron && !hasOperatorToken(req)) {
    return res.status(401).json({ error: 'Not authorised.' });
  }
  const days = Number(process.env.RETENTION_DAYS || 7);
  try {
    const result = await storage.sweep(days * 24 * 60 * 60 * 1000);
    console.log('[cleanup]', JSON.stringify(result), 'olderThanDays=' + days);
    res.json({ ...result, olderThanDays: days });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

/**
 * POST /capture
 * { url, width, dismissSelectors?, maxNodes? }
 * → { runId, doc, assets: { manifest, failed }, timings }
 */
app.post('/capture', async (req, res) => {
  const started = Date.now();
  const { url, width, dismissSelectors, maxNodes, captureStates, stateSelectors, rootSelector } = req.body || {};

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Enter a URL starting with http:// or https://' });
  }
  if (!width || width < 200 || width > 4000) {
    return res.status(400).json({ error: 'Viewport width must be between 200 and 4000.' });
  }
  // Deployed, this endpoint is a stranger's way of making our machine fetch
  // things. Locally it is switched off, so capturing your own dev server works.
  try {
    await assertFetchable(url);
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }

  // Metered only for anonymous public installs; a self-hoster with the
  // operator token is spending their own money and is not counted.
  if (req.metered && req.installId) {
    const quota = await identity.countCapture(req.installId);
    if (!quota.ok) {
      return res.status(429).json({
        error: `Daily limit of ${quota.limit} captures reached for this install. `
             + 'It resets at midnight UTC — or run your own capture service for no limit.',
        code: 'QUOTA_EXCEEDED'
      });
    }
    res.setHeader('x-w2f-quota-remaining', String(quota.limit - quota.used));
  }

  const runId = crypto.randomBytes(6).toString('hex');
  const runDir = path.join(RUNS_DIR, runId);

  try {
    const t0 = Date.now();
    const { doc, screenshot } = await capture({
      url, width, dismissSelectors, maxNodes,
      captureStates: captureStates !== false,
      stateSelectors: Array.isArray(stateSelectors) ? stateSelectors : [],
      rootSelector: typeof rootSelector === 'string' ? rootSelector.trim() : ''
    });
    const tCapture = Date.now() - t0;

    const t1 = Date.now();
    const assets = await resolveAssets(doc);
    // Anything that could not be rebuilt as layers gets cropped out of the
    // screenshot instead — iframes and icon-font glyphs.
    const raster = await rasterizeFallbacks(doc, screenshot, assets.manifest);
    if (raster.count) console.log('[raster]', runId, JSON.stringify(raster.kinds));
    const tAssets = Date.now() - t1;

    if (screenshot) await storage.put(`${runId}/reference.png`, screenshot, 'image/png');
    const docJson = JSON.stringify(doc);
    const docUrl = await storage.put(`${runId}/document.json`, Buffer.from(docJson), 'application/json');

    const body = {
      runId,
      assets,
      rasterized: raster,
      timings: { captureMs: tCapture, assetsMs: tAssets, totalMs: Date.now() - started }
    };
    // A serialised page runs to megabytes and Vercel caps a response at 4.5MB,
    // so hosted captures hand back a URL and the plugin pulls the document from
    // storage directly. Locally there is no cap and no second hop worth paying.
    if (docUrl) body.docUrl = docUrl;
    else body.doc = doc;
    res.json(body);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    console.error('[capture]', message);
    res.status(500).json({
      error: message.includes('net::ERR_NAME_NOT_RESOLVED')
        ? 'That domain could not be reached. Check the URL.'
        : message.includes('net::ERR_CONNECTION_REFUSED')
        ? 'Nothing is serving that address. If it is a local dev server, is it running?'
        // capture.js now says which URL and for how long, so pass it through
        // rather than replacing it with something vaguer.
        : message
    });
  }
});

/**
 * POST /discover-links { url, limit? } → { links: [...] }
 * Same-origin pages linked from the given URL, for queueing a whole site.
 */
app.post('/discover-links', async (req, res) => {
  const { url, limit } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Enter a URL starting with http:// or https://' });
  }
  try {
    await assertFetchable(url);
    const links = await discoverLinks({ url, limit: Math.min(Math.max(1, limit || 60), 200) });
    res.json({ links, count: links.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** GET /asset/:id → raw image bytes */
app.get('/asset/:id', (req, res) => {
  const entry = getAsset(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Asset not found. Re-run the capture.' });
  res.setHeader('Content-Type', entry.mime);
  res.setHeader('Cache-Control', 'no-store');
  res.send(entry.bytes);
});

/** GET /run/:runId/reference.png → the browser screenshot for that run */
app.get('/run/:runId/reference.png', async (req, res) => {
  const bytes = await storage.get(`${req.params.runId}/reference.png`);
  if (!bytes) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.send(bytes);
});

/**
 * POST /diff/:runId  (body: raw PNG exported from the built Figma frame)
 * → { score, worstRegions, ... }
 */
app.post('/diff/:runId', express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  const runId = req.params.runId;
  const reference = await storage.get(`${runId}/reference.png`);
  if (!reference) {
    return res.status(404).json({ error: 'No reference screenshot for that run.' });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'No PNG received.' });
  }
  try {
    // compare() writes its heatmap beside the run; hosted, /tmp is the only
    // writable place and it is per-invocation, which is fine — the score comes
    // back in the response and the PNG is a local debugging aid.
    const runDir = storage.localPath(runId) || require('os').tmpdir();
    const result = await compare(reference, req.body, runDir);
    await storage.put(`${runId}/diff.json`, Buffer.from(JSON.stringify(result, null, 2)), 'application/json');
    console.log(`[diff] ${runId} score=${(result.score * 100).toFixed(1)}%`);
    res.json({ ...result, runDir });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Started directly it is a long-lived server; required by api/index.js it is
// just an Express app that Vercel drives per request.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`web-to-figma capture service listening on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    console.log('\nShutting down…');
    server.close();
    await closeBrowser();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = app;
