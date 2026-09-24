'use strict';

/**
 * Fidelity harness.
 *
 * Without this, "does the import look like the website?" is a human chore and
 * every tuning pass needs a person to describe what's wrong. With it, the loop
 * is measurable: import, export the frame, diff, look at the worst bands, fix,
 * repeat.
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* handled below */ }

async function toRgba(buffer, width, height) {
  if (!sharp) {
    const png = PNG.sync.read(buffer);
    if (png.width !== width || png.height !== height) {
      throw new Error('sharp is required to compare images of different sizes');
    }
    return png;
  }
  const raw = await sharp(buffer)
    .resize({ width, height, fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return { data: raw, width, height };
}

/**
 * @param {Buffer} referencePng  full-page browser screenshot
 * @param {Buffer} candidatePng  PNG exported from the built Figma frame
 * @param {string} outDir        where to write diff.png
 */
async function compare(referencePng, candidatePng, outDir, { threshold = 0.12, bands = 24 } = {}) {
  const refMeta = sharp ? await sharp(referencePng).metadata() : PNG.sync.read(referencePng);
  const width = Math.min(refMeta.width, 1600);
  const scale = width / refMeta.width;
  const height = Math.round(refMeta.height * scale);

  const a = await toRgba(referencePng, width, height);
  const b = await toRgba(candidatePng, width, height);

  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold,
    includeAA: false,
    alpha: 0.2
  });

  const total = width * height;
  const score = 1 - mismatched / total;

  // Horizontal bands localise the damage: "rows 3200–3600 are wrong" points
  // straight at a section instead of a whole page.
  const bandHeight = Math.ceil(height / bands);
  const bandScores = [];
  for (let bi = 0; bi < bands; bi++) {
    const y0 = bi * bandHeight;
    const y1 = Math.min(height, y0 + bandHeight);
    if (y0 >= y1) break;
    let bad = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        if (diff.data[idx] > 200 && diff.data[idx + 1] < 100) bad++; // pixelmatch marks diffs red
      }
    }
    const px = (y1 - y0) * width;
    bandScores.push({
      band: bi,
      // Report in the source page's coordinate space, not the scaled one.
      yStart: Math.round(y0 / scale),
      yEnd: Math.round(y1 / scale),
      mismatch: +(bad / px).toFixed(4)
    });
  }

  fs.mkdirSync(outDir, { recursive: true });
  const diffPath = path.join(outDir, 'diff.png');
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  fs.writeFileSync(path.join(outDir, 'figma.png'), candidatePng);

  const worst = bandScores.slice().sort((x, y) => y.mismatch - x.mismatch).slice(0, 5);

  return {
    score: +score.toFixed(4),
    mismatchedPixels: mismatched,
    comparedAt: { width, height },
    referenceSize: { width: refMeta.width, height: refMeta.height },
    worstRegions: worst,
    bands: bandScores,
    diffPath
  };
}

module.exports = { compare };
