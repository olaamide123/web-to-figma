/* eslint-disable no-undef */
'use strict';

/**
 * Web to Figma — main thread.
 *
 * The UI iframe does all the networking (fetching the serialised document and
 * the image bytes) and hands the result over here. This file's only job is to
 * turn that document into editable Figma nodes.
 */

figma.showUI(__html__, { width: 360, height: 520, themeColors: true });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const assetBytes = new Map();   // assetId -> Uint8Array
const assetSvg = new Map();     // assetId -> svg string
const imageHashes = new Map();  // assetId -> Figma image hash
const builtFrames = [];         // { id, label, runId }

let fontIndex = null;           // family -> Set(styles)
const fontCache = new Map();    // "family|weight|italic" -> FontName
const substitutions = new Map();

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------
const GENERIC = {
  'sans-serif': 'Inter',
  'ui-sans-serif': 'Inter',
  'system-ui': 'Inter',
  '-apple-system': 'Inter',
  'blinkmacsystemfont': 'Inter',
  'segoe ui': 'Inter',
  'helvetica neue': 'Inter',
  serif: 'Georgia',
  'ui-serif': 'Georgia',
  monospace: 'Roboto Mono',
  'ui-monospace': 'Roboto Mono',
  cursive: 'Inter',
  fantasy: 'Inter',
  'apple color emoji': 'Inter',
  'segoe ui emoji': 'Inter'
};

const WEIGHT_STYLES = {
  100: ['Thin', 'Hairline', 'ExtraLight', 'Extra Light', 'Light'],
  200: ['ExtraLight', 'Extra Light', 'UltraLight', 'Ultra Light', 'Thin', 'Light'],
  300: ['Light', 'Book', 'Regular'],
  400: ['Regular', 'Normal', 'Book', 'Roman', 'Medium'],
  500: ['Medium', 'Regular', 'Book'],
  600: ['SemiBold', 'Semi Bold', 'DemiBold', 'Demi Bold', 'Demi', 'Bold', 'Medium'],
  700: ['Bold', 'SemiBold', 'Semi Bold', 'Black', 'Heavy'],
  800: ['ExtraBold', 'Extra Bold', 'UltraBold', 'Ultra Bold', 'Black', 'Bold'],
  900: ['Black', 'Heavy', 'ExtraBlack', 'ExtraBold', 'Extra Bold', 'Bold']
};

function snapWeight(w) {
  const steps = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  let best = 400;
  let bestDelta = Infinity;
  for (const s of steps) {
    const d = Math.abs(s - w);
    if (d < bestDelta) { bestDelta = d; best = s; }
  }
  return best;
}

async function buildFontIndex() {
  if (fontIndex) return fontIndex;
  const all = await figma.listAvailableFontsAsync();
  fontIndex = new Map();
  for (const f of all) {
    const fam = f.fontName.family;
    if (!fontIndex.has(fam)) fontIndex.set(fam, new Set());
    fontIndex.get(fam).add(f.fontName.style);
  }
  return fontIndex;
}

function findStyle(family, weight, italic) {
  const styles = fontIndex.get(family);
  if (!styles) return null;
  const candidates = WEIGHT_STYLES[snapWeight(weight)] || ['Regular'];

  if (italic) {
    for (const c of candidates) {
      const withItalic = c === 'Regular' ? 'Italic' : `${c} Italic`;
      if (styles.has(withItalic)) return withItalic;
    }
    // Italic missing entirely — fall through to upright rather than failing.
  }
  for (const c of candidates) {
    if (styles.has(c)) return c;
  }
  // Last resort: anything the family offers.
  const any = Array.from(styles);
  return any.includes('Regular') ? 'Regular' : any[0] || null;
}

/**
 * Resolve a CSS font stack to a real Figma font, recording any substitution so
 * the UI can report it instead of silently changing the design.
 */
