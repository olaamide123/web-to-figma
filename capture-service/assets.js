'use strict';

const crypto = require('crypto');
const { assertFetchable } = require('./net-guard');

let sharp = null;
try { sharp = require('sharp'); } catch (e) {
  console.warn('[assets] sharp not installed — WebP/AVIF images will be skipped and large images left oversized.');
}

// Figma's createImage accepts PNG, JPEG and GIF only, with a 4096px cap on
// either axis. Modern sites (Next.js in particular) serve AVIF/WebP by default,
// so normalisation is not optional.
const FIGMA_MAX = 4096;
const RASTER_OK = new Set(['image/png', 'image/jpeg', 'image/gif']);

// An .svg loaded through <img> or background-image is an image as far as the
// page is concerned, and treating it as one is both simpler and more faithful:
// createNodeFromSvg rebuilds the artwork at the file's own intrinsic size, and
// a frame full of vectors cannot be resized to the layout box without cropping.
// Backgrounds had it worse — they carry no markup path at all, so an SVG
// background silently painted nothing. Render here instead, at twice the size
// the page actually shows it, and it lands as a normal image fill.
// Inline <svg> in the DOM still becomes real vectors; that path is untouched.
const SVG_RETINA = 2;

/** In-memory store: id -> { bytes, mime, width, height, kind, url } */
const store = new Map();

