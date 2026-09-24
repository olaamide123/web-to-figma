'use strict';

/**
 * Visual test without Figma.
 *
 * Renders a captured document back to absolutely-positioned HTML using the same
 * geometry the plugin applies to Figma nodes — fixed width, auto height, the
 * emitted line-height — screenshots it, and pixel-diffs against the browser
 * screenshot from the same run.
 *
 * If the serialised text geometry is wrong, it is wrong here too, so this
 * catches text bugs without an import. It is a proxy, not Figma: it shares
 * Figma's text model (line box from the node's top edge) but not its shaper.
 *
 *   node preview.js https://example.com 1440
 *   node preview.js --run <runId>
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { compare } = require('./diff');

const SERVICE = process.env.SERVICE || 'http://localhost:3000';
const RUNS_DIR = path.join(__dirname, 'runs');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rgba(c) {
  if (!c || !c.color) return 'transparent';
  const r = Math.round(c.color.r * 255), g = Math.round(c.color.g * 255), b = Math.round(c.color.b * 255);
  return `rgba(${r},${g},${b},${c.opacity == null ? 1 : c.opacity})`;
}

/**
 * Read a Figma gradientTransform back out as CSS. The harness is worth nothing
 * for gradients otherwise — it used to draw every linear gradient at 180deg
 * regardless of the transform, so an angle bug diffed clean.
 *
 * Row 0 of the transform is [W*dx/L, H*dy/L, c], so the direction in pixels is
 * proportional to (a/W, b/H) and the CSS angle falls straight out of it.
 */
function gradientCss(f, w, h) {
  const stops = (f.gradientStops || []).map((s) =>
    `${rgba({ color: s.color, opacity: s.color && s.color.a != null ? s.color.a : 1 })} ${((s.position || 0) * 100).toFixed(2)}%`);
  if (!stops.length) return null;
  const T = f.gradientTransform;

  if (f.type === 'GRADIENT_LINEAR') {
    if (!T) return `linear-gradient(180deg,${stops.join(',')})`;
    const dx = T[0][0] / Math.max(1, w);
    const dy = T[0][1] / Math.max(1, h);
    const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    return `linear-gradient(${deg.toFixed(2)}deg,${stops.join(',')})`;
  }

  if (!T) return `radial-gradient(${stops.join(',')})`;
  const ax = T[0][0] !== 0 ? 1 / T[0][0] : 1;
  const ay = T[1][1] !== 0 ? 1 / T[1][1] : 1;
  const rx = ax / 2;
  const ry = ay / 2;
  const cx = rx - T[0][2] * ax;
  const cy = ry - T[1][2] * ay;
  return `radial-gradient(ellipse ${Math.abs(rx * 100).toFixed(2)}% ${Math.abs(ry * 100).toFixed(2)}%`
    + ` at ${(cx * 100).toFixed(2)}% ${(cy * 100).toFixed(2)}%,${stops.join(',')})`;
}

function background(fills, w, h) {
  if (!fills || !fills.length) return '';
  const layers = [];
  for (const f of fills) {
    if (f.type === 'SOLID') layers.push(`linear-gradient(${rgba(f)},${rgba(f)})`);
    else if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL') {
      const css = gradientCss(f, w, h);
      if (css) layers.push(css);
    }
  }
  // Figma paints fills bottom-up: fills[0] is underneath. CSS background-image
  // is the other way round — the first layer is on top. Emitting them in the
  // captured order painted the opaque background colour over every gradient,
  // which made the harness report a clean box and hide the very thing it exists
  // to check.
  return layers.length ? `background-image:${layers.reverse().join(',')};` : '';
}

function radius(r) {
  if (r == null) return '';
  if (typeof r === 'number') return `border-radius:${r}px;`;
  if (Array.isArray(r)) return `border-radius:${r.map((v) => v + 'px').join(' ')};`;
  return '';
}

function borders(b) {
  if (!b) return '';
  const side = (n, w, c) => (w ? `border-${n}:${w}px solid ${rgba(c)};` : '');
  if (Array.isArray(b)) return '';
  return side('top', b.top && b.top.width, b.top && b.top.color)
    + side('right', b.right && b.right.width, b.right && b.right.color)
    + side('bottom', b.bottom && b.bottom.width, b.bottom && b.bottom.color)
    + side('left', b.left && b.left.width, b.left && b.left.color);
}

function shadows(list) {
  if (!list || !list.length) return '';
  const parts = list.map((s) =>
    `${s.offset ? s.offset.x : 0}px ${s.offset ? s.offset.y : 0}px ${s.radius || 0}px ${rgba(s)}`);
  return `box-shadow:${parts.join(',')};`;
}