async function resolveFont(families, weight, italic) {
  const key = `${(families || []).join(',')}|${weight}|${italic ? 1 : 0}`;
  if (fontCache.has(key)) return fontCache.get(key);

  await buildFontIndex();
  const stack = (families && families.length ? families : ['Inter']).slice();

  let chosen = null;
  let requested = stack[0] || 'Inter';

  for (const raw of stack) {
    const name = raw.trim();
    const generic = GENERIC[name.toLowerCase()];
    const family = fontIndex.has(name) ? name : (generic && fontIndex.has(generic) ? generic : null);
    if (!family) continue;
    const style = findStyle(family, weight, italic);
    if (style) { chosen = { family, style }; break; }
  }

  if (!chosen) {
    const fallbackFamily = fontIndex.has('Inter') ? 'Inter' : Array.from(fontIndex.keys())[0];
    chosen = { family: fallbackFamily, style: findStyle(fallbackFamily, weight, italic) || 'Regular' };
  }

  if (chosen.family !== requested) {
    substitutions.set(`${requested} ${weight}${italic ? ' italic' : ''}`, `${chosen.family} ${chosen.style}`);
  }

  try {
    await figma.loadFontAsync(chosen);
  } catch (e) {
    chosen = { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(chosen);
  }

  fontCache.set(key, chosen);
  return chosen;
}

async function preloadFonts(doc) {
  const list = doc.fonts || [];
  for (const f of list) {
    await resolveFont(f.families, f.weight, f.italic);
  }
}

// ---------------------------------------------------------------------------
// Paint helpers
// ---------------------------------------------------------------------------
async function imageHashFor(assetId) {
  if (!assetId) return null;
  if (imageHashes.has(assetId)) return imageHashes.get(assetId);
  const bytes = assetBytes.get(assetId);
  if (!bytes) return null;
  try {
    const image = figma.createImage(bytes);
    imageHashes.set(assetId, image.hash);
    return image.hash;
  } catch (e) {
    console.warn('createImage failed for', assetId, e.message);
    imageHashes.set(assetId, null);
    return null;
  }
}

async function toPaints(fills) {
  if (!fills || !fills.length) return [];
  const out = [];
  for (const f of fills) {
    if (!f) continue;
    if (f.type === 'SOLID') {
      out.push({ type: 'SOLID', color: f.color, opacity: f.opacity === undefined ? 1 : f.opacity });
    } else if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL' || f.type === 'GRADIENT_ANGULAR') {
      out.push({
        type: f.type,
        gradientTransform: f.gradientTransform,
        gradientStops: f.gradientStops
      });
    } else if (f.type === 'IMAGE') {
      const hash = await imageHashFor(f.assetId);
      if (hash) {
        out.push({
          type: 'IMAGE',
          imageHash: hash,
          scaleMode: f.scaleMode === 'TILE' ? 'TILE' : (f.scaleMode || 'FILL'),
          scalingFactor: f.scaleMode === 'TILE' ? 0.5 : undefined
        });
      }
    }
  }
  return out.filter(Boolean);
}

function applyBorders(node, borders) {
  if (!borders) return;
  const sides = ['top', 'right', 'bottom', 'left'];
  const present = sides.filter((s) => borders[s]);
  if (!present.length) return;

  const first = borders[present[0]];
  node.strokes = [{
    type: 'SOLID',
    color: { r: first.color.r, g: first.color.g, b: first.color.b },
    opacity: first.color.a
  }];
  node.strokeAlign = 'INSIDE';

  const weights = present.map((s) => borders[s].weight);
  const uniform = present.length === 4 && weights.every((w) => Math.abs(w - weights[0]) < 0.01);

  if (uniform) {
    node.strokeWeight = Math.max(0.5, weights[0]);
  } else if ('strokeTopWeight' in node) {
    node.strokeTopWeight = borders.top ? Math.max(0.5, borders.top.weight) : 0;
    node.strokeRightWeight = borders.right ? Math.max(0.5, borders.right.weight) : 0;
    node.strokeBottomWeight = borders.bottom ? Math.max(0.5, borders.bottom.weight) : 0;
    node.strokeLeftWeight = borders.left ? Math.max(0.5, borders.left.weight) : 0;
  } else {
    node.strokeWeight = Math.max(0.5, weights[0]);
  }

  const style = first.style;
  if (style === 'dashed') node.dashPattern = [6, 4];
  else if (style === 'dotted') node.dashPattern = [1, 3];
}

function applyRadius(node, radius) {
  if (!radius) return;
  const [tl, tr, br, bl] = radius;
  if ('topLeftRadius' in node) {
    node.topLeftRadius = tl || 0;
    node.topRightRadius = tr || 0;
    node.bottomRightRadius = br || 0;
    node.bottomLeftRadius = bl || 0;
  } else if ('cornerRadius' in node) {
    node.cornerRadius = tl || 0;
  }
}

