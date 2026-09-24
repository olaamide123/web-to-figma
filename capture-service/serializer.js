/**
 * serializer.js
 * -----------------------------------------------------------------------------
 * This file is injected into the captured page and evaluated in the browser.
 * It exposes window.__W2F__.serialize(options) which walks the rendered DOM and
 * returns a plain-JSON document describing the page as a tree of drawable nodes.
 *
 * It runs with scrollY === 0, so getBoundingClientRect() coordinates are already
 * document coordinates.
 *
 * Node shape:
 * {
 *   type: 'FRAME' | 'TEXT' | 'IMAGE' | 'SVG',
 *   name, x, y, w, h,
 *   fills: [Paint], strokes: {...}, radius: [tl,tr,br,bl],
 *   shadows: [...], opacity, rotation, clip,
 *   text: {...}   // TEXT only
 *   image: {...}  // IMAGE only
 *   svg: '<svg .../>'
 *   children: []
 * }
 */
(function () {
  'use strict';

  var W2F = {};
  window.__W2F__ = W2F;

  // ---------------------------------------------------------------------------
  // Colour parsing
  // ---------------------------------------------------------------------------
  var colorCache = Object.create(null);
  var probeCtx = null;

  function probe(str) {
    if (!probeCtx) {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      probeCtx = c.getContext('2d', { willReadFrequently: true });
    }
    probeCtx.clearRect(0, 0, 1, 1);
    probeCtx.fillStyle = '#000';
    probeCtx.fillStyle = str;
    probeCtx.fillRect(0, 0, 1, 1);
    var d = probeCtx.getImageData(0, 0, 1, 1).data;
    var a = d[3] / 255;
    // getImageData returns premultiplied-ish values; un-premultiply.
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return { r: d[0] / 255 / a, g: d[1] / 255 / a, b: d[2] / 255 / a, a: a };
  }

  function parseColor(str) {
    if (!str) return null;
    if (colorCache[str] !== undefined) return colorCache[str];
    var out = null;
    if (str === 'transparent' || str === 'none') {
      out = { r: 0, g: 0, b: 0, a: 0 };
    } else {
      var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/i.exec(str);
      if (m) {
        var a = m[4] === undefined ? 1 : (String(m[4]).indexOf('%') >= 0 ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
        out = { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: a };
      } else {
        // oklch(), color(display-p3 ...), lab(), named colours, etc.
        try { out = probe(str); } catch (e) { out = null; }
      }
    }
    colorCache[str] = out;
    return out;
  }

  function solid(color) {
    if (!color || color.a === 0) return null;
    return {
      type: 'SOLID',
      color: { r: clamp01(color.r), g: clamp01(color.g), b: clamp01(color.b) },
      opacity: clamp01(color.a)
    };
  }

  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }
  function round(n) { return Math.round(n * 100) / 100; }

  // ---------------------------------------------------------------------------
  // Gradients (approximate)
  // ---------------------------------------------------------------------------
  function splitTopLevel(str) {
    var parts = [], depth = 0, cur = '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  var ANGLE_KEYWORDS = {
    'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
    'to top right': 45, 'to right top': 45,
    'to bottom right': 135, 'to right bottom': 135,
    'to bottom left': 225, 'to left bottom': 225,
    'to top left': 315, 'to left top': 315
  };

  /**
   * CSS 0deg points up and rotates clockwise.
   *
   * The obvious implementation rotates the unit square, and that is wrong on
   * every box that is not square: normalised space scales x by W and y by H, so
   * a 155deg gradient on a 241x140 card comes out at 51deg — 14 degrees off —
   * and a 45deg one on a 1440x400 band is off by nearly 30. CSS defines the
   * gradient line in *pixels*: it runs through the centre at the given angle,
   * long enough that its perpendiculars at each end touch the corners. So build
   * it there, then normalise.
   *
   * Returns the transform plus the line length, which is what a stop given in
   * px has to be measured against.
   */
  function linearGradientGeometry(deg, w, h) {
    var W = w > 0 ? w : 1;
    var H = h > 0 ? h : 1;
    var rad = deg * Math.PI / 180;
    var dx = Math.sin(rad);
    var dy = -Math.cos(rad); // screen y grows downward
    var length = Math.abs(W * dx) + Math.abs(H * dy);

    var cx = W / 2, cy = H / 2;
    var sx = cx - dx * length / 2, sy = cy - dy * length / 2;
    var ex = cx + dx * length / 2, ey = cy + dy * length / 2;

    if (!(length > 1e-9)) return { transform: [[1, 0, 0], [0, 1, 0]], length: 1 };

    // Project onto the gradient axis in *pixel* space, then express that as a
    // function of normalised coordinates. Projecting in normalised space
    // instead is the subtle version of the same square-box mistake: it only
    // agrees when W equals H.
    //   f(p) = ((p_px - start) . d) / length,  p_px = (nx*W, ny*H)
    // Row 1 is the perpendicular axis, which Figma needs invertible.
    return {
      transform: [
        [W * dx / length, H * dy / length, -(sx * dx + sy * dy) / length],
        [W * -dy / length, H * dx / length, -(sx * -dy + sy * dx) / length + 0.5]
      ],
      length: length
    };
  }

  /**
   * The original rotation-only transform. On a radial this is effectively a
   * no-op, so Figma falls back to its own centred radial — which is what this
   * tool shipped with and what looks right in the file today.
   *
   * The geometric version below reproduces CSS more exactly on paper, but
   * Figma's radial convention could not be verified from outside Figma, and
   * trusting the derivation over what the file actually looked like was the
   * mistake. It stays until it can be checked against a real import.
   */
  function rotationTransform(deg) {
    var rad = (deg - 90) * Math.PI / 180;
    var c = Math.cos(rad), s = Math.sin(rad);
    return [
      [c, s, (1 - c - s) / 2],
      [-s, c, (1 + s - c) / 2]
    ];
  }

  /** Where a radial gradient's centre and radii sit, as a Figma transform. */
  function radialGradientTransform(cx, cy, rx, ry) {
    var ax = 2 * (rx || 0.5), ay = 2 * (ry || 0.5);
    if (Math.abs(ax) < 1e-6) ax = 1e-6;
    if (Math.abs(ay) < 1e-6) ay = 1e-6;
    // Inverse of the map taking Figma's unit circle (centred at .5,.5, r=.5)
    // onto the ellipse CSS describes.
    return [
      [1 / ax, 0, -(cx - rx) / ax],
      [0, 1 / ay, -(cy - ry) / ay]
    ];
  }

  var POS_KEYWORDS = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };

  /** `at 30% 70%`, `at left center`, `at 20px 10px` -> normalised centre. */
  function radialCentre(head, w, h) {
    var at = /\bat\s+([^,)]+)/i.exec(head);
    if (!at) return { cx: 0.5, cy: 0.5 };
    var toks = at[1].trim().split(/\s+/);
    var read = function (tok, extent, fallback) {
      if (tok === undefined) return fallback;
      var k = POS_KEYWORDS[tok.toLowerCase()];
      if (k !== undefined) return k;
      if (/%$/.test(tok)) return parseFloat(tok) / 100;
      if (/px$/.test(tok)) return parseFloat(tok) / (extent || 1);
      return fallback;
    };
    return { cx: read(toks[0], w, 0.5), cy: read(toks[1], h, 0.5) };
  }

  function parseGradient(str, w, h) {
    var isLinear = /^(-webkit-)?(repeating-)?linear-gradient\(/i.test(str);
    var isRadial = /^(-webkit-)?(repeating-)?radial-gradient\(/i.test(str);
    var isConic = /^(-webkit-)?(repeating-)?conic-gradient\(/i.test(str);
    if (!isLinear && !isRadial && !isConic) return null;

    var inner = str.slice(str.indexOf('(') + 1, str.lastIndexOf(')'));
    var parts = splitTopLevel(inner);
    if (!parts.length) return null;

    var deg = 180;
    var head = parts[0].toLowerCase();
    var headFull = head;
    if (/^-?[\d.]+deg$/.test(head)) { deg = parseFloat(head); parts.shift(); }
    else if (ANGLE_KEYWORDS[head] !== undefined) { deg = ANGLE_KEYWORDS[head]; parts.shift(); }
    else if (isRadial && /(circle|ellipse|\bat\b|closest|farthest)/i.test(head)) { parts.shift(); }
    else if (isConic && /(from|\bat\b)/i.test(head)) { parts.shift(); }

    // Geometry first: a stop given in px means nothing without the gradient
    // line to measure it against.
    var geo = isLinear
      ? linearGradientGeometry(deg, w, h)
      : { transform: null, length: Math.max(w || 0, h || 0) || 1 };

    var stops = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim();
      // A stop may carry two positions — `red 20% 40%` is shorthand for a hard
      // band. Reading only the last one and handing the rest to the colour
      // parser made it fail, and the stop vanished entirely.
      var trail = [];
      var work = seg;
      for (var k = 0; k < 2; k++) {
        var pm = /\s(-?[\d.]+)(%|px|r?em)$/.exec(work);
        if (!pm) break;
        trail.unshift({ value: parseFloat(pm[1]), unit: pm[2] });
        work = work.slice(0, pm.index).trim();
      }
      var col = parseColor(work);
      if (!col) continue;
      var toFraction = function (t) {
        if (t.unit === '%') return t.value / 100;
        var px = t.unit === '%' ? t.value : t.value * (t.unit === 'px' ? 1 : 16);
        return geo.length > 0 ? px / geo.length : null;
      };
      if (!trail.length) stops.push({ color: col, position: null });
      else for (var t2 = 0; t2 < trail.length; t2++) {
        stops.push({ color: col, position: toFraction(trail[t2]) });
      }
    }
    if (stops.length < 2) return null;

    // Fill in missing stop positions by even distribution.
    if (stops[0].position === null) stops[0].position = 0;
    if (stops[stops.length - 1].position === null) stops[stops.length - 1].position = 1;
    for (var j = 1; j < stops.length - 1; j++) {
      if (stops[j].position === null) stops[j].position = j / (stops.length - 1);
    }

    var transform;
    if (isLinear) {
      transform = geo.transform;
    } else if (true) {
      // Radial and conic: back to the shipped behaviour until the convention
      // is confirmed against a real Figma import.
      transform = rotationTransform(deg);
    } else if (isRadial) {
      // CSS defaults to an ellipse covering the farthest corner from the
      // centre, which in normalised terms is just the distance to the far edge
      // on each axis.
      var c = radialCentre(headFull, w, h);
      var isCircle = /\bcircle\b/i.test(headFull);
      var closest = /closest-(side|corner)/i.test(headFull);
      // Side distances, normalised.
      var rx = closest ? Math.min(c.cx, 1 - c.cx) : Math.max(c.cx, 1 - c.cx);
      var ry = closest ? Math.min(c.cy, 1 - c.cy) : Math.max(c.cy, 1 - c.cy);
      // CSS defaults to farthest-CORNER, not farthest-side. The corner ellipse
      // has the side ellipse's aspect ratio scaled to pass through the corner,
      // which works out to exactly sqrt(2) bigger. Getting this wrong makes
      // every glow and blob noticeably too tight.
      var corner = !/(closest|farthest)-side/i.test(headFull);
      if (isCircle && w > 0 && h > 0) {
        var dxPx = rx * w, dyPx = ry * h;
        var rpx = corner ? Math.sqrt(dxPx * dxPx + dyPx * dyPx) : Math.max(dxPx, dyPx);
        rx = rpx / w;
        ry = rpx / h;
      } else if (corner) {
        rx *= Math.SQRT2;
        ry *= Math.SQRT2;
      }
      transform = radialGradientTransform(c.cx, c.cy, rx, ry);
    } else {
      transform = radialGradientTransform(0.5, 0.5, 0.5, 0.5);
    }

    return {
      type: isConic ? 'GRADIENT_ANGULAR' : isRadial ? 'GRADIENT_RADIAL' : 'GRADIENT_LINEAR',
      gradientTransform: transform,
      gradientStops: stops.map(function (s) {
        return {
          position: clamp01(s.position),
          color: { r: clamp01(s.color.r), g: clamp01(s.color.g), b: clamp01(s.color.b), a: clamp01(s.color.a) }
        };
      })
    };
  }

  // ---------------------------------------------------------------------------
  // Shadows
  // ---------------------------------------------------------------------------
  /**
   * Figma's only filter-shaped effect is a blur, so that is all we lift out of
   * `filter` / `backdrop-filter`. brightness/contrast/saturate are already
   * baked into any raster we capture; on vector and text they are dropped.
   */
  function blurRadius(str) {
    if (!str || str === 'none') return 0;
    var m = /blur\(\s*([\d.]+)px\s*\)/i.exec(str);
    return m ? Math.round(parseFloat(m[1]) * 100) / 100 : 0;
  }

  var BLEND_MODES = {
    normal: 'NORMAL', multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY',
    darken: 'DARKEN', lighten: 'LIGHTEN', 'color-dodge': 'COLOR_DODGE',
    'color-burn': 'COLOR_BURN', 'hard-light': 'HARD_LIGHT', 'soft-light': 'SOFT_LIGHT',
    difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE',
    saturation: 'SATURATION', color: 'COLOR', luminosity: 'LUMINOSITY'
  };

  function blendModeOf(cs) {
    var m = BLEND_MODES[(cs.mixBlendMode || '').toLowerCase()];
    return m && m !== 'NORMAL' ? m : null;
  }

  // ---------------------------------------------------------------------------
  // clip-path
  // ---------------------------------------------------------------------------
  function cpLen(v, basis) {
    v = String(v == null ? 0 : v).trim();
    if (v.slice(-1) === '%') return (parseFloat(v) || 0) / 100 * basis;
    return parseFloat(v) || 0;
  }

  /**
   * Figma has no clip-path, but it does have masks. Translate the shape into a
   * small SVG in element-local coordinates; the plugin turns it into a vector
   * and flags it as a mask so everything above it in the frame gets clipped.
   * url(#id) references an SVG <clipPath> elsewhere in the document and is left
   * alone — resolving it means resolving arbitrary referenced geometry.
   */
  function clipPathShape(cs, rect) {
    var cp = cs.clipPath || cs.webkitClipPath;
    if (!cp || cp === 'none' || /^url\(/i.test(cp)) return null;
    var w = rect.width, h = rect.height;
    if (!(w > 0) || !(h > 0)) return null;
    var m;

    if ((m = /^inset\(([^)]*)\)/i.exec(cp))) {
      var seg = m[1].split(/\s+round\s+/i);
      var q = seg[0].trim().split(/\s+/);
      var t = cpLen(q[0], h);
      var r = cpLen(q.length > 1 ? q[1] : q[0], w);
      var b = cpLen(q.length > 2 ? q[2] : q[0], h);
      var l = cpLen(q.length > 3 ? q[3] : (q.length > 1 ? q[1] : q[0]), w);
      var rad = seg[1] ? cpLen(seg[1].trim().split(/\s+/)[0], Math.min(w, h)) : 0;
      return { w: w, h: h, svg: '<rect x="' + round(l) + '" y="' + round(t) + '" width="' + round(Math.max(0, w - l - r)) + '" height="' + round(Math.max(0, h - t - b)) + '" rx="' + round(rad) + '" fill="#000"/>' };
    }

    if ((m = /^circle\(([^)]*)\)/i.exec(cp))) {
      var p = m[1].split(/\s+at\s+/i);
      // CSS resolves a percentage radius against the diagonal, not the width.
      var diag = Math.sqrt(w * w + h * h) / Math.SQRT2;
      var rr = p[0].trim() ? cpLen(p[0].trim(), diag) : Math.min(w, h) / 2;
      var at = (p[1] || '50% 50%').trim().split(/\s+/);
      return { w: w, h: h, svg: '<circle cx="' + round(cpLen(at[0], w)) + '" cy="' + round(cpLen(at[1] == null ? at[0] : at[1], h)) + '" r="' + round(rr) + '" fill="#000"/>' };
    }

    if ((m = /^ellipse\(([^)]*)\)/i.exec(cp))) {
      var pe = m[1].split(/\s+at\s+/i);
      var rads = (pe[0] || '').trim().split(/\s+/);
      var rx = rads[0] ? cpLen(rads[0], w) : w / 2;
      var ry = rads[1] ? cpLen(rads[1], h) : h / 2;
      var ate = (pe[1] || '50% 50%').trim().split(/\s+/);
      return { w: w, h: h, svg: '<ellipse cx="' + round(cpLen(ate[0], w)) + '" cy="' + round(cpLen(ate[1] == null ? ate[0] : ate[1], h)) + '" rx="' + round(rx) + '" ry="' + round(ry) + '" fill="#000"/>' };
    }

    if ((m = /^polygon\(([^)]*)\)/i.exec(cp))) {
      var pts = m[1].split(',').map(function (pair) {
        var xy = pair.trim().split(/\s+/);
        return round(cpLen(xy[0], w)) + ',' + round(cpLen(xy[1], h));
      }).filter(Boolean);
      if (pts.length < 3) return null;
      return { w: w, h: h, svg: '<polygon points="' + pts.join(' ') + '" fill="#000"/>' };
    }

    return null;
  }

  function parseShadows(str) {
    if (!str || str === 'none') return [];
    var out = [];
    var parts = splitTopLevel(str);
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim();
      var inset = /(^|\s)inset(\s|$)/.test(seg);
      seg = seg.replace(/(^|\s)inset(\s|$)/, ' ').trim();

      // Pull the colour out first (it may sit before or after the lengths).
      var color = null;
      var cm = /(rgba?\([^)]*\)|oklch\([^)]*\)|hsla?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i.exec(seg);
      if (cm) { color = parseColor(cm[1]); seg = seg.replace(cm[1], ' '); }

      var nums = seg.match(/-?[\d.]+px/g) || [];
      if (nums.length < 2) continue;
      var n = nums.map(parseFloat);
      out.push({
        type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        offset: { x: n[0] || 0, y: n[1] || 0 },
        radius: n[2] || 0,
        spread: n[3] || 0,
        color: color || { r: 0, g: 0, b: 0, a: 0.25 }
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Transforms
  // ---------------------------------------------------------------------------
  /** The translate part of a computed transform matrix, in px. */
  function translationOf(str) {
    if (!str || str === 'none') return { x: 0, y: 0 };
    var m = /^matrix\(([^)]+)\)$/.exec(str);
    if (m) {
      var v = m[1].split(',').map(parseFloat);
      return { x: v[4] || 0, y: v[5] || 0 };
    }
    var m3 = /^matrix3d\(([^)]+)\)$/.exec(str);
    if (m3) {
      var v3 = m3[1].split(',').map(parseFloat);
      return { x: v3[12] || 0, y: v3[13] || 0 };
    }
    return { x: 0, y: 0 };
  }

  function rotationOf(transform) {
    if (!transform || transform === 'none') return 0;
    var m = /^matrix\(([^)]+)\)$/.exec(transform);
    if (!m) return 0; // matrix3d and friends: skip
    var v = m[1].split(',').map(parseFloat);
    var deg = Math.atan2(v[1], v[0]) * 180 / Math.PI;
    return Math.abs(deg) < 0.01 ? 0 : deg;
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, META: 1, LINK: 1, TITLE: 1, HEAD: 1, TEMPLATE: 1, BR: 1, TRACK: 1, SOURCE: 1, PARAM: 1, MAP: 1, AREA: 1, WBR: 1, OPTION: 1 };

  function isRendered(el, cs, rect) {
    if (SKIP_TAGS[el.tagName]) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (cs.contentVisibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    if (el.hasAttribute && el.hasAttribute('aria-hidden') && el.getAttribute('aria-hidden') === 'true' && !el.querySelector('img,svg')) {
      // aria-hidden alone isn't proof of invisibility, but decorative duplicates
      // are common; keep it if it paints anything.
    }
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom < -2000 || rect.right < -2000) return false; // off-canvas menus
    return true;
  }

  // ---------------------------------------------------------------------------
  // Text handling
  // ---------------------------------------------------------------------------
  var INLINE_OK = { SPAN: 1, A: 1, STRONG: 1, B: 1, EM: 1, I: 1, U: 1, SMALL: 1, CODE: 1, MARK: 1, SUB: 1, SUP: 1, LABEL: 1, TIME: 1, ABBR: 1, S: 1, DEL: 1, INS: 1, Q: 1, VAR: 1, KBD: 1, FONT: 1 };

  function hasDirectText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    return false;
  }

  // An element is a "leaf text block" when everything inside it is inline text.
  function isTextBlock(el) {
    if (!hasDirectText(el) && !allInlineTextChildren(el)) return false;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (!INLINE_OK[c.tagName]) return false;
      if (c.querySelector && c.querySelector('img,svg,video,canvas,picture')) return false;
      var ccs = getComputedStyle(c);
      if (ccs.display !== 'inline' && ccs.display !== 'inline-block' && ccs.display !== 'contents') return false;
      // A nested inline with its own background/border deserves its own frame.
      if (ccs.backgroundColor && parseColor(ccs.backgroundColor) && parseColor(ccs.backgroundColor).a > 0.02) return false;
      if (ccs.borderTopWidth !== '0px' || ccs.borderBottomWidth !== '0px') return false;
      if (!isTextBlock(c) && c.children.length) return false;
    }
    return (el.textContent || '').trim().length > 0;
  }

  function allInlineTextChildren(el) {
    if (!el.children.length) return false;
    for (var i = 0; i < el.children.length; i++) {
      if (!INLINE_OK[el.children[i].tagName]) return false;
    }
    return (el.textContent || '').trim().length > 0;
  }

  var WEIGHT_NAMES = { normal: 400, bold: 700, lighter: 300, bolder: 700 };

  function fontWeight(cs) {
    var w = cs.fontWeight;
    if (WEIGHT_NAMES[w]) return WEIGHT_NAMES[w];
    var n = parseInt(w, 10);
    return isNaN(n) ? 400 : n;
  }

  function familyStack(cs) {
    return (cs.fontFamily || '')
      .split(',')
      .map(function (f) { return f.trim().replace(/^["']|["']$/g, ''); })
      .filter(Boolean);
  }

  function lineHeightPx(cs) {
    var lh = cs.lineHeight;
    if (!lh || lh === 'normal') return null;
    if (lh.indexOf('px') >= 0) return parseFloat(lh);
    var n = parseFloat(lh);
    return isNaN(n) ? null : n * parseFloat(cs.fontSize);
  }

  /**
   * `line-height: normal` has no px value in computed style. Left null, the
   * plugin hands Figma AUTO, and Figma's own metric does not match Chromium's —
   * for Satoshi it is 1.35em against Chromium's 1.25em, so every block lands 8%
   * taller and the error compounds down the page. Measure the line boxes that
   * were actually painted and emit that instead.
   *
   * getClientRects() returns one rect per line box (and per inline fragment),
   * so distinct lines are counted by grouping rects that share a top edge.
   */
  function measureLineMetrics(range, rangeRect) {
    try {
      if (!rangeRect || !(rangeRect.height > 0)) return null;
      var rects = range.getClientRects();
      if (!rects || !rects.length) return null;

      // Group rects into line boxes. Fragments on one line always overlap
      // vertically because they share a baseline, even when their font sizes
      // differ; separate lines never overlap. Overlap is therefore a safer test
      // than comparing top edges, which mis-splits mixed-size runs such as a
      // large number followed by a small label on the same line.
      var lines = [];
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (!(r.height > 0)) continue;
        var hit = null;
        for (var j = 0; j < lines.length; j++) {
          var ov = Math.min(lines[j].bottom, r.bottom) - Math.max(lines[j].top, r.top);
          var ref = Math.min(lines[j].bottom - lines[j].top, r.height);
          if (ov > ref * 0.3) { hit = lines[j]; break; }
        }
        if (hit) {
          if (r.top < hit.top) hit.top = r.top;
          if (r.bottom > hit.bottom) hit.bottom = r.bottom;
        } else {
          lines.push({ top: r.top, bottom: r.bottom });
        }
      }
      if (!lines.length) return null;
      if (lines.length === 1) return { lines: 1, advance: rangeRect.height };

      // Line-top to line-top is the advance. The median shrugs off a tall first
      // line or a descender hanging off the last one.
      lines.sort(function (a, b) { return a.top - b.top; });
      var gaps = [];
      for (var k = 1; k < lines.length; k++) gaps.push(lines[k].top - lines[k - 1].top);
      gaps.sort(function (a, b) { return a - b; });
      var mid = gaps[Math.floor(gaps.length / 2)];
      return { lines: lines.length, advance: mid > 0 ? mid : rangeRect.height / lines.length };
    } catch (e) { return null; }
  }

  /** Explicit CSS line-height wins; otherwise use the advance we measured. */
  function resolveLineHeight(cs, metrics) {
    var explicit = lineHeightPx(cs);
    if (explicit != null) return explicit;
    return metrics && metrics.advance != null ? round(metrics.advance) : null;
  }

  /**
   * A Range reports the font box (ascent + descent); Figma positions text by the
   * line box. Display headings often set line-height below 1, making the font
   * box taller than the line box so it overhangs top and bottom — the raw range
   * top then sits above where Figma draws the first line, and adjacent
   * fragments of the same heading overlap. Shift by the half-leading and
   * restate the height in line boxes, which is what Figma will produce.
   */
  function alignToLineBox(top, height, lineHeight, metrics) {
    if (!lineHeight || !metrics || !metrics.lines) return { top: top, height: height };
    var fontBox = height - (metrics.lines - 1) * lineHeight;
    if (!(fontBox > 0)) return { top: top, height: height };
    return {
      top: top + (fontBox - lineHeight) / 2,
      height: metrics.lines * lineHeight
    };
  }

  /**
   * Width a string would occupy in the element's font, without touching the
   * DOM. Only an estimate — canvas shaping is not layout shaping — but enough
   * to tell a one-line placeholder from one that wraps.
   */
  var measureCtx = null;
  function textWidth(cs, str) {
    try {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
      measureCtx.font = [cs.fontStyle, cs.fontWeight, cs.fontSize, cs.fontFamily].join(' ');
      var w = measureCtx.measureText(str).width;
      var ls = letterSpacingPx(cs);
      return w + (ls ? ls * str.length : 0);
    } catch (e) { return 0; }
  }

  // justify-content / align-items, in Figma's vocabulary. Figma has no
  // space-around or space-evenly; SPACE_BETWEEN is the nearest thing that keeps
  // the end items where the browser put them, and the plugin's verify pass
  // throws the whole conversion away if that lands badly.
  var PRIMARY_ALIGN = {
    'flex-start': 'MIN', 'start': 'MIN', 'left': 'MIN', 'normal': 'MIN', 'stretch': 'MIN',
    'center': 'CENTER',
    'flex-end': 'MAX', 'end': 'MAX', 'right': 'MAX',
    'space-between': 'SPACE_BETWEEN', 'space-around': 'SPACE_BETWEEN', 'space-evenly': 'SPACE_BETWEEN'
  };
  var COUNTER_ALIGN = {
    'flex-start': 'MIN', 'start': 'MIN', 'self-start': 'MIN', 'normal': 'MIN', 'stretch': 'MIN',
    'center': 'CENTER',
    'flex-end': 'MAX', 'end': 'MAX', 'self-end': 'MAX',
    'baseline': 'BASELINE', 'first baseline': 'BASELINE', 'last baseline': 'BASELINE'
  };

  /**
   * Auto Layout read off the page rather than guessed at.
   *
   * A flex container already states everything Figma needs — direction, gap,
   * padding, both alignments — so this is a translation, not an inference,
   * which is what made it worth doing at all. Grid is only taken when it
   * resolves to a single row or column; a real two-axis grid has no Auto Layout
   * equivalent and is better left absolute than approximated.
   */
  function readLayout(el, cs) {
    var display = cs.display;
    var isFlex = display === 'flex' || display === 'inline-flex';
    var isGrid = display === 'grid' || display === 'inline-grid';
    if (!isFlex && !isGrid) return null;
    if (!el.children || !el.children.length) return null;

    var mode, reverse = false;
    if (isGrid) {
      var cols = String(cs.gridTemplateColumns || 'none').trim();
      var rows = String(cs.gridTemplateRows || 'none').trim();
      var nCols = cols === 'none' ? 1 : cols.split(/\s+/).length;
      var nRows = rows === 'none' ? 1 : rows.split(/\s+/).length;
      if (nCols > 1 && nRows > 1) return null;
      mode = nCols > 1 ? 'HORIZONTAL' : 'VERTICAL';
    } else {
      var dir = cs.flexDirection || 'row';
      mode = dir.indexOf('column') === 0 ? 'VERTICAL' : 'HORIZONTAL';
      reverse = dir.indexOf('-reverse') > 0;
    }

    var rowGap = parseFloat(cs.rowGap);
    var colGap = parseFloat(cs.columnGap);
    if (isNaN(rowGap)) rowGap = 0;
    if (isNaN(colGap)) colGap = 0;

    return {
      mode: mode,
      reverse: reverse,
      wrap: cs.flexWrap === 'wrap' || cs.flexWrap === 'wrap-reverse',
      gap: round(mode === 'HORIZONTAL' ? colGap : rowGap),
      counterGap: round(mode === 'HORIZONTAL' ? rowGap : colGap),
      padTop: round(parseFloat(cs.paddingTop) || 0),
      padRight: round(parseFloat(cs.paddingRight) || 0),
      padBottom: round(parseFloat(cs.paddingBottom) || 0),
      padLeft: round(parseFloat(cs.paddingLeft) || 0),
      primary: PRIMARY_ALIGN[cs.justifyContent] || 'MIN',
      counter: COUNTER_ALIGN[cs.alignItems] || 'MIN'
    };
  }

  function letterSpacingPx(cs) {
    var ls = cs.letterSpacing;
    if (!ls || ls === 'normal') return 0;
    var n = parseFloat(ls);
    return isNaN(n) ? 0 : n;
  }

  function textAlign(cs) {
    switch (cs.textAlign) {
      case 'center': return 'CENTER';
      case 'right': case 'end': return 'RIGHT';
      case 'justify': return 'JUSTIFIED';
      default: return 'LEFT';
    }
  }

  function textCaseOf(cs) {
    switch (cs.textTransform) {
      case 'uppercase': return 'UPPER';
      case 'lowercase': return 'LOWER';
      case 'capitalize': return 'TITLE';
      default: return 'ORIGINAL';
    }
  }

  function textDecoOf(cs) {
    var d = cs.textDecorationLine || cs.textDecoration || '';
    if (d.indexOf('underline') >= 0) return 'UNDERLINE';
    if (d.indexOf('line-through') >= 0) return 'STRIKETHROUGH';
    return 'NONE';
  }

  /**
   * Collect styled runs so a heading like "Build <span>faster</span>" keeps its
   * accent colour instead of flattening to one fill.
   */
  function collectRuns(el, rootCs) {
    var runs = [];
    var chars = 0;
    (function walk(node, cs) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var n = node.childNodes[i];
        if (n.nodeType === 3) {
          var t = n.nodeValue;
          if (!t) continue;
          runs.push({
            start: chars,
            end: chars + t.length,
            color: solid(parseColor(cs.color)),
            weight: fontWeight(cs),
            italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
            families: familyStack(cs),
            size: parseFloat(cs.fontSize),
            decoration: textDecoOf(cs)
          });
          chars += t.length;
        } else if (n.nodeType === 1) {
          var ncs = getComputedStyle(n);
          if (ncs.display === 'none') continue;
          walk(n, ncs);
        }
      }
    })(el, rootCs);
    return runs;
  }

  var ICON_FAMILY = /(icon|material|fontawesome|font awesome|glyphicon|ionicons|feather|remix)/i;

  /**
   * Icon fonts draw shapes from codepoints in the Unicode Private Use Area.
   * Figma can only render them if that exact font is installed locally, and it
   * usually is not — the user gets tofu. Detect the case so the server can crop
   * the glyph out of the screenshot instead.
   */
  function isIconGlyph(text, families) {
    if (!text) return false;
    var stripped = text.replace(/\s/g, '');
    if (!stripped) return false;
    if (stripped.length > 3) return false;
    for (var i = 0; i < stripped.length; i++) {
      var c = stripped.charCodeAt(i);
      if (c >= 0xE000 && c <= 0xF8FF) return true;   // Private Use Area
      if (c >= 0xF0000) return true;                 // supplementary PUA
    }
    for (var j = 0; j < (families || []).length; j++) {
      if (ICON_FAMILY.test(families[j])) return true;
    }
    return false;
  }

  function normalizeText(el) {
    // textContent preserves the raw source whitespace; the browser collapses it.
    // Mirror the collapse so Figma wraps the same way.
    var cs = getComputedStyle(el);
    var raw = el.textContent || '';
    if (cs.whiteSpace === 'pre' || cs.whiteSpace === 'pre-wrap' || cs.whiteSpace === 'break-spaces') return raw;
    return raw.replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------------------------
  // Backgrounds / images
  // ---------------------------------------------------------------------------
  function backgroundImageUrls(cs, w, h) {
    var bi = cs.backgroundImage;
    if (!bi || bi === 'none') return [];
    var out = [];
    var parts = splitTopLevel(bi);
    for (var i = 0; i < parts.length; i++) {
      var m = /url\((['"]?)(.*?)\1\)/.exec(parts[i]);
      if (m) out.push({ kind: 'url', url: m[2] });
      else {
        var g = parseGradient(parts[i], w, h);
        if (g) out.push({ kind: 'gradient', paint: g });
      }
    }
    return out;
  }

  function scaleModeFrom(objectFit, backgroundSize) {
    var v = objectFit || backgroundSize || '';
    if (v.indexOf('contain') >= 0) return 'FIT';
    if (v.indexOf('cover') >= 0) return 'FILL';
    if (v.indexOf('fill') >= 0) return 'FILL';
    if (v.indexOf('none') >= 0) return 'CROP';
    if (v.indexOf('repeat') >= 0) return 'TILE';
    return 'FILL';
  }

  // ---------------------------------------------------------------------------
  // Border radius / borders
  // ---------------------------------------------------------------------------
  function radiusValue(v, w, h) {
    if (!v) return 0;
    var parts = v.split(' ');
    var a = parts[0];
    var n;
    if (a.indexOf('%') >= 0) n = parseFloat(a) / 100 * Math.min(w, h);
    else n = parseFloat(a);
    if (isNaN(n)) return 0;
    return Math.min(n, Math.min(w, h) / 2);
  }

  function borders(cs) {
    var sides = ['Top', 'Right', 'Bottom', 'Left'];
    var out = {};
    var any = false;
    for (var i = 0; i < 4; i++) {
      var s = sides[i];
      var w = parseFloat(cs['border' + s + 'Width']) || 0;
      var style = cs['border' + s + 'Style'];
      if (w > 0 && style !== 'none' && style !== 'hidden') {
        var c = parseColor(cs['border' + s + 'Color']);
        if (c && c.a > 0.01) {
          out[s.toLowerCase()] = { weight: w, color: c, style: style };
          any = true;
        }
      }
    }
    return any ? out : null;
  }

  // ---------------------------------------------------------------------------
  // SVG
  // ---------------------------------------------------------------------------
  var SVG_PAINT = [
    'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'stroke-miterlimit',
    'fill-opacity', 'fill-rule', 'opacity'
  ];

  /** Copy computed paint from each source node onto its clone, depth-first. */
  function inlineSvgPaint(src, dst) {
    try {
      var scs = getComputedStyle(src);
      for (var i = 0; i < SVG_PAINT.length; i++) {
        var prop = SVG_PAINT[i];
        var v = scs.getPropertyValue(prop);
        if (!v || v === 'auto') continue;
        // SVG attributes take bare numbers; computed lengths come back as px.
        if (prop === 'stroke-width' || prop === 'stroke-dashoffset') v = v.replace(/px/g, '');
        if (prop === 'stroke-dasharray') v = v.replace(/px/g, '');
        dst.setAttribute(prop, v);
      }
      dst.removeAttribute('class');
      dst.removeAttribute('style');
    } catch (e) { /* non-fatal: keep whatever markup we have */ }
    var sk = src.children || [], dk = dst.children || [];
    for (var j = 0; j < sk.length && j < dk.length; j++) inlineSvgPaint(sk[j], dk[j]);
  }

  function svgMarkup(el, rect) {
    var clone = el.cloneNode(true);
    clone.removeAttribute('class');
    if (!clone.getAttribute('viewBox')) {
      var w = el.getAttribute('width'), h = el.getAttribute('height');
      if (w && h) clone.setAttribute('viewBox', '0 0 ' + parseFloat(w) + ' ' + parseFloat(h));
    }
    clone.setAttribute('width', Math.max(1, Math.round(rect.width)));
    clone.setAttribute('height', Math.max(1, Math.round(rect.height)));
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    // Paint usually lives in a stylesheet, and Figma's createNodeFromSvg only
    // sees the markup. Without this, line-art icons arrive with no stroke and
    // the SVG default fill, so they render as solid black blobs.
    inlineSvgPaint(el, clone);

    // currentColor doesn't survive outside the document; bake it in.
    var cs = getComputedStyle(el);
    var html = clone.outerHTML.replace(/currentColor/g, cs.color);
    return html;
  }

  // ---------------------------------------------------------------------------
  // Main walk
  // ---------------------------------------------------------------------------
  W2F.serialize = function (options) {
    options = options || {};
    var maxNodes = options.maxNodes || 12000;
    var minSize = options.minSize === undefined ? 1 : options.minSize;

    var warnings = [];
    var assets = Object.create(null);   // url -> true
    var fonts = Object.create(null);    // "family|weight|italic" -> true
    var overlays = [];                  // position:fixed nodes, kept once
    var count = 0;

    function noteFont(families, weight, italic) {
      if (!families.length) return;
      fonts[families.join(',') + '|' + weight + '|' + (italic ? 1 : 0)] = true;
    }

    /**
     * Pixels a <video> or <canvas> is currently displaying, as a data URL.
     * Returns null when the element is cross-origin — reading a tainted canvas
     * throws — and the caller falls back to the poster or a placeholder.
     */
    function mediaFrame(el, tag, rect) {
      try {
        if (tag === 'CANVAS') return el.toDataURL('image/png');
        if (!el.videoWidth || !el.videoHeight) return null;
        var w = Math.max(1, Math.min(2048, Math.round(rect.width || el.videoWidth)));
        var h = Math.max(1, Math.min(2048, Math.round(rect.height || el.videoHeight)));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        // drawImage reads raw decoded pixels and ignores any CSS filter on the
        // element, so a blurred/dimmed hero video would come through sharp and
        // bright. Canvas 2D takes the same filter syntax — replay it.
        var fx = getComputedStyle(el).filter;
        if (fx && fx !== 'none') { try { ctx.filter = fx; } catch (e) {} }
        ctx.drawImage(el, 0, 0, w, h);
        return c.toDataURL('image/jpeg', 0.92); // video is photographic; JPEG keeps it under the data-URL cap
      } catch (e) { return null; }
    }

    function noteAsset(url) {
      if (!url) return null;
      if (url.indexOf('data:') === 0 && url.length > 2 * 1024 * 1024) return null;
      try { url = new URL(url, document.baseURI).href; } catch (e) { return null; }
      assets[url] = true;
      return url;
    }

    function build(el, depth) {
      if (count > maxNodes) return null;

      var cs = getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      if (!isRendered(el, cs, rect)) return null;

      var tag = el.tagName;
      var node = {
        type: 'FRAME',
        tag: tag.toLowerCase(),
        name: nameFor(el, tag),
        x: round(rect.left),
        y: round(rect.top),
        w: round(rect.width),
        h: round(rect.height),
        children: []
      };

      var layout = readLayout(el, cs);
      if (layout) node.layout = layout;

      // How this element behaves *inside* its parent's layout. Read here
      // because only the element itself knows; the parent sees a box.
      if (cs.position === 'absolute') node.absolute = true;
      var grow = parseFloat(cs.flexGrow);
      if (!isNaN(grow) && grow > 0) node.grow = true;
      if (cs.alignSelf === 'stretch') node.stretch = true;

      var opacity = parseFloat(cs.opacity);
      if (!isNaN(opacity) && opacity < 1) node.opacity = round(opacity);

      var rot = rotationOf(cs.transform);
      if (rot) {
        node.rotation = round(-rot); // Figma rotates counter-clockwise
        // getBoundingClientRect gives the axis-aligned bbox of a rotated box;
        // fall back to the layout box so the rotation reads correctly.
        node.w = round(el.offsetWidth || rect.width);
        node.h = round(el.offsetHeight || rect.height);
      }

      // ---- fills -------------------------------------------------------------
      var fills = [];
      var bg = parseColor(cs.backgroundColor);
      if (bg && bg.a > 0.004) fills.push(solid(bg));

      var bgImages = backgroundImageUrls(cs, rect.width, rect.height);
      // CSS paints the first background layer on top; Figma paints the last fill
      // on top, so reverse.
      for (var bi = bgImages.length - 1; bi >= 0; bi--) {
        var layer = bgImages[bi];
        if (layer.kind === 'gradient') fills.push(layer.paint);
        else {
          var u = noteAsset(layer.url);
          if (u) {
            fills.push({
              type: 'IMAGE',
              assetUrl: u,
              scaleMode: scaleModeFrom(null, cs.backgroundSize),
              backgroundPosition: cs.backgroundPosition,
              backgroundRepeat: cs.backgroundRepeat
            });
          }
        }
      }
      if (fills.length) node.fills = fills.filter(Boolean);

      // ---- strokes / radius / shadows ---------------------------------------
      var b = borders(cs);
      if (b) node.borders = b;

      var tl = radiusValue(cs.borderTopLeftRadius, rect.width, rect.height);
      var tr = radiusValue(cs.borderTopRightRadius, rect.width, rect.height);
      var br = radiusValue(cs.borderBottomRightRadius, rect.width, rect.height);
      var bl = radiusValue(cs.borderBottomLeftRadius, rect.width, rect.height);
      if (tl || tr || br || bl) node.radius = [round(tl), round(tr), round(br), round(bl)];

      var sh = parseShadows(cs.boxShadow);
      if (sh.length) node.shadows = sh;

      var lb = blurRadius(cs.filter);
      if (lb > 0) node.blur = lb;
      var bb = blurRadius(cs.backdropFilter || cs.webkitBackdropFilter);
      if (bb > 0) node.backdropBlur = bb;
      var bm = blendModeOf(cs);
      if (bm) node.blendMode = bm;

      var cpShape = clipPathShape(cs, rect);
      if (cpShape) node.clipShape = cpShape;

      if (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden' ||
          cs.overflow === 'clip' || cs.overflow === 'auto' || cs.overflow === 'scroll') {
        node.clip = true;
      }

      node.zIndex = cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex, 10) || 0);
      var isFixed = cs.position === 'fixed';

      count++;

      // ---- leaf types --------------------------------------------------------
      if (tag === 'IMG' || tag === 'IMAGE') {
        var src = el.currentSrc || el.src;
        var u2 = noteAsset(src);
        if (u2) {
          node.type = 'IMAGE';
          node.image = {
            assetUrl: u2,
            naturalWidth: el.naturalWidth || 0,
            naturalHeight: el.naturalHeight || 0,
            scaleMode: scaleModeFrom(cs.objectFit, null),
            objectPosition: cs.objectPosition,
            alt: el.getAttribute('alt') || ''
          };
          node.name = node.image.alt ? 'Image · ' + node.image.alt.slice(0, 40) : nameFromUrl(u2);
        }
        return finish(node, isFixed);
      }

      if (tag === 'SVG' || tag === 'svg') {
        node.type = 'SVG';
        try { node.svg = svgMarkup(el, rect); } catch (e) { warnings.push('svg-serialize-failed'); }
        node.name = el.getAttribute('aria-label') || el.getAttribute('data-icon') || 'Icon';
        return finish(node, isFixed);
      }

      if (tag === 'CANVAS' || tag === 'VIDEO' || tag === 'IFRAME') {
        node.name = tag.toLowerCase() + ' (placeholder)';

        // A poster is not what the page is showing — the video has been frozen
        // at frame 0 by now, so read the pixels on screen. Same for canvas,
        // whose contents are otherwise lost entirely (charts, WebGL, signatures).
        // The full-page screenshot already contains the rendered iframe, whatever
        // its origin, so the server crops that region out and uses it as an image.
        if (tag === 'IFRAME') node.rasterize = 'iframe';

        if (tag === 'VIDEO' || tag === 'CANVAS') {
          var frame = mediaFrame(el, tag, rect);
          if (!frame && tag === 'VIDEO') frame = el.getAttribute('poster');
          var fa = frame ? noteAsset(frame) : null;
          if (fa) {
            node.type = 'IMAGE';
            node.name = tag.toLowerCase() === 'video' ? 'video (frame)' : 'canvas';
            node.image = { assetUrl: fa, scaleMode: 'FILL', objectPosition: '50% 50%' };
          }
        }
        return finish(node, isFixed);
      }

      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        var val = el.value || el.getAttribute('placeholder') || '';
        if (val) {
          node.children.push(makeTextNode(el, cs, rect, val, true));
        }
        return finish(node, isFixed);
      }

      // ---- text --------------------------------------------------------------
      if (isTextBlock(el)) {
        var content = normalizeText(el);
        if (content) {
          var t = makeTextNode(el, cs, rect, content, false);
          if (t) {
            // Keep the box (it may have a background) and nest the text, unless
            // the box paints nothing — then become the text node outright.
            if (!node.fills && !node.borders && !node.shadows && !node.radius) {
              t.zIndex = node.zIndex;
              t.rotation = node.rotation;
              t.opacity = node.opacity;
              return finish(t, isFixed);
            }
            node.children.push(t);
            return finish(node, isFixed);
          }
        }
      }

      // ---- pseudo-elements (best effort) ------------------------------------
      var marker = listMarker(el, cs, rect);
      if (marker) node.children.push(marker);

      var pseudo = pseudoNodes(el, rect, cs);
      for (var pi = 0; pi < pseudo.length; pi++) node.children.push(pseudo[pi]);

      // ---- recurse -----------------------------------------------------------
      var kids = el.children;
      var built = [];
      for (var i = 0; i < kids.length; i++) {
        var childNode = build(kids[i], depth + 1);
        if (childNode) built.push(childNode);
      }

      // Loose text mixed with element children (e.g. "Hello <b>x</b> world" in a
      // div that also holds a section) — capture the stray text nodes.
      if (hasDirectText(el) && kids.length) {
        var stray = strayTextNodes(el, cs);
        for (var s = 0; s < stray.length; s++) built.push(stray[s]);
      }

      // Paint order: DOM order, but positioned elements respect z-index.
      built.forEach(function (n, idx) { n.__i = idx; });
      built.sort(function (a, c) {
        if (a.zIndex !== c.zIndex) return a.zIndex - c.zIndex;
        return a.__i - c.__i;
      });
      built.forEach(function (n) { delete n.__i; });

      node.children = node.children.concat(built);
      return finish(node, isFixed);
    }

    function finish(node, isFixed) {
      if (isFixed) {
        node.fixed = true;
        overlays.push(node);
        return null; // hoisted to the top level, drawn once
      }
      return node;
    }

    function placeholderShowing(el) {
      return !el.value && !!(el.getAttribute && el.getAttribute('placeholder'));
    }

    /**
     * An <input>'s value lives in shadow DOM, so a Range over the element
     * measures nothing and the whole element box — border and padding included —
     * ends up as the text box. The text then sits flush against the field's top
     * edge instead of where the browser draws it, a padding's worth too high in
     * every field on the page. Derive the line box from the content box instead:
     * single-line fields centre their text in it, textareas flow from its top.
     */
    function formFieldBox(el, cs, rect, content) {
      var size = parseFloat(cs.fontSize) || 16;
      var lh = lineHeightPx(cs) || round(size * 1.2);
      var bT = parseFloat(cs.borderTopWidth) || 0;
      var bB = parseFloat(cs.borderBottomWidth) || 0;
      var pT = parseFloat(cs.paddingTop) || 0;
      var pB = parseFloat(cs.paddingBottom) || 0;
      var innerTop = rect.top + bT + pT;
      var innerH = rect.height - bT - bB - pT - pB;
      if (!(innerH > 0) || !(lh > 0)) return null;

      if (el.tagName === 'TEXTAREA') {
        var bL = parseFloat(cs.borderLeftWidth) || 0;
        var bR = parseFloat(cs.borderRightWidth) || 0;
        var pL = parseFloat(cs.paddingLeft) || 0;
        var pR = parseFloat(cs.paddingRight) || 0;
        var innerW = rect.width - bL - bR - pL - pR;
        var lines = 1;
        if (innerW > 0) {
          var w = textWidth(cs, content);
          if (w > innerW) lines = Math.min(Math.ceil(w / innerW), Math.max(1, Math.floor(innerH / lh)));
        }
        return { top: innerTop, height: Math.min(innerH, lh * lines), lineHeight: lh, lines: lines };
      }

      return {
        top: innerTop + Math.max(0, (innerH - lh) / 2),
        height: lh,
        lineHeight: lh,
        lines: 1
      };
    }

    function makeTextNode(el, cs, rect, content, isFormField) {
      var families = familyStack(cs);
      var weight = fontWeight(cs);
      var italic = cs.fontStyle === 'italic' || cs.fontStyle === 'oblique';
      noteFont(families, weight, italic);

      // Tight vertical box from the text range; horizontal box from the content
      // box so alignment (centre/right) survives.
      var top = rect.top, height = rect.height;
      var lineMetrics = null;
      var formBox = isFormField ? formFieldBox(el, cs, rect, content) : null;

      if (!formBox) {
        try {
          var range = document.createRange();
          range.selectNodeContents(el);
          var rr = range.getBoundingClientRect();
          if (rr && rr.height > 0) { top = rr.top; height = rr.height; }
          lineMetrics = measureLineMetrics(range, rr);
          range.detach && range.detach();
        } catch (e) { /* keep element box */ }
      }

      var lineHeight = resolveLineHeight(cs, lineMetrics);
      var lineBox = alignToLineBox(top, height, lineHeight, lineMetrics);
      top = lineBox.top; height = lineBox.height;

      if (formBox) {
        top = formBox.top;
        height = formBox.height;
        lineHeight = formBox.lineHeight;
      }

      // A field showing its placeholder is not painted in the field's text
      // colour — ::placeholder is, and it is usually several shades lighter.
      // Reading cs.color puts near-black where the site shows grey, which is
      // the single most visible way an imported form stops looking like itself.
      var paintColor = cs.color;
      if (isFormField && placeholderShowing(el)) {
        try {
          var ph = getComputedStyle(el, '::placeholder');
          if (ph && ph.color) {
            paintColor = ph.color;
            var phOpacity = parseFloat(ph.opacity);
            if (!isNaN(phOpacity) && phOpacity < 1) {
              var pc = parseColor(paintColor);
              if (pc) pc.a = (pc.a === undefined ? 1 : pc.a) * phOpacity;
              paintColor = pc || paintColor;
            }
          }
        } catch (e) { /* no pseudo style — keep the field colour */ }
      }

      var padL = parseFloat(cs.paddingLeft) || 0;
      var padR = parseFloat(cs.paddingRight) || 0;
      var bL = parseFloat(cs.borderLeftWidth) || 0;
      var bR = parseFloat(cs.borderRightWidth) || 0;

      var isInlineBox = cs.display === 'inline';
      var x = isInlineBox ? rect.left : rect.left + bL + padL;
      var w = isInlineBox ? rect.width : rect.width - bL - bR - padL - padR;
      if (w <= 0) w = rect.width;

      var runs = isFormField ? [] : collectRuns(el, cs);
      if (runs.length <= 1) runs = [];

      return {
        type: 'TEXT',
        tag: el.tagName.toLowerCase(),
        name: content.slice(0, 48),
        x: round(x),
        // top/height have already been shifted onto the line box grid by
        // alignToLineBox, which is the origin Figma positions text from.
        y: round(top),
        w: round(w + 0.5),
        h: round(height),
        text: {
          characters: content,
          families: families,
          weight: weight,
          italic: italic,
          size: round(parseFloat(cs.fontSize)),
          lineHeight: lineHeight,
          // How many lines the browser actually used. Single-line text must
          // never be allowed to re-wrap in Figma.
          lines: lineMetrics ? lineMetrics.lines : (formBox ? formBox.lines : 1),
          letterSpacing: round(letterSpacingPx(cs)),
          align: textAlign(cs),
          case: textCaseOf(cs),
          decoration: textDecoOf(cs),
          shadows: parseShadows(cs.textShadow),
          icon: isIconGlyph(content, families) || undefined,
          color: solid(typeof paintColor === 'string' ? parseColor(paintColor) : paintColor) ||
            { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 },
          runs: runs
        },
        zIndex: 0,
        children: []
      };
    }

    /**
     * ::marker is not reachable through the DOM and carries no box we can
     * measure, so bullets and numbers vanish entirely. Reconstruct one from the
     * list item's own type and metrics, positioned in the indent to its left.
     */
    function listMarker(el, cs, rect) {
      try {
        if (el.tagName !== 'LI') return null;
        var listStyle = cs.listStyleType;
        if (!listStyle || listStyle === 'none') return null;
        if (cs.listStylePosition === 'inside') return null; // already in the text flow

        var glyph;
        if (listStyle === 'decimal' || listStyle === 'decimal-leading-zero') {
          var idx = 1, sib = el;
          while ((sib = sib.previousElementSibling)) { if (sib.tagName === 'LI') idx++; }
          var ol = el.parentElement;
          if (ol && ol.hasAttribute('start')) idx += (parseInt(ol.getAttribute('start'), 10) || 1) - 1;
          glyph = idx + '.';
        } else if (listStyle === 'circle') glyph = '\u25E6';
        else if (listStyle === 'square') glyph = '\u25AA';
        else glyph = '\u2022';

        var size = parseFloat(cs.fontSize) || 16;
        var families = familyStack(cs);
        noteFont(families, fontWeight(cs), false);
        var lh = lineHeightPx(cs) || size * 1.2;
        var gw = size * (glyph.length > 1 ? 0.62 * glyph.length : 0.62);
        return {
          type: 'TEXT',
          tag: '::marker',
          name: glyph,
          x: round(rect.left - gw - size * 0.35),
          y: round(rect.top),
          w: round(gw + 2),
          h: round(lh),
          approx: true,
          text: {
            characters: glyph,
            families: families,
            weight: fontWeight(cs),
            italic: false,
            size: round(size),
            lineHeight: round(lh),
            lines: 1,
            letterSpacing: 0,
            align: 'RIGHT',
            case: 'ORIGINAL',
            decoration: 'NONE',
            color: solid(parseColor(cs.color)) || { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 },
            runs: []
          },
          zIndex: 0,
          children: []
        };
      } catch (e) { return null; }
    }

    function strayTextNodes(el, cs) {
      var out = [];
      // Wrap width for fragments that span more than one line. The range box is
      // only as wide as the widest line it happened to produce, so handing that
      // to Figma re-wraps the text against a box exactly as wide as its longest
      // line — any 1px shaper difference then flips a word onto another line and
      // the heading falls apart. The browser wrapped against the content box, so
      // that is the constraint to pass on.
      var hostRect = el.getBoundingClientRect();
      var hostL = hostRect.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      var hostW = hostRect.width
        - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0)
        - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      if (!(hostW > 0)) hostW = hostRect.width;
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType !== 3) continue;
        var txt = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        var range = document.createRange();
        range.selectNode(n);
        var rr = range.getBoundingClientRect();
        if (!rr || rr.width <= 0 || rr.height <= 0) continue;
        var strayMetrics = measureLineMetrics(range, rr);
        var strayLH = resolveLineHeight(cs, strayMetrics);
        var strayBox = alignToLineBox(rr.top, rr.height, strayLH, strayMetrics);
        var wraps = !!(strayMetrics && strayMetrics.lines > 1);
        var families = familyStack(cs);
        noteFont(families, fontWeight(cs), cs.fontStyle === 'italic');
        out.push({
          type: 'TEXT',
          tag: '#text',
          name: txt.slice(0, 48),
          x: round(wraps ? hostL : rr.left),
          y: round(strayBox.top),
          w: round(wraps ? hostW : rr.width + 1),
          h: round(strayBox.height),
          text: {
            characters: txt,
            families: families,
            weight: fontWeight(cs),
            italic: cs.fontStyle === 'italic',
            size: round(parseFloat(cs.fontSize)),
            lineHeight: strayLH,
            lines: strayMetrics ? strayMetrics.lines : 1,
            letterSpacing: round(letterSpacingPx(cs)),
            align: textAlign(cs),
            case: textCaseOf(cs),
            decoration: textDecoOf(cs),
            color: solid(parseColor(cs.color)) || { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 },
            runs: []
          },
          zIndex: 0,
          children: []
        });
      }
      return out;
    }

    /**
     * ::before / ::after carry real visuals constantly (dividers, dots, icons,
     * gradient overlays). We can't measure them, so we approximate: overlays get
     * the parent's padding box, text gets the parent's box.
     */
    function pseudoNodes(el, rect, cs) {
      var out = [];
      ['::before', '::after'].forEach(function (which) {
        var pcs;
        try { pcs = getComputedStyle(el, which); } catch (e) { return; }
        if (!pcs) return;
        var content = pcs.content;
        if (!content || content === 'none' || content === 'normal') return;
        if (pcs.display === 'none' || parseFloat(pcs.opacity) === 0) return;

        // Size first: the gradient on this pseudo has to be built against the
        // pseudo's own box, not the host's.
        var pw = parseFloat(pcs.width);
        var ph = parseFloat(pcs.height);
        var boxW = (isNaN(pw) || pw <= 0) ? rect.width : pw;
        var boxH = (isNaN(ph) || ph <= 0) ? rect.height : ph;

        var bgc = parseColor(pcs.backgroundColor);
        var hasBg = bgc && bgc.a > 0.02;
        var bgImgs = backgroundImageUrls(pcs, boxW, boxH);
        var strText = /^["'](.*)["']$/.exec(content);
        var txt = strText ? strText[1] : '';

        if (!hasBg && !bgImgs.length && !txt) return;

        // Position. A decorative blob is nearly always absolutely positioned
        // against its host; drawing it at the host's origin — which is what
        // "no measurable box" used to mean here — is why an oversized one
        // spills out the right and bottom instead of sitting where CSS put it.
        // Chromium resolves left/top/right/bottom to used pixels for a
        // positioned box, so these are real numbers, not percentages.
        var boxX = rect.left, boxY = rect.top;
        if (pcs.position === 'fixed') {
          // A fixed box is positioned against the viewport, not the host. The
          // page is scrolled to the top by the time we serialise, so viewport
          // coordinates are document coordinates. Adding these to the host's
          // box instead throws the node a whole scroll offset away — on a very
          // long page, tens of thousands of pixels.
          var fL = parseFloat(pcs.left), fT = parseFloat(pcs.top);
          var fR = parseFloat(pcs.right), fB = parseFloat(pcs.bottom);
          var vw = window.innerWidth, vh = window.innerHeight;
          if (!isNaN(fL)) boxX = fL;
          else if (!isNaN(fR)) boxX = vw - fR - boxW;
          if (!isNaN(fT)) boxY = fT;
          else if (!isNaN(fB)) boxY = vh - fB - boxH;
        } else if (pcs.position === 'absolute') {
          var bl = parseFloat(cs.borderLeftWidth) || 0;
          var bt = parseFloat(cs.borderTopWidth) || 0;
          var br = parseFloat(cs.borderRightWidth) || 0;
          var bb = parseFloat(cs.borderBottomWidth) || 0;
          var cbL = rect.left + bl, cbT = rect.top + bt;
          var cbW = rect.width - bl - br, cbH = rect.height - bt - bb;
          var iL = parseFloat(pcs.left), iR = parseFloat(pcs.right);
          var iT = parseFloat(pcs.top), iB = parseFloat(pcs.bottom);
          if (!isNaN(iL)) boxX = cbL + iL;
          else if (!isNaN(iR)) boxX = cbL + cbW - iR - boxW;
          if (!isNaN(iT)) boxY = cbT + iT;
          else if (!isNaN(iB)) boxY = cbT + cbH - iB - boxH;
        }
        // translate() is how a blob gets centred on its host.
        var shift = translationOf(pcs.transform);
        boxX += shift.x;
        boxY += shift.y;

        // Last line of defence. A pseudo-element has no box we can read back,
        // so if the arithmetic lands somewhere absurd there is nothing to catch
        // it downstream — and one node thrown far off the page stretches the
        // whole frame around it. Anything implausible falls back to the host,
        // which is where this code used to put everything anyway.
        var slack = Math.max(2000, rect.width * 4, rect.height * 4);
        if (!isFinite(boxX) || !isFinite(boxY) ||
            Math.abs(boxX - rect.left) > slack || Math.abs(boxY - rect.top) > slack) {
          boxX = rect.left;
          boxY = rect.top;
        }

        var node = {
          type: 'FRAME',
          tag: which,
          name: el.tagName.toLowerCase() + which,
          x: round(boxX),
          y: round(boxY),
          w: round(boxW),
          h: round(boxH),
          approx: true,
          zIndex: parseInt(pcs.zIndex, 10) || 0,
          children: []
        };
        var fills = [];
        if (hasBg) fills.push(solid(bgc));
        for (var i = bgImgs.length - 1; i >= 0; i--) {
          if (bgImgs[i].kind === 'gradient') fills.push(bgImgs[i].paint);
          else {
            var u = noteAsset(bgImgs[i].url);
            if (u) fills.push({ type: 'IMAGE', assetUrl: u, scaleMode: scaleModeFrom(null, pcs.backgroundSize), backgroundPosition: pcs.backgroundPosition });
          }
        }
        if (fills.length) node.fills = fills.filter(Boolean);
        var prad = radiusValue(pcs.borderTopLeftRadius, node.w, node.h);
        if (prad) node.radius = [prad, prad, prad, prad];
        if (txt) {
          var families = familyStack(pcs);
          noteFont(families, fontWeight(pcs), false);
          node.children.push({
            type: 'TEXT', tag: which, name: txt.slice(0, 30),
            x: node.x, y: node.y, w: node.w, h: node.h,
            text: {
              characters: txt, families: families, weight: fontWeight(pcs),
              italic: false, size: round(parseFloat(pcs.fontSize)),
              lineHeight: lineHeightPx(pcs), letterSpacing: round(letterSpacingPx(pcs)),
              align: textAlign(pcs), case: textCaseOf(pcs), decoration: 'NONE',
              color: solid(parseColor(pcs.color)) || { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 },
              runs: []
            },
            zIndex: 0, children: []
          });
        }
        out.push(node);
      });
      return out;
    }

    function nameFor(el, tag) {
      var id = el.id ? '#' + el.id : '';
      var cls = '';
      if (typeof el.className === 'string' && el.className.trim()) {
        // Utility-class soup makes useless layer names; keep it short.
        var first = el.className.trim().split(/\s+/).filter(function (c) {
          return c.length > 2 && !/^(flex|grid|w-|h-|p[xytblr]?-|m[xytblr]?-|text-|bg-|border|rounded|gap-|items-|justify-)/.test(c);
        })[0];
        if (first) cls = '.' + first;
      }
      var semantic = { HEADER: 'Header', FOOTER: 'Footer', NAV: 'Nav', MAIN: 'Main', SECTION: 'Section', ARTICLE: 'Article', ASIDE: 'Aside', BUTTON: 'Button', A: 'Link', UL: 'List', OL: 'List', LI: 'List item', FORM: 'Form' };
      var base = semantic[tag] || tag.toLowerCase();
      return (base + (id || cls)).slice(0, 60);
    }

    function nameFromUrl(u) {
      try {
        var p = new URL(u).pathname.split('/').pop();
        return (p || 'Image').slice(0, 40);
      } catch (e) { return 'Image'; }
    }

    // -------------------------------------------------------------------------
    // Simplification: collapse the wrapper divs that make the layer tree
    // unusable. This is the single biggest lever on output quality.
    // -------------------------------------------------------------------------
    function paintsSomething(n) {
      return !!(n.fills && n.fills.length) || !!n.borders || !!n.shadows ||
        (n.radius && n.radius.some(function (r) { return r > 0; })) ||
        n.clip || n.rotation || (n.opacity !== undefined && n.opacity < 1);
    }

    function simplify(n) {
      if (!n) return null;
      if (n.children && n.children.length) {
        var kept = [];
        for (var i = 0; i < n.children.length; i++) {
          var c = simplify(n.children[i]);
          if (c) kept.push(c);
        }
        n.children = kept;
      }

      if (n.type === 'TEXT' || n.type === 'IMAGE' || n.type === 'SVG') return n;

      // Empty, invisible box → drop.
      if (!n.children.length && !paintsSomething(n)) return null;

      // Transparent single-child wrapper of the same size → collapse.
      if (n.children.length === 1 && !paintsSomething(n) && !n.fixed) {
        var only = n.children[0];
        if (Math.abs(only.x - n.x) < 1.5 && Math.abs(only.y - n.y) < 1.5 &&
            Math.abs(only.w - n.w) < 1.5 && Math.abs(only.h - n.h) < 1.5) {
          return only;
        }
      }
      return n;
    }

    // -------------------------------------------------------------------------
    var docEl = document.documentElement;
    var bodyCs = getComputedStyle(document.body);
    var htmlCs = getComputedStyle(docEl);

    var fullW = Math.max(docEl.scrollWidth, window.innerWidth);
    var fullH = Math.max(docEl.scrollHeight, document.body.scrollHeight, window.innerHeight);

    // rootSelector lets a caller serialise one subtree instead of the page —
    // used to capture each tab panel as its own variant without re-walking the
    // whole document.
    var rootEl = document.body;
    var subtree = false;
    if (options.rootSelector) {
      var picked = document.querySelector(options.rootSelector);
      if (picked) { rootEl = picked; subtree = true; }
      else warnings.push('rootSelector matched nothing: ' + options.rootSelector);
    }

    // Serialising one section of a 242,000px page should produce a frame the
    // size of that section, not of the page it was cut from. The subtree's own
    // box is the frame; its offset is subtracted on the way out so the section
    // starts at the origin.
    var originX = 0, originY = 0;
    if (subtree) {
      var box = rootEl.getBoundingClientRect();
      originX = box.left + window.scrollX;
      originY = box.top + window.scrollY;
      fullW = Math.max(1, Math.round(box.width));
      fullH = Math.max(1, Math.round(box.height));
    }
    var tree = build(rootEl, 0);
    tree = simplify(tree);

    var cleanedOverlays = overlays.map(simplify).filter(Boolean);

    if (subtree && (originX || originY)) {
      (function rebase(n) {
        if (!n) return;
        n.x = round(n.x - originX);
        n.y = round(n.y - originY);
        (n.children || []).forEach(rebase);
      })(tree);
      cleanedOverlays.forEach(function rebase(n) {
        if (!n) return;
        n.x = round(n.x - originX);
        n.y = round(n.y - originY);
        (n.children || []).forEach(rebase);
      });
    }

    // Page background: html wins, else body.
    var pageBg = parseColor(htmlCs.backgroundColor);
    if (!pageBg || pageBg.a < 0.01) pageBg = parseColor(bodyCs.backgroundColor);
    if (!pageBg || pageBg.a < 0.01) pageBg = { r: 1, g: 1, b: 1, a: 1 };

    if (count > maxNodes) warnings.push('Node budget (' + maxNodes + ') hit; page was truncated.');

    return {
      meta: {
        url: location.href,
        title: document.title,
        width: fullW,
        height: fullH,
        viewportWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio,
        nodeCount: count,
        capturedAt: new Date().toISOString()
      },
      background: solid(pageBg),
      fonts: Object.keys(fonts).map(function (k) {
        var p = k.split('|');
        return { families: p[0].split(','), weight: +p[1], italic: p[2] === '1' };
      }),
      assets: Object.keys(assets),
      warnings: warnings,
      root: tree,
      overlays: cleanedOverlays
    };
  };
})();