/** Mirrors buildText in the plugin: fixed width, auto height, explicit line-height. */
function textStyle(t) {
  // single quotes only — a double quote would close the style=" attribute
  const fam = (t.families || []).map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(',');
  let s = `font-family:${fam || 'sans-serif'};font-size:${t.size}px;font-weight:${t.weight || 400};`;
  s += `line-height:${t.lineHeight ? t.lineHeight + 'px' : 'normal'};`;
  s += `letter-spacing:${t.letterSpacing || 0}px;`;
  s += `color:${rgba(t.color)};`;
  if (t.italic) s += 'font-style:italic;';
  if (t.align === 'CENTER') s += 'text-align:center;';
  else if (t.align === 'RIGHT') s += 'text-align:right;';
  else if (t.align === 'JUSTIFIED') s += 'text-align:justify;';
  if (t.case === 'UPPER') s += 'text-transform:uppercase;';
  else if (t.case === 'LOWER') s += 'text-transform:lowercase;';
  else if (t.case === 'TITLE') s += 'text-transform:capitalize;';
  if (t.decoration === 'UNDERLINE') s += 'text-decoration:underline;';
  else if (t.decoration === 'STRIKETHROUGH') s += 'text-decoration:line-through;';
  return s;
}

function render(node, parent) {
  if (!node) return '';
  // Children are absolute against the document, so subtract the parent origin.
  const x = node.x - (parent ? parent.x : 0);
  const y = node.y - (parent ? parent.y : 0);
  let box = `position:absolute;left:${x}px;top:${y}px;`;
  if (node.opacity != null && node.opacity !== 1) box += `opacity:${node.opacity};`;
  if (node.clip) box += 'overflow:hidden;';

  const kids = (node.children || []).map((c) => render(c, node)).join('');

  if (node.type === 'TEXT') {
    // width fixed, height auto — exactly what textAutoResize:'HEIGHT' does
    return `<div style="${box}width:${node.w}px;${textStyle(node.text)}white-space:pre-wrap;">`
      + esc(node.text.characters) + '</div>';
  }
  if (node.type === 'IMAGE') {
    const a = node.image || {};
    const fit = a.scaleMode === 'FIT' ? 'contain' : 'cover';
    box += `width:${node.w}px;height:${node.h}px;${radius(node.radius)}${shadows(node.shadows)}`;
    const src = a.assetId ? `${SERVICE}/asset/${a.assetId}` : '';
    return `<div style="${box}">`
      + (src ? `<img src="${src}" style="width:100%;height:100%;object-fit:${fit};object-position:${a.objectPosition || '50% 50%'};display:block;">` : '')
      + kids + '</div>';
  }
  if (node.type === 'SVG') {
    box += `width:${node.w}px;height:${node.h}px;`;
    return `<div style="${box}">${node.svg || ''}</div>`;
  }
  box += `width:${node.w}px;height:${node.h}px;${background(node.fills, node.w, node.h)}${radius(node.radius)}${borders(node.borders)}${shadows(node.shadows)}`;
  return `<div style="${box}">${kids}</div>`;
}

function toHtml(doc) {
  const root = doc.root;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{background:#fff;}
    body{position:relative;width:${root.w}px;height:${root.h}px;}
  </style></head><body>${render(root, null)}</body></html>`;
}

async function main() {
  let runId = null, doc = null;
  const runFlag = process.argv.indexOf('--run');

  if (runFlag !== -1) {
    runId = process.argv[runFlag + 1];
    doc = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, runId, 'document.json'), 'utf8'));
  } else {
    const url = process.argv[2];
    const width = Number(process.argv[3] || 1440);
    const rootSelector = process.argv[4] || '';
    if (!url) { console.error('usage: node preview.js <url> [width]   |   node preview.js --run <runId>'); process.exit(1); }
    console.log(`capturing ${url} @ ${width} …`);
    const res = await fetch(SERVICE + '/capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, width, rootSelector, captureStates: false }), signal: AbortSignal.timeout(280000)
    });
    const body = await res.json();
    if (!res.ok) { console.error('capture failed:', body.error); process.exit(1); }
    runId = body.runId;
    doc = body.doc;
  }

  const runDir = path.join(RUNS_DIR, runId);
  const html = toHtml(doc);
  fs.writeFileSync(path.join(runDir, 'preview.html'), html);

  console.log('rendering the serialised document …');
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars'] });
  const page = await browser.newPage({ viewport: { width: Math.round(doc.root.w), height: 900 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(400);
  const shot = await page.screenshot({ fullPage: true, type: 'png', scale: 'css' });
  await browser.close();
  fs.writeFileSync(path.join(runDir, 'preview.png'), shot);

  const refPath = path.join(runDir, 'reference.png');
  if (!fs.existsSync(refPath)) { console.log('no reference.png for this run — wrote preview.png only'); return; }

  const result = await compare(fs.readFileSync(refPath), shot, runDir);
  console.log('');
  console.log(`${(result.score * 100).toFixed(1)}%   serialised document vs the live page`);
  (result.worstRegions || []).slice(0, 8).forEach((r) => {
    console.log(`  y ${r.yStart}–${r.yEnd}    ${(r.mismatch * 100).toFixed(1)}% off`);
  });
  console.log('');
  console.log('  ' + path.join(runDir, 'preview.png') + '   what the captured data actually looks like');
  console.log('  ' + path.join(runDir, 'diff.png') + '      red = mismatch');
}

main().catch((e) => { console.error(e); process.exit(1); });