/**
 * Shadows, layer blur and background blur all live in the same effects array,
 * so they have to be applied together — assigning one would drop the others.
 */
function applyEffects(node, spec) {
  // text-shadow rides inside the text payload; box-shadow sits on the node.
  const shadows = spec.shadows || (spec.text && spec.text.shadows) || [];
  const effects = shadows.map((s) => ({
    type: s.type,
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    offset: { x: s.offset.x, y: s.offset.y },
    radius: Math.max(0, s.radius),
    spread: s.spread || 0,
    visible: true,
    blendMode: 'NORMAL'
  }));

  // CSS filter: blur() -> layer blur; backdrop-filter: blur() -> background
  // blur, which is what frosted-glass panels are actually made of.
  if (spec.blur > 0) effects.push({ type: 'LAYER_BLUR', radius: spec.blur, visible: true });
  if (spec.backdropBlur > 0) effects.push({ type: 'BACKGROUND_BLUR', radius: spec.backdropBlur, visible: true });

  if (!effects.length) return;
  try { node.effects = effects; } catch (e) { /* some node types reject spread */ }
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------
let nodesBuilt = 0;

async function yieldOccasionally() {
  if (++nodesBuilt % 250 === 0) {
    figma.ui.postMessage({ type: 'node-progress', count: nodesBuilt });
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function buildText(spec) {
  const t = spec.text;
  const base = await resolveFont(t.families, t.weight, t.italic);

  const node = figma.createText();
  node.fontName = base;
  node.characters = t.characters;

  node.fontSize = Math.max(1, t.size || 16);
  node.textAlignHorizontal = t.align || 'LEFT';
  node.textAlignVertical = 'TOP';
  node.textCase = t.case || 'ORIGINAL';
  node.textDecoration = t.decoration || 'NONE';
  node.letterSpacing = { value: t.letterSpacing || 0, unit: 'PIXELS' };
  node.lineHeight = t.lineHeight
    ? { value: t.lineHeight, unit: 'PIXELS' }
    : { unit: 'AUTO' };
  node.fills = [t.color];

  // Styled runs: keep the accent-coloured span inside a heading.
  if (t.runs && t.runs.length > 1) {
    for (const run of t.runs) {
      const start = Math.max(0, Math.min(run.start, node.characters.length));
      const end = Math.max(start, Math.min(run.end, node.characters.length));
      if (end <= start) continue;
      try {
        const f = await resolveFont(run.families, run.weight, run.italic);
        node.setRangeFontName(start, end, f);
        if (run.color) node.setRangeFills(start, end, [run.color]);
        if (run.size) node.setRangeFontSize(start, end, run.size);
        if (run.decoration && run.decoration !== 'NONE') node.setRangeTextDecoration(start, end, run.decoration);
      } catch (e) { /* run boundaries can drift on odd whitespace; skip */ }
    }
  }

  // Text the browser kept on one line must never wrap here. Figma's shaper is
  // not Chromium's — tracking especially, since CSS adds letter-spacing after
  // the final character and Figma does not — so a box sized to the measured
  // width has no slack and a few pixels of disagreement break the line. Let the
  // node size to its own content instead, then re-anchor it: only the alignment
  // edge is fixed in the original layout.
  if ((t.lines || 1) <= 1) {
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
    const align = t.align || 'LEFT';
    if (align === 'CENTER') spec.__dx = (spec.w - node.width) / 2;
    else if (align === 'RIGHT') spec.__dx = spec.w - node.width;
    else spec.__dx = 0;
  } else {
    // Multi-line: the fixed width is what reproduces the browser's line breaks.
    node.textAutoResize = 'HEIGHT';
    node.resize(Math.max(1, spec.w), Math.max(1, spec.h));

    // A line can still break early and push the block taller. Nudge the width
    // up a little and retry before giving up.
    if (spec.h > 0) {
      let attempts = 0;
      while (node.height > spec.h * 1.25 && attempts < 3) {
        node.resize(node.width + Math.max(2, node.width * 0.03), node.height);
        attempts++;
      }
      if (node.height > spec.h * 1.5) {
        figma.ui.postMessage({
          type: 'fidelity-note',
          note: `Text re-wrapped taller than the browser: "${t.characters.slice(0, 40)}"`
        });
      }
    }
  }

  node.name = spec.name || t.characters.slice(0, 40) || 'Text';
  return node;
}

async function buildImage(spec) {
  const asset = spec.image || {};
  if (asset.assetId && assetSvg.has(asset.assetId)) {
    return buildSvg({ ...spec, svg: assetSvg.get(asset.assetId) });
  }
  const rect = figma.createRectangle();
  rect.resize(Math.max(1, spec.w), Math.max(1, spec.h));
  const hash = await imageHashFor(asset.assetId);
  if (hash) {
    rect.fills = [{
      type: 'IMAGE',
      imageHash: hash,
      scaleMode: asset.scaleMode === 'FIT' ? 'FIT' : asset.scaleMode === 'CROP' ? 'CROP' : 'FILL'
    }];
  } else {
    rect.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.92 }, opacity: 1 }];
    rect.name = (spec.name || 'Image') + ' (missing)';
  }
  applyRadius(rect, spec.radius);
  applyBorders(rect, spec.borders);
  applyEffects(rect, spec);
  rect.name = rect.name || spec.name || 'Image';
  return rect;
}