function idFor(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function decodeDataUrl(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] || 'text/plain';
  const body = m[3];
  const bytes = m[2] ? Buffer.from(decodeURIComponent(body), 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
  return { mime, bytes };
}

async function fetchBytes(url, referer) {
  if (url.startsWith('data:')) return decodeDataUrl(url);
  // The page picks its own asset URLs, so they are no more trustworthy than the
  // page URL itself.
  await assertFetchable(url);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      referer: referer || url
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  return { mime, bytes: buf };
}

/**
 * Render an SVG file to PNG at `display` size (CSS px) times SVG_RETINA, never
 * below its intrinsic size. Returns null if sharp can't read it, so the caller
 * can fall back to shipping the markup.
 */
async function rasterizeSvg(bytes, display) {
  if (!sharp) return null;
  try {
    const meta = await sharp(bytes).metadata();
    const iw = meta.width || 0;
    const ih = meta.height || 0;
    if (!iw || !ih) return null;

    const wanted = Math.max(iw, (display && display.w) || 0) * SVG_RETINA;
    // librsvg renders at density rather than upscaling pixels, so this stays
    // sharp. Never go below 1x, never past Figma's axis cap.
    const scale = Math.min(Math.max(wanted / iw, 1), FIGMA_MAX / Math.max(iw, ih));
    const out = await sharp(bytes, { density: Math.round(72 * scale) }).png({ compressionLevel: 8 }).toBuffer();
    const rendered = await sharp(out).metadata();
    return {
      kind: 'raster',
      mime: 'image/png',
      bytes: out,
      width: rendered.width || Math.round(iw * scale),
      height: rendered.height || Math.round(ih * scale)
    };
  } catch (e) {
    return null;
  }
}

async function normalize(mime, bytes, url, display) {
  const looksSvg = mime.includes('svg') || /\.svg(\?|$)/i.test(url) ||
    bytes.slice(0, 300).toString('utf8').trim().toLowerCase().startsWith('<svg');

  if (looksSvg) {
    const raster = await rasterizeSvg(bytes, display);
    if (raster) return raster;
    // No sharp, or artwork librsvg won't read — vectors are better than nothing.
    return { kind: 'svg', mime: 'image/svg+xml', bytes, text: bytes.toString('utf8') };
  }

  if (!sharp) {
    if (RASTER_OK.has(mime)) return { kind: 'raster', mime, bytes };
    throw new Error('unsupported format ' + mime + ' (install sharp to convert)');
  }

  // Animated GIFs must stay animated — Figma plays them. Decoding with
  // animated:false would silently flatten a resized GIF to its first frame.
  const isGif = mime === 'image/gif' || /\.gif(\?|$)/i.test(url);
  let img = sharp(bytes, { animated: isGif });
  const meta = await img.metadata();
  let width = meta.width || 0;
  let height = meta.height || 0;

  const needsResize = width > FIGMA_MAX || height > FIGMA_MAX;
  const needsConvert = !RASTER_OK.has(mime) || meta.format === 'webp' || meta.format === 'avif' || meta.format === 'svg';

  if (!needsResize && !needsConvert) {
    return { kind: 'raster', mime, bytes, width, height };
  }

  if (needsResize) {
    img = img.resize({
      width: width >= height ? FIGMA_MAX : undefined,
      height: height > width ? FIGMA_MAX : undefined,
      fit: 'inside',
      withoutEnlargement: true
    });
    const scale = FIGMA_MAX / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  // PNG keeps alpha; JPEG is smaller for photos. Choose on alpha presence.
  const out = isGif
    ? await img.gif().toBuffer()
    : meta.hasAlpha
      ? await img.png({ compressionLevel: 8 }).toBuffer()
      : await img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();

  return {
    kind: 'raster',
    mime: isGif ? 'image/gif' : meta.hasAlpha ? 'image/png' : 'image/jpeg',
    bytes: out,
    width,
    height
  };
}

/** url -> { w, h }: the largest box the document paints that asset into. */
function measureDisplays(doc) {
  const out = new Map();
  const note = (url, w, h) => {
    if (!url) return;
    const prev = out.get(url);
    if (!prev || w > prev.w) out.set(url, { w: w || 0, h: h || 0 });
  };
  (function walk(node) {
    if (!node) return;
    if (node.image && node.image.assetUrl) note(node.image.assetUrl, node.w, node.h);
    (node.fills || []).forEach((f) => {
      if (f && f.type === 'IMAGE' && f.assetUrl) note(f.assetUrl, node.w, node.h);
    });
    (node.children || []).forEach(walk);
  })(doc.root);
  (doc.overlays || []).forEach(function walk(n) {
    if (!n) return;
    if (n.image && n.image.assetUrl) note(n.image.assetUrl, n.w, n.h);
    (n.fills || []).forEach((f) => {
      if (f && f.type === 'IMAGE' && f.assetUrl) note(f.assetUrl, n.w, n.h);
    });
    (n.children || []).forEach(walk);
  });
  return out;
}

/**
 * Download every asset referenced by a captured document, normalise it, and
 * rewrite the document's assetUrl references to asset ids.
 *
 * Returns a manifest the plugin uses to pull bytes from /asset/:id.
 */
async function resolveAssets(doc, { concurrency = 8, onProgress } = {}) {
  const urls = doc.assets || [];
  const manifest = [];
  const failed = [];
  const urlToId = new Map();
  // The biggest box each asset is painted into, so vector files are rendered at
  // the resolution the page needs rather than whatever the file declares.
  const displays = measureDisplays(doc);

  let done = 0;
  const queue = urls.slice();

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      const id = idFor(url);
      try {
        if (!store.has(id)) {
          const fetched = await fetchBytes(url, doc.meta && doc.meta.url);
          if (!fetched) throw new Error('could not read');
          const norm = await normalize(fetched.mime, fetched.bytes, url, displays.get(url));
          store.set(id, { ...norm, url });
        }
        const entry = store.get(id);
        urlToId.set(url, id);
        // Everything the plugin needs travels in the capture response. There is
        // no second round trip and nothing is persisted: a storage round trip
        // per asset was what capped the free tier at ~19 captures a month.
        manifest.push({
          id,
          url,
          kind: entry.kind,
          mime: entry.mime,
          bytes: entry.bytes.length,
          width: entry.width || null,
          height: entry.height || null,
          svg: entry.kind === 'svg' ? entry.text : undefined,
          b64: entry.kind === 'svg' ? undefined : entry.bytes.toString('base64')
        });
      } catch (e) {
        failed.push({ url, error: String(e.message || e) });
      } finally {
        done++;
        if (onProgress) onProgress(done, urls.length);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, urls.length)) }, worker));

  // Rewrite references from URLs to ids so the plugin never touches the origin.
  (function rewrite(node) {
    if (!node) return;
    if (node.fills) {
      node.fills.forEach((f) => {
        if (f && f.type === 'IMAGE' && f.assetUrl) {
          f.assetId = urlToId.get(f.assetUrl) || null;
          delete f.assetUrl;
        }
      });
      node.fills = node.fills.filter((f) => !(f.type === 'IMAGE' && !f.assetId));
      if (!node.fills.length) delete node.fills;
    }
    if (node.image && node.image.assetUrl) {
      node.image.assetId = urlToId.get(node.image.assetUrl) || null;
      delete node.image.assetUrl;
    }
    (node.children || []).forEach(rewrite);
  })(doc.root);
  (doc.overlays || []).forEach(function walk(n) {
    if (!n) return;
    if (n.fills) {
      n.fills.forEach((f) => {
        if (f && f.type === 'IMAGE' && f.assetUrl) { f.assetId = urlToId.get(f.assetUrl) || null; delete f.assetUrl; }
      });
      n.fills = n.fills.filter((f) => !(f.type === 'IMAGE' && !f.assetId));
    }
    if (n.image && n.image.assetUrl) { n.image.assetId = urlToId.get(n.image.assetUrl) || null; delete n.image.assetUrl; }
    (n.children || []).forEach(walk);
  });

  delete doc.assets;
  return { manifest, failed };
}

function getAsset(id) {
  return store.get(id) || null;
}

/**
 * Register bytes we produced ourselves rather than downloaded — currently the
 * screenshot crops used for iframes and icon glyphs. Keyed by content hash, so
 * identical regions collapse to one asset.
 */
function addRawAsset(bytes, mime, width, height, label) {
  const id = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  if (!store.has(id)) {
    store.set(id, { kind: 'raster', mime, bytes, width, height, url: label || ('generated:' + id) });
  }
  return { id, url: label || ('generated:' + id), kind: 'raster', mime, bytes: bytes.length, width, height };
}

module.exports = { resolveAssets, getAsset, idFor, addRawAsset };
