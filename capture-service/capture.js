'use strict';

const fs = require('fs');
const path = require('path');
const { devices } = require('playwright-core');
const { getBrowser, closeBrowser, onVercel } = require('./browser');

// Clicking through tabs and accordions is open-ended work — a page with six
// state groups of eight options each is 48 serialisations. Hosted, the function
// is killed at 300s and returns nothing at all, so cap the state pass well
// short of that and hand back the page plus whatever states did finish.
const STATE_BUDGET_MS = onVercel ? 90000 : 240000;

const SERIALIZER = fs.readFileSync(path.join(__dirname, 'serializer.js'), 'utf8');
const { discoverGroups, captureStates } = require('./states');

// Launching lives in browser.js — the flags a hosted Chromium needs are not the
// flags a local one needs, and only the hide-scrollbars rule is ours.

/**
 * CSS injected before the page paints.
 *  - Animations are fast-forwarded to their final keyframe rather than paused,
 *    so scroll-reveal content lands visible instead of at opacity 0.
 *  - Transitions are killed outright.
 *  - Carets, scrollbars and smooth scrolling are removed.
 */
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-delay: 0s !important;
    animation-duration: 0.001s !important;
    animation-iteration-count: 1 !important;
    animation-fill-mode: forwards !important;
    transition: none !important;
    transition-duration: 0s !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
`;

/**
 * Common scroll-reveal libraries leave elements at opacity:0 until they
 * intersect. The scroll pass usually handles it; this is the safety net.
 */
const REVEAL_CSS = `
  [data-aos], [data-scroll], [data-animate], [data-reveal],
  .aos-init, .reveal, .fade-in, .fade-up, .animate-in, .gsap-reveal,
  [class*="fade-in"], [class*="slide-up"], [class*="reveal"] {
    opacity: 1 !important;
    transform: none !important;
    visibility: visible !important;
    clip-path: none !important;
  }