/**
 * createNodeFromSvg returns a frame at the artwork's own intrinsic size, and
 * resize() moves that frame's edges without touching the vectors inside it. So
 * any SVG whose file size differs from its layout box gets cropped rather than
 * scaled — a 230x240 logo dropped into a 42x44 slot shows one corner of itself.
 * rescale() is the one that takes the contents with it.
 */
function fitSvg(node, w, h) {
  if (!(w > 0 && h > 0) || !(node.width > 0 && node.height > 0)) return;
  const k = Math.min(w / node.width, h / node.height);
  if (k > 0.01 && Math.abs(k - 1) > 0.002) node.rescale(k);
  // rescale is uniform, so a differing aspect ratio leaves the box short on one
  // axis. Square it off — padding the box beats distorting the artwork.
  if (Math.abs(node.width - w) > 0.5 || Math.abs(node.height - h) > 0.5) {
    node.resize(Math.max(1, w), Math.max(1, h));
  }
}

function buildSvg(spec) {
  try {
    const node = figma.createNodeFromSvg(spec.svg);
    node.name = spec.name || 'Icon';
    fitSvg(node, spec.w, spec.h);
    return node;
  } catch (e) {
    const frame = figma.createFrame();
    frame.resize(Math.max(1, spec.w), Math.max(1, spec.h));
    frame.fills = [];
    frame.name = (spec.name || 'Icon') + ' (svg failed)';
    return frame;
  }
}

async function buildFrame(spec) {
  const frame = figma.createFrame();
  frame.resize(Math.max(1, spec.w), Math.max(1, spec.h));
  frame.name = spec.name || 'Frame';
  frame.clipsContent = !!spec.clip;
  frame.fills = await toPaints(spec.fills);
  applyBorders(frame, spec.borders);
  applyRadius(frame, spec.radius);
  applyEffects(frame, spec);
  return frame;
}

/**
 * Recursively build a node and its children. Coordinates arrive as absolute
 * document coordinates and are converted to parent-relative on append.
 */
// Auto Layout is only better than exact coordinates if it lands in the same
// place, so every conversion is checked against where the browser put things
// and rolled back if it drifts. That check is what makes this safe to do at
// all — the alternative is a layout engine guessing, which is how inferred
// Auto Layout usually ruins a design.
const AUTO_LAYOUT_DRIFT_PX = 2;
let autoLayoutEnabled = false;
let autoLayoutApplied = 0;
let autoLayoutReverted = 0;

/**
 * The spacing the capture actually shows, which is not always the spacing the
 * stylesheet declares. CSS `gap` separates element boxes; a captured text node
 * carries its line box, which is shorter by the half-leading. Spacing line
 * boxes by the declared gap runs tight, and down a stack of six paragraphs the
 * error accumulates into a visible shift. Reproducing the page is the point,
 * so measure what is there.
 *
 * Returns null when no single spacing could reproduce the layout — an auto
 * margin, a wrapped row — and the caller falls back to the declared value.
 */
