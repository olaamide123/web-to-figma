'use strict';

/**
 * Run artifacts for a self-hosted service.
 *
 * Vercel Blob used to back this and is gone. Every asset went through it,
 * costing one persistent write each, and on the free tier that capped the whole
 * service at roughly nineteen captures a month. Captures are now entirely
 * self-contained in the HTTP response, so the hosted deployment stores nothing
 * at all and cannot accrue storage cost.
 *
 * Run locally there is a real disk, so runs/ is still written: that is what
 * preview.js and the fidelity heatmaps read.
 */

const fs = require('fs');
const path = require('path');

const RUNS_DIR = path.join(__dirname, 'runs');
// No writable disk worth keeping on a serverless instance: /tmp is per
// invocation and vanishes.
const EPHEMERAL = !!process.env.VERCEL;

if (!EPHEMERAL) fs.mkdirSync(RUNS_DIR, { recursive: true });

async function put(key, bytes) {
  if (EPHEMERAL) return null;
  const dest = path.join(RUNS_DIR, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return null;
}

async function get(key) {
  if (EPHEMERAL) return null;
  const src = path.join(RUNS_DIR, key);
  return fs.existsSync(src) ? fs.readFileSync(src) : null;
}

function localPath(key) {
  if (EPHEMERAL) return require('os').tmpdir();
  const p = path.join(RUNS_DIR, key);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Drop runs older than maxAgeMs. Only ever has anything to do locally. */
async function sweep(maxAgeMs) {
  if (EPHEMERAL) return { deleted: 0, kept: 0, note: 'nothing is stored on this deployment' };
  const cutoff = Date.now() - maxAgeMs;
  let deleted = 0, kept = 0;
  for (const name of fs.readdirSync(RUNS_DIR)) {
    const dir = path.join(RUNS_DIR, name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) { fs.rmSync(dir, { recursive: true, force: true }); deleted++; }
      else kept++;
    } catch (e) { /* vanished under us */ }
  }
  return { deleted, kept };
}

module.exports = { put, get, localPath, sweep, EPHEMERAL, RUNS_DIR };
