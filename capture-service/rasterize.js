'use strict';

/**
 * Last-resort fidelity net.
 *
 * Some things cannot be rebuilt as Figma layers: a cross-origin <iframe> is
 * opaque to the serialiser, and an icon-font glyph only renders if that exact
 * font is installed locally, which it usually is not.
 *
 * But the full-page screenshot already contains all of it, correctly rendered.
 * So for those nodes we crop the screenshot at the node's own document
 * coordinates and hand Figma an image. Not editable — but present and correct,
 * which beats an empty placeholder or a tofu box.
 */

const { addRawAsset } = require('./assets');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* reported by the caller */ }

function collect(node, out) {
  if (!node) return;
  if (node.rasterize || (node.text && node.text.icon)) out.push(node);
  (node.children || []).forEach((c) => collect(c, out));
}

async function rasterizeFallbacks(doc, screenshotPng, manifest) {
  if (!sharp || !screenshotPng || !doc || !doc.root) return { count: 0, kinds: {} };

  const targets = [];
  collect(doc.root, targets);
  (doc.overlays || []).forEach((o) => collect(o, targets));
  if (!targets.length) return { count: 0, kinds: {} };

  const meta = await sharp(screenshotPng).metadata();
  const kinds = {};
  let count = 0;

  for (const n of targets) {
    const left = Math.max(0, Math.round(n.x));
    const top = Math.max(0, Math.round(n.y));
    const width = Math.min(Math.round(n.w), meta.width - left);
    const height = Math.min(Math.round(n.h), meta.height - top);
    if (!(width > 0) || !(height > 0) || left >= meta.width || top >= meta.height) continue;

    const kind = n.rasterize || 'icon';
    try {
      const bytes = await sharp(screenshotPng)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      const entry = addRawAsset(bytes, 'image/png', width, height, kind + ':' + (n.name || ''));

      n.type = 'IMAGE';
      n.name = kind === 'iframe' ? (n.name || 'iframe') : (n.name || 'icon');
      n.image = { assetId: entry.id, scaleMode: 'FILL', objectPosition: '50% 50%' };
      delete n.text;
      delete n.rasterize;
      n.children = [];

      manifest.push(entry);
      kinds[kind] = (kinds[kind] || 0) + 1;
      count++;
    } catch (e) { /* off-canvas or zero-area: leave the node as it was */ }
  }

  return { count, kinds };
}

module.exports = { rasterizeFallbacks };
