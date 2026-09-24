'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const storage = require('./storage');
const { assertFetchable } = require('./net-guard');
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-capture-token, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  // /cleanup does its own check, because Vercel's cron cannot know the token.
  if (!ACCESS_TOKEN || req.path === '/health' || req.path === '/cleanup') return next();
  const sent = req.get('x-capture-token') || (req.get('authorization') || '').replace(/^Bearer /i, '');
  if (sent !== ACCESS_TOKEN) {
    return res.status(401).json({ error: 'Wrong or missing access token. Set it in the plugin under Capture settings.' });
  }
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, version: 1, hosted: storage.useBlob, auth: !!ACCESS_TOKEN }));

/**
 * GET /cleanup — delete captures older than RETENTION_DAYS.
 * Runs daily from Vercel Cron; also callable by hand with the access token.
 */
app.get('/cleanup', async (req, res) => {
  // Vercel signs its own cron requests, which will not carry the plugin token.
  const fromCron = !!req.get('x-vercel-cron') ||
    (process.env.CRON_SECRET && req.get('authorization') === `Bearer ${process.env.CRON_SECRET}`);
  if (ACCESS_TOKEN && !fromCron) {
    const sent = req.get('x-capture-token') || (req.get('authorization') || '').replace(/^Bearer /i, '');
    if (sent !== ACCESS_TOKEN) return res.status(401).json({ error: 'Not authorised.' });
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