function measuredSpacing(specs, horizontal) {
  if (specs.length < 2) return null;
  const sorted = specs.slice().sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    gaps.push(horizontal ? cur.x - (prev.x + prev.w) : cur.y - (prev.y + prev.h));
  }
  if (Math.max.apply(null, gaps) - Math.min.apply(null, gaps) > 8) return null;
  const mid = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  return Math.max(0, Math.round(mid * 100) / 100);
}

function applyAutoLayout(frame, spec, pairs) {
  const layout = spec.layout;
  if (!layout || frame.type !== 'FRAME') return;

  // A single child proves nothing about direction, gap or alignment.
  const flow = pairs.filter(([, s]) => !s.absolute);
  if (flow.length < 2) return;

  const snap = pairs.map(([n]) => ({ n, x: n.x, y: n.y, w: n.width, h: n.height }));
  const frameSnap = { w: frame.width, h: frame.height };
  const originalOrder = frame.children.slice();
  const horizontal = layout.mode === 'HORIZONTAL';

  try {
    // Figma lays out in child-index order, which stops matching DOM order the
    // moment the page uses flex-direction: *-reverse or the `order` property.
    // Sorting by captured position is right in every case.
    const axis = horizontal ? 'x' : 'y';
    flow.slice().sort((a, b) => a[1][axis] - b[1][axis]).forEach(([n]) => frame.appendChild(n));

    frame.layoutMode = layout.mode;
    if (layout.wrap && horizontal) {
      frame.layoutWrap = 'WRAP';
      frame.counterAxisSpacing = layout.counterGap;
    }
    frame.primaryAxisAlignItems = layout.primary;
    // Baseline alignment only exists on a row.
    frame.counterAxisAlignItems =
      layout.counter === 'BASELINE' && !horizontal ? 'MIN' : layout.counter;
    const measured = measuredSpacing(flow.map(([, s]) => s), horizontal);
    frame.itemSpacing = measured === null ? layout.gap : measured;

    frame.paddingTop = layout.padTop;
    frame.paddingRight = layout.padRight;
    frame.paddingBottom = layout.padBottom;
    frame.paddingLeft = layout.padLeft;

    // Same correction on the leading edge: where the first child actually sits
    // beats the declared padding, for the same line-box reason. Only safe when
    // the items start at the beginning of the axis.
    if (layout.primary === 'MIN') {
      const first = flow.slice().sort((a, b) => (horizontal ? a[1].x - b[1].x : a[1].y - b[1].y))[0][1];
      const lead = horizontal ? first.x - spec.x : first.y - spec.y;
      if (lead >= 0 && Math.abs(lead - (horizontal ? layout.padLeft : layout.padTop)) <= 8) {
        if (horizontal) frame.paddingLeft = lead;
        else frame.paddingTop = lead;
      }
    }
    // The frame's own box came from the browser and is not up for negotiation.
    frame.primaryAxisSizingMode = 'FIXED';
    frame.counterAxisSizingMode = 'FIXED';

    for (const [node, childSpec] of pairs) {
      try {
        if (childSpec.absolute) {
          // Figma has the same concept: out of flow, positioned by coordinates.
          node.layoutPositioning = 'ABSOLUTE';
          continue;
        }
        if (childSpec.grow) {
          if (horizontal) node.layoutSizingHorizontal = 'FILL';
          else node.layoutSizingVertical = 'FILL';
        }
        if (childSpec.stretch) {
          if (horizontal) node.layoutSizingVertical = 'FILL';
          else node.layoutSizingHorizontal = 'FILL';
        }
      } catch (e) { /* node can't fill in this axis; its fixed size is fine */ }
    }

    let drift = 0;
    for (const s of snap) {
      if (s.n.removed) continue;
      drift = Math.max(drift, Math.abs(s.n.x - s.x), Math.abs(s.n.y - s.y));
    }
    if (drift > AUTO_LAYOUT_DRIFT_PX) throw new Error('drift ' + drift.toFixed(1) + 'px');
    autoLayoutApplied++;
  } catch (e) {
    // Put it back exactly as the browser had it. Absolute coordinates are the
    // thing we can always be right about, so that is what we fall back to.
    try {
      frame.layoutMode = 'NONE';
      originalOrder.forEach((n) => { if (!n.removed) frame.appendChild(n); });
      for (const s of snap) {
        if (s.n.removed) continue;
        try { s.n.layoutPositioning = 'AUTO'; } catch (e2) { /* not in a layout */ }
        try { s.n.resize(Math.max(0.01, s.w), Math.max(0.01, s.h)); } catch (e2) { /* auto-sized text */ }
        s.n.x = s.x;
        s.n.y = s.y;
      }
      frame.resize(Math.max(0.01, frameSnap.w), Math.max(0.01, frameSnap.h));
    } catch (e2) { /* nothing further we can do safely */ }
    autoLayoutReverted++;
  }
}