`;

async function settle(page, opts) {
  const { fullSettleMs = 600, scrollStepRatio = 0.8 } = opts;

  // Fonts
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});

  // Scroll pass: triggers lazy images, IntersectionObserver reveals and
  // virtualised lists, then returns to the top so rects are document coords.
  await page.evaluate(async (ratio) => {
    const step = Math.max(200, window.innerHeight * ratio);
    const total = () => Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    // A documentation page can run to a quarter of a million pixels, which at
    // 120ms a step is forty seconds of scrolling before anything else starts.
    // Lazy content is triggered by passing over it, so on a page that long,
    // stride further rather than spend the time.
    const SCROLL_BUDGET_MS = 20000;
    const until = Date.now() + SCROLL_BUDGET_MS;
    const height = total();
    const steps = Math.ceil(height / step);
    const stride = steps > 150 ? Math.ceil(height / 150) : step;
    for (let y = 0; y < total(); y += stride) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
      if (Date.now() > until) break;
    }
    window.scrollTo(0, total());
    await new Promise((r) => setTimeout(r, 250));
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 250));
  }, scrollStepRatio).catch(() => {});

  // Force any lazy <img> to load and wait for decode.
  await page.evaluate(async () => {
    const imgs = Array.from(document.images);
    imgs.forEach((img) => {
      if (img.loading === 'lazy') img.loading = 'eager';
      if (img.dataset && img.dataset.src && !img.src) img.src = img.dataset.src;
    });
    await Promise.all(
      imgs.map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((res) => {
              img.addEventListener('load', res, { once: true });
              img.addEventListener('error', res, { once: true });
              setTimeout(res, 4000);
            })
      )
    );
  }).catch(() => {});

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(fullSettleMs);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(150);
}

/**
 * Capture one URL at one viewport width.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {number} opts.width            1440 or 390
 * @param {boolean} [opts.mobile]        emulate a touch device (auto for <768)
 * @param {number} [opts.deviceScaleFactor]
 * @param {string[]} [opts.dismissSelectors]  cookie banners etc. to click away
 * @param {boolean} [opts.screenshot]    also return a full-page PNG buffer
 * @returns {{doc: object, screenshot: Buffer|null}}
 */
async function capture(opts) {
  const {
    url,
    width,
    mobile = width < 768,
    deviceScaleFactor = width < 768 ? 3 : 2,
    dismissSelectors = [],
    screenshot = true,
    timeout = 60000,
    maxNodes = 12000,
    captureStates: wantStates = true,
    stateSelectors = [],
    rootSelector = ''
  } = opts;

  const browser = await getBrowser(['--hide-scrollbars']);

  const context = await browser.newContext({
    viewport: { width, height: mobile ? 844 : 900 },
    deviceScaleFactor,
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: mobile ? devices['iPhone 14 Pro'].userAgent : undefined,
    // Many sites honour this and skip their entrance animations entirely.
    reducedMotion: 'reduce',
    colorScheme: 'light',
    locale: 'en-US',
    bypassCSP: true
  });

  const page = await context.newPage();
  const consoleErrors = [];
  let navWarning = null;
  page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 200)));

  try {
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});

    // A navigation timeout is not the same as an empty page. Plenty of sites
    // hold a connection open forever — analytics beacons, long-polling, a video
    // that never finishes buffering — long after the content painted. Throwing
    // the run away in that case loses a capture we already had.
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (response && response.status() >= 400) {
        navWarning = `The page returned HTTP ${response.status()} — you may be capturing an error page.`;
      }
    } catch (err) {
      if (!/timeout/i.test(String((err && err.message) || err))) throw err;
      // Bounded, because on a navigation that never committed at all this
      // evaluate never settles either — which turned a clean 6s failure into
      // an indefinite hang.
      const painted = await Promise.race([
        page.evaluate(() => !!document.body && document.body.childElementCount > 0).catch(() => false),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000))
      ]);
      if (!painted) {
        throw new Error(
          `Timeout: ${url} rendered nothing within ${Math.round(timeout / 1000)}s. ` +
          'Check the URL is right and that the page does not need a login.'
        );
      }
      navWarning = `The page never finished loading; captured it as it stood after ${Math.round(timeout / 1000)}s.`;
    }

    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});

    // Dismiss consent/cookie overlays if the caller named any.
    for (const sel of dismissSelectors) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ timeout: 2000 }); await page.waitForTimeout(300); }
      } catch (e) { /* non-fatal */ }
    }

    await settle(page, opts);
    await page.addStyleTag({ content: REVEAL_CSS }).catch(() => {});
    await page.waitForTimeout(200);

    // Blur anything focused so focus rings don't get captured.
    await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur()).catch(() => {});

    // Freeze media. Serialisation and the screenshot are two separate passes;
    // a playing video advances between them, so the frame Figma gets never
    // matches the reference and the whole hero reads as a diff. Seeking to 0
    // also makes the capture reproducible across runs.
    await page.evaluate(async () => {
      // Pausing alone is not enough: sites restart playback on an interval or
      // from an IntersectionObserver, so the frame drifts again before the
      // screenshot. Neutralise play() first, then nothing can resume.
      try {
        HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
      } catch (e) { /* non-fatal */ }

      const vids = Array.from(document.querySelectorAll('video'));
      await Promise.all(vids.map((v) => new Promise((resolve) => {
        try {
          v.pause();
          v.autoplay = false;
          v.loop = false;
          v.addEventListener('play', function () { try { v.pause(); } catch (e) {} });
          // Deliberately not seeking. Pausing pins the frame that is already
          // decoded and on screen; forcing currentTime can leave the element
          // uncomposited, and the screenshot then shows the container's
          // background while the grabbed frame shows video pixels.
          resolve();
        } catch (e) { resolve(); }
      })));
    }).catch(() => {});
    await page.waitForTimeout(200);

    // Stop the clock. Serialisation and the screenshot are separate passes and a
    // full-page shot of a tall document takes seconds — long enough for a
    // timer-driven carousel, ticker or slideshow to advance, so the two passes
    // disagree and the whole region reads as a diff. Killing pending timers
    // holds the DOM still for both.
    await page.evaluate(() => {
      const maxId = window.setTimeout(() => {}, 0);
      for (let i = 0; i <= maxId; i++) { clearTimeout(i); clearInterval(i); }
      // Stash the originals: interaction capture runs after the screenshot and
      // needs working timers, because widget libraries drive panel switching
      // through them.
      window.__W2F_TIMERS__ = { setTimeout: window.setTimeout, setInterval: window.setInterval };
      window.setTimeout = function () { return 0; };
      window.setInterval = function () { return 0; };
      // requestAnimationFrame is left alone: video compositing depends on it.
    }).catch(() => {});
    await page.waitForTimeout(150);


    await page.evaluate(SERIALIZER);
    // rootSelector narrows the walk to one subtree. On a page with tens of
    // thousands of elements that is the difference between a truncated import
    // and a complete section.
    const doc = await page.evaluate(
      (o) => window.__W2F__.serialize(o),
      { maxNodes, rootSelector: rootSelector || undefined }
    );
    if (navWarning) doc.warnings = (doc.warnings || []).concat(navWarning);

    doc.meta.requestedWidth = width;
    doc.meta.mobile = mobile;
    if (consoleErrors.length) {
      doc.warnings = (doc.warnings || []).concat(
        consoleErrors.slice(0, 3).map((e) => 'Page error: ' + e)
      );
    }

    let shot = null;
    if (screenshot) {
      // Chromium tops out around 16,384px per side. Asking for a full-page shot
      // of a 243,000px document does not fail cleanly — it stalls until
      // Playwright's timeout, which the caller then reports as a page that
      // "took too long to load". Clip instead, and say so.
      const MAX_SHOT_PX = 16000;

      // A section capture's reference should be that section. Otherwise the
      // fidelity harness compares one #hero against a quarter-million-pixel
      // page and reports nonsense — and on a page this long there is no
      // full-page screenshot to be had anyway.
      if (rootSelector) {
        const handle = await page.$(rootSelector).catch(() => null);
        if (handle) {
          shot = await handle.screenshot({ type: 'png', scale: 'css' }).catch(() => null);
          await handle.dispose().catch(() => {});
        }
      }

      const pageHeight = shot ? 0 : await page
        .evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))
        .catch(() => 0);

      if (shot) {
        // already have the section
      } else if (pageHeight > MAX_SHOT_PX) {
        const width = await page
          .evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth))
          .catch(() => opts.width);
        // fullPage matters: on its own, clip is measured against the viewport,
        // so this quietly returned a 900px-tall reference for any page past
        // the cap and the fidelity score compared it against the whole import.
        shot = await page
          .screenshot({ type: 'png', scale: 'css', fullPage: true, clip: { x: 0, y: 0, width, height: MAX_SHOT_PX } })
          .catch(() => null);
        // doc.warnings directly: the navigation warning was folded in further up,
        // before this pass ran.
        doc.warnings = (doc.warnings || []).concat(
          `The page is ${Math.round(pageHeight).toLocaleString()}px tall — the reference screenshot ` +
          `covers only the top ${MAX_SHOT_PX.toLocaleString()}px, so the fidelity score will too.`
        );
        doc.meta.screenshotClipped = MAX_SHOT_PX;
      } else {
        shot = await page.screenshot({ fullPage: true, type: 'png', scale: 'css' });
      }
    }

    // Interaction states. This clicks things, so it must happen after the main
    // document and the screenshot are settled — the page is no longer pristine
    // afterwards.
    if (wantStates) {
      try {
        // Hand the page its clock back — clicking a tab is a timed transition.
        await page.evaluate(() => {
          if (window.__W2F_TIMERS__) {
            window.setTimeout = window.__W2F_TIMERS__.setTimeout;
            window.setInterval = window.__W2F_TIMERS__.setInterval;
          }
        }).catch(() => {});

        const groups = await discoverGroups(page, stateSelectors);
        if (groups.length) {
          const res = await captureStates(
            page,
            { serializer: SERIALIZER, maxNodes, deadline: Date.now() + STATE_BUDGET_MS },
            groups
          );
          if (res.truncated) {
            doc.warnings = (doc.warnings || []).concat(
              'State capture stopped at the time budget — some states are missing.'
            );
          }
          if (res.states.length) {
            doc.states = res.states;
            doc.assets = (doc.assets || []).concat(res.assets.filter((u) => doc.assets.indexOf(u) === -1));
          }
        }
      } catch (e) {
        doc.warnings = (doc.warnings || []).concat('State capture failed: ' + String(e.message || e));
      }
    }

    return { doc, screenshot: shot };
  } finally {
    await context.close().catch(() => {});
    if (onVercel) await browser.close().catch(() => {});
  }
}

/**
 * List the pages of a site, so a whole site can be queued without hand-typing
 * every URL. Uses a real browser because on an SPA the nav is often rendered
 * client-side and a raw HTML fetch would come back nearly empty.
 *
 * Same-origin only, hash and query variants collapsed to one entry per path,
 * and obvious non-pages (assets, mailto, downloads) dropped.
 */
async function discoverLinks({ url, limit = 60, timeout = 45000 }) {
  const browser = await getBrowser(['--hide-scrollbars']);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    bypassCSP: true
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    const links = await page.evaluate((max) => {
      const origin = location.origin;
      const SKIP = /\.(png|jpe?g|gif|svg|webp|avif|pdf|zip|mp4|webm|mp3|css|js|ico|woff2?|ttf)(\?|$)/i;
      const seen = new Map();
      const here = location.origin + location.pathname.replace(/\/$/, '');
      seen.set(here || origin, location.href);
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        let u;
        try { u = new URL(a.getAttribute('href'), location.href); } catch (e) { continue; }
        if (u.origin !== origin) continue;
        if (!/^https?:$/.test(u.protocol)) continue;
        if (SKIP.test(u.pathname)) continue;
        const key = u.origin + u.pathname.replace(/\/$/, '');
        if (seen.has(key)) continue;
        seen.set(key, u.origin + u.pathname);
        if (seen.size >= max) break;
      }
      return Array.from(seen.values());
    }, limit);
    return links;
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { capture, closeBrowser, discoverLinks };
