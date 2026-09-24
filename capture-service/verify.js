'use strict';

/**
 * End-to-end pipeline check that does not need Figma.
 *
 * POSTs to /capture for each URL at each width and reports the numbers that
 * actually indicate health: page height, node counts by kind, asset failures
 * and warnings. Comparing 1440 against 390 is the part that proves the site's
 * real mobile CSS ran, rather than a desktop layout scaled down.
 *
 *   node verify.js                    # both URLs, both widths
 *   node verify.js --url <u>          # one URL
 *   node verify.js --width 1440       # one width
 */

const SERVICE = process.env.SERVICE || 'http://localhost:3000';

const URLS = [
  'https://flock-site-beta.vercel.app',
  'https://flock-site-beta.vercel.app/discover'
];
const WIDTHS = [1440, 390];

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? null : process.argv[i + 1];
}

/** Walk the serialised tree once and pull out everything we report on. */
function inspect(doc) {
  const byType = {};
  let nodes = 0;
  let textChars = 0;
  let approx = 0;
  let maxX = 0;
  let depthMax = 0;

  (function walk(n, depth) {
    if (!n) return;
    nodes++;
    byType[n.type] = (byType[n.type] || 0) + 1;
    if (depth > depthMax) depthMax = depth;
    if (n.approx) approx++;
    const right = (n.x || 0) + (n.w || 0);
    if (right > maxX) maxX = right;
    if (n.type === 'TEXT' && n.text) {
      // text is either a string or an array of styled runs
      textChars += typeof n.text === 'string'
        ? n.text.length
        : (Array.isArray(n.text) ? n.text : [n.text])
            .reduce((a, r) => a + String(r && r.characters ? r.characters : '').length, 0);
    }
    (n.children || []).forEach((c) => walk(c, depth + 1));
  })(doc.root, 0);

  const sections = (doc.root.children || []).map((c) => ({
    name: c.name || c.tag || '?',
    y: Math.round(c.y || 0),
    h: Math.round(c.h || 0)
  }));

  return { nodes, byType, textChars, approx, maxX: Math.round(maxX), depthMax, sections };
}

async function capture(url, width) {
  const started = Date.now();
  const res = await fetch(SERVICE + '/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, width }),
    signal: AbortSignal.timeout(180000)
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  body.wallMs = Date.now() - started;
  return body;
}

function report(url, width, out) {
  const d = out.doc;
  const i = inspect(d);
  const failed = (out.assets && out.assets.failed) || [];
  const manifest = (out.assets && out.assets.manifest) || {};
  const warnings = d.warnings || [];

  console.log('');
  console.log('='.repeat(72));
  console.log(url + '   @ ' + width);
  console.log('='.repeat(72));
  console.log('  run                ' + out.runId + '   (' + (out.wallMs / 1000).toFixed(1) + 's wall)');
  console.log('  total page height  ' + Math.round(d.meta.height) + ' px');
  console.log('  node count         ' + i.nodes + '   (serializer reported ' + d.meta.nodeCount + ')');
  console.log('  TEXT nodes         ' + (i.byType.TEXT || 0) + '   (' + i.textChars + ' chars)');
  console.log('  IMAGE nodes        ' + (i.byType.IMAGE || 0));
  console.log('  FRAME nodes        ' + (i.byType.FRAME || 0));
  console.log('  SVG nodes          ' + (i.byType.SVG || 0));
  console.log('  max tree depth     ' + i.depthMax);
  console.log('  approx nodes       ' + i.approx + '   (pseudo-elements, geometry is a guess)');
  console.log('  assets resolved    ' + Object.keys(manifest).length);
  console.log('  assets FAILED      ' + failed.length + (failed.length ? '  <-- ' + JSON.stringify(failed.slice(0, 5)) : ''));
  console.log('  warnings           ' + (warnings.length || 'none'));
  warnings.forEach((w) => console.log('      - ' + w));
  console.log('  widest node edge   ' + i.maxX + ' px  (viewport ' + width + ')');
  console.log('  top-level sections ' + i.sections.length);
  i.sections.forEach((s, n) => {
    console.log('      ' + String(n).padStart(2) + '  y=' + String(s.y).padStart(6) + '  h=' + String(s.h).padStart(5) + '  ' + s.name.slice(0, 40));
  });

  return { width, height: Math.round(d.meta.height), i, failed: failed.length, warnings: warnings.length };
}

function compare(url, rows) {
  const desk = rows.find((r) => r.width === 1440);
  const mob = rows.find((r) => r.width === 390);
  if (!desk || !mob) return;

  console.log('');
  console.log('-'.repeat(72));
  console.log('RESPONSIVE CHECK  ' + url);
  console.log('-'.repeat(72));

  // If the service had merely scaled the desktop render down, mobile height
  // would land near desktop * (390/1440). Real mobile CSS reflows text and
  // stacks columns, so it lands nowhere near that.
  const naive = Math.round(desk.height * (390 / 1440));
  const ratio = (mob.height / desk.height).toFixed(2);

  console.log('  height   1440: ' + desk.height + '    390: ' + mob.height + '    ratio ' + ratio + 'x');
  console.log('  a scaled-down desktop would be ~' + naive + ' px at 390');
  console.log('  actual is ' + Math.abs(mob.height - naive) + ' px away from that  -> ' +
    (Math.abs(mob.height - naive) > naive * 0.25 ? 'REAL MOBILE CSS' : 'SUSPECT: looks scaled'));

  console.log('  sections 1440: ' + desk.i.sections.length + '    390: ' + mob.i.sections.length);
  console.log('  TEXT     1440: ' + (desk.i.byType.TEXT || 0) + '    390: ' + (mob.i.byType.TEXT || 0));
  console.log('  IMAGE    1440: ' + (desk.i.byType.IMAGE || 0) + '    390: ' + (mob.i.byType.IMAGE || 0));
  console.log('  nodes    1440: ' + desk.i.nodes + '    390: ' + mob.i.nodes);
  console.log('  widest   1440: ' + desk.i.maxX + '    390: ' + mob.i.maxX);

  // Section-by-section: same content, different y -> the layout genuinely reflowed.
  const shared = Math.min(desk.i.sections.length, mob.i.sections.length);
  let moved = 0;
  for (let n = 0; n < shared; n++) {
    if (desk.i.sections[n].h !== mob.i.sections[n].h) moved++;
  }
  console.log('  sections whose height changed: ' + moved + '/' + shared);
}

(async () => {
  const only = arg('url');
  const onlyW = arg('width');
  const urls = only ? [only] : URLS;
  const widths = onlyW ? [Number(onlyW)] : WIDTHS;

  const health = await fetch(SERVICE + '/health').then((r) => r.json()).catch(() => null);
  if (!health || !health.ok) {
    console.error('Capture service is not answering on ' + SERVICE + '. Start it with `npm start`.');
    process.exit(1);
  }
  console.log('service ok on ' + SERVICE);

  let failures = 0;
  for (const url of urls) {
    const rows = [];
    for (const width of widths) {
      try {
        rows.push(report(url, width, await capture(url, width)));
      } catch (e) {
        failures++;
        console.log('');
        console.log('FAILED  ' + url + ' @ ' + width + '  ->  ' + e.message);
      }
    }
    if (rows.length === 2) compare(url, rows);
  }

  console.log('');
  process.exit(failures ? 1 : 0);
})();