async function buildNode(spec, parent, parentAbs) {
  if (!spec) return null;
  await yieldOccasionally();

  let node;
  if (spec.type === 'TEXT') node = await buildText(spec);
  else if (spec.type === 'IMAGE') node = await buildImage(spec);
  else if (spec.type === 'SVG') node = buildSvg(spec);
  else node = await buildFrame(spec);

  parent.appendChild(node);
  node.x = spec.x - parentAbs.x + (spec.__dx || 0);
  node.y = spec.y - parentAbs.y;

  if (spec.opacity !== undefined && spec.opacity < 1) node.opacity = spec.opacity;
  if (spec.blendMode) { try { node.blendMode = spec.blendMode; } catch (e) { /* unsupported here */ } }
  // TEXT and SVG never reach buildFrame/buildImage, so apply their effects here.
  if (spec.type === 'TEXT' || spec.type === 'SVG') applyEffects(node, spec);
  if (spec.rotation) {
    try { node.rotation = spec.rotation; } catch (e) { /* not rotatable */ }
  }
  try { node.constraints = { horizontal: 'MIN', vertical: 'MIN' }; } catch (e) { /* text/vector */ }

  // clip-path becomes a Figma mask. It has to sit at index 0 — a mask applies
  // to the siblings above it — so it goes in before the children are built.
  if (spec.clipShape && node.type === 'FRAME') {
    try {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.clipShape.w}" height="${spec.clipShape.h}" viewBox="0 0 ${spec.clipShape.w} ${spec.clipShape.h}">${spec.clipShape.svg}</svg>`;
      const mask = figma.createNodeFromSvg(svg);
      mask.name = 'Clip';
      node.insertChild(0, mask);
      mask.x = 0; mask.y = 0;
      mask.isMask = true;
    } catch (e) { /* unmaskable shape: leave the frame unclipped */ }
  }

  const pairs = [];
  if (spec.children && spec.children.length && spec.type !== 'SVG') {
    for (const child of spec.children) {
      const built = await buildNode(child, node, { x: spec.x, y: spec.y });
      if (built) pairs.push([built, child]);
    }
  }

  // After the children exist — Auto Layout has nothing to arrange before that.
  if (autoLayoutEnabled && spec.layout && node.type === 'FRAME') {
    applyAutoLayout(node, spec, pairs);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Import orchestration
// ---------------------------------------------------------------------------
/**
 * Turn each captured interaction state into a real Figma component set.
 *
 * Tabs and accordions only ever show one panel at a time, so a plain snapshot
 * loses the rest. The capture clicked through them; here each state becomes a
 * variant, which is what a designer actually wants to receive — one component
 * with a State property, not four disconnected frames.
 */
async function buildStateSets(doc, origin, label) {
  const empty = { sets: [], ids: [], blockHeight: 0 };
  if (!doc.states || !doc.states.length) return empty;
  const made = [];
  const ids = [];

  // A lane directly beneath the page frame, flush with its left edge. This used
  // to sit to the right at `width + 240` — but the next page in a batch starts
  // at `width + 160`, so every component set landed 80px inside the following
  // page's frame. Four frames in, the sets were strewn across the import.
  const x = origin.x;
  const laneTop = origin.y + Math.round(doc.meta.height) + 200;
  let cursorY = laneTop;

  for (const group of doc.states) {
    const groupTop = cursorY;
    const components = [];
    const loose = [];

    for (const variant of group.variants) {
      if (!variant.root) continue;
      const frame = figma.createFrame();
      frame.name = `State=${variant.label}`;
      frame.resize(Math.max(1, Math.round(variant.root.w) || 1), Math.max(1, Math.round(variant.root.h) || 1));
      frame.fills = [];
      frame.clipsContent = false;
      figma.currentPage.appendChild(frame);

      // The subtree carries absolute document coordinates; rebase to its own box.
      await buildNode(variant.root, frame, { x: variant.root.x, y: variant.root.y });
      frame.x = x;
      frame.y = cursorY;
      cursorY += frame.height + 40;

      try {
        components.push(figma.createComponentFromNode(frame));
      } catch (e) {
        frame.name = `${group.label} — ${variant.label}`; // leave it as a frame
        loose.push(frame);
      }
    }

    if (components.length >= 2) {
      try {
        const set = figma.combineAsVariants(components, figma.currentPage);
        set.name = `${label} — ${group.label}`;
        set.x = x;
        // The variants moved inside the set, so the set belongs where they
        // started, not below where they ended.
        set.y = groupTop;
        cursorY = groupTop + set.height + 80;
        ids.push(set.id);
        made.push({ name: set.name, variants: components.length });
      } catch (e) {
        components.forEach((c) => ids.push(c.id));
        made.push({ name: group.label, variants: components.length, note: 'kept as separate components' });
      }
    } else {
      components.forEach((c) => ids.push(c.id));
    }
    loose.forEach((f) => ids.push(f.id));
  }

  // What the section has to be tall enough to hold, measured from the frame's
  // own top — nothing if the lane stayed empty.
  return { sets: made, ids, blockHeight: ids.length ? cursorY - origin.y : 0 };
}

async function importDocument(doc, label, origin, runId, wantComponents, wantAutoLayout) {
  nodesBuilt = 0;
  substitutions.clear();
  autoLayoutEnabled = wantAutoLayout !== false;
  autoLayoutApplied = 0;
  autoLayoutReverted = 0;

  figma.ui.postMessage({ type: 'stage', stage: `Loading fonts for ${label}` });
  await preloadFonts(doc);

  figma.ui.postMessage({ type: 'stage', stage: `Building ${label}` });

  const width = Math.round(doc.meta.width);
  const height = Math.round(doc.meta.height);

  const root = figma.createFrame();
  root.name = `${label} — ${doc.meta.requestedWidth}`;
  root.resize(Math.max(1, width), Math.max(1, height));
  root.clipsContent = true;
  root.fills = doc.background ? [doc.background] : [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  root.x = origin.x;
  root.y = origin.y;

  const abs = { x: 0, y: 0 };
  if (doc.root) {
    await buildNode(doc.root, root, abs);
  }

  // Fixed elements were hoisted during capture so a sticky header appears once,
  // at the top, instead of repeating down the page.
  if (doc.overlays && doc.overlays.length) {
    for (const overlay of doc.overlays) {
      const node = await buildNode(overlay, root, abs);
      if (node) node.name = `${node.name} (fixed)`;
    }
  }

  let stateSets = [];
  let stateSetIds = [];
  let blockHeight = 0;
  const skippedStates = (doc.states || []).length;
  if (wantComponents === false) {
    // Asked for pages, not components. Captured states are dropped rather than
    // dumped on the canvas as loose frames.
    if (skippedStates) {
      figma.ui.postMessage({
        type: 'fidelity-note',
        note: `${skippedStates} captured state group${skippedStates > 1 ? 's' : ''} not built — components are off.`
      });
    }
  } else {
    try {
      const built = await buildStateSets(doc, origin, label);
      stateSets = built.sets;
      stateSetIds = built.ids;
      blockHeight = built.blockHeight;
      if (stateSets.length) {
        figma.ui.postMessage({ type: 'stage', stage: `Built ${stateSets.length} component set${stateSets.length > 1 ? 's' : ''}` });
      }
    } catch (e) {
      figma.ui.postMessage({ type: 'fidelity-note', note: 'Component sets failed: ' + String(e.message || e) });
    }
  }

  builtFrames.push({ id: root.id, label, runId });

  return {
    frameId: root.id,
    label,
    width,
    height,
    // The frame plus its component-set lane — what the row has to make space for.
    blockHeight: Math.max(height, blockHeight),
    autoLayout: { applied: autoLayoutApplied, reverted: autoLayoutReverted },
    stateSets,
    stateSetIds,
    nodes: nodesBuilt,
    substitutions: Array.from(substitutions.entries()).map(([from, to]) => ({ from, to }))
  };
}

function nextOrigin() {
  const center = figma.viewport.center;
  return { x: Math.round(center.x - 720), y: Math.round(center.y - 300) };
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
let pendingSection = null;

figma.ui.onmessage = async (msg) => {
  try {
    switch (msg.type) {
      case 'asset': {
        if (msg.kind === 'svg') assetSvg.set(msg.id, msg.svg);
        else assetBytes.set(msg.id, msg.bytes);
        break;
      }

      case 'import-begin': {
        pendingSection = {
          origin: nextOrigin(),
          host: msg.host,
          frames: [],
          cursorX: 0,
          cursorY: 0,
          rowHeight: 0,
          widest: 0
        };
        break;
      }

      case 'import-doc': {
        if (!pendingSection) {
          pendingSection = {
            origin: nextOrigin(), host: msg.host, frames: [],
            cursorX: 0, cursorY: 0, rowHeight: 0, widest: 0
          };
        }

        // A forty-page batch in one row would be ~130,000px wide and unusable,
        // so wrap into rows. Page frames are tall and thin, which makes a grid
        // far easier to navigate than a single strip.
        const ROW_LIMIT = 14000;
        if (pendingSection.cursorX > 0 && pendingSection.cursorX > ROW_LIMIT) {
          pendingSection.cursorY += pendingSection.rowHeight + 200;
          pendingSection.cursorX = 0;
          pendingSection.rowHeight = 0;
        }

        const origin = {
          x: pendingSection.origin.x + pendingSection.cursorX,
          y: pendingSection.origin.y + pendingSection.cursorY
        };
        const result = await importDocument(
          msg.doc, msg.label, origin, msg.runId, msg.wantComponents, msg.wantAutoLayout
        );
        pendingSection.frames.push(result);
        pendingSection.cursorX += result.width + 160;
        const block = result.blockHeight || result.height;
        if (block > pendingSection.rowHeight) pendingSection.rowHeight = block;
        if (pendingSection.cursorX > pendingSection.widest) pendingSection.widest = pendingSection.cursorX;
        figma.ui.postMessage({ type: 'doc-done', result });
        break;
      }

      case 'import-end': {
        if (!pendingSection || !pendingSection.frames.length) break;

        // Component sets belong in the section with the pages they came from.
        // Left on the page they read as unrelated debris beside the import.
        const ids = [];
        pendingSection.frames.forEach((f) => {
          ids.push(f.frameId);
          (f.stateSetIds || []).forEach((id) => ids.push(id));
        });
        const nodes = (await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)))).filter(Boolean);

        let container = null;
        try {
          container = figma.createSection();
          container.name = `Website Import — ${pendingSection.host}`;
          const maxH = pendingSection.cursorY + pendingSection.rowHeight;
          const totalW = pendingSection.widest || pendingSection.cursorX;
          container.x = pendingSection.origin.x - 80;
          container.y = pendingSection.origin.y - 120;
          container.resizeWithoutConstraints(totalW + 80, maxH + 200);
          for (const n of nodes) {
            const gx = n.x, gy = n.y;
            container.appendChild(n);
            n.x = gx - container.x;
            n.y = gy - container.y;
          }
        } catch (e) {
          // Sections aren't available in every editor context; frames still land.
          container = null;
        }

        const target = container || nodes[0];
        if (target) {
          figma.currentPage.selection = container ? [container] : nodes;
          figma.viewport.scrollAndZoomIntoView(container ? [container] : nodes);
        }

        figma.ui.postMessage({ type: 'import-complete', frames: pendingSection.frames });
        figma.notify(`Imported ${pendingSection.frames.length} frame${pendingSection.frames.length > 1 ? 's' : ''}`);
        pendingSection = null;
        break;
      }

      case 'export-frame': {
        const node = await figma.getNodeByIdAsync(msg.frameId);
        if (!node) {
          figma.ui.postMessage({ type: 'export-failed', error: 'That frame no longer exists.' });
          break;
        }
        const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
        figma.ui.postMessage({ type: 'export-ready', bytes, runId: msg.runId, label: node.name });
        break;
      }

      case 'list-frames': {
        figma.ui.postMessage({ type: 'frames', frames: builtFrames });
        break;
      }

      case 'close':
        figma.closePlugin();
        break;

      default:
        break;
    }
  } catch (err) {
    console.error(err);
    figma.ui.postMessage({ type: 'error', error: String(err && err.message ? err.message : err) });
  }
};
