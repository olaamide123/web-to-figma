'use strict';

/**
 * Run artifacts and asset bytes, stored wherever this process happens to run.
 *
 * On a laptop that's the runs/ directory, same as it always was. On Vercel it
 * can't be: the filesystem is read-only apart from /tmp, and /tmp isn't shared
 * between invocations — so the capture that writes an asset and the request
 * that later fetches it are usually not the same machine. Blob is the shared
 * ground both of them can see.
 */

const fs = require('fs');
const path = require('path');

const RUNS_DIR = path.join(__dirname, 'runs');
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const useBlob = !!TOKEN;

let blob = null;
if (useBlob) blob = require('@vercel/blob');

if (!useBlob) fs.mkdirSync(RUNS_DIR, { recursive: true });

/**
 * Store bytes under a stable key and return a URL the plugin can fetch.
 * Locally that URL is served by this process; on Blob it is public and direct,
 * which keeps the capture response small enough to clear Vercel's 4.5MB cap.
 */
async function put(key, bytes, contentType) {
  if (!useBlob) {
    const dest = path.join(RUNS_DIR, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    return null; // local callers route through this service's own endpoints
  }
  const res = await blob.put(key, bytes, {
    access: 'public',
    contentType: contentType || 'application/octet-stream',
    token: TOKEN,
    // Deterministic pathnames, so a later request can rebuild the URL from a
    // runId alone instead of us having to remember a random one.
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 3600
  });
  return res.url;
}

async function get(key) {
  if (!useBlob) {
    const src = path.join(RUNS_DIR, key);
    return fs.existsSync(src) ? fs.readFileSync(src) : null;
  }
  try {
    const meta = await blob.head(key, { token: TOKEN });
    if (!meta || !meta.url) return null;
    const res = await fetch(meta.url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return null;
  }
}

function localPath(key) {
  return useBlob ? null : path.join(RUNS_DIR, key);
}

/**
 * Delete captures older than maxAgeMs.
 *
 * A capture is somebody's web page and every image on it, and there is no
 * reason to keep it once the import is done. Without this the store only ever
 * grows, and a privacy policy saying "we delete captures" would not be true.
 */
async function sweep(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;

  if (!useBlob) {
    let deleted = 0, kept = 0;
    for (const name of fs.readdirSync(RUNS_DIR)) {
      const dir = path.join(RUNS_DIR, name);
      try {
        if (fs.statSync(dir).mtimeMs < cutoff) { fs.rmSync(dir, { recursive: true, force: true }); deleted++; }
        else kept++;
      } catch (e) { /* vanished under us, or not ours to remove */ }
    }
    return { deleted, kept };
  }

  let cursor, deleted = 0, kept = 0;
  do {
    const page = await blob.list({ token: TOKEN, cursor, limit: 1000 });
    const stale = page.blobs.filter((b) => new Date(b.uploadedAt).getTime() < cutoff);
    if (stale.length) {
      await blob.del(stale.map((b) => b.url), { token: TOKEN });
      deleted += stale.length;
    }
    kept += page.blobs.length - stale.length;
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return { deleted, kept };
}

module.exports = { put, get, localPath, sweep, useBlob, RUNS_DIR };
