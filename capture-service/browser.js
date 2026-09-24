'use strict';

/**
 * One Chromium, launched the way the current host allows.
 *
 * Playwright's own Chromium is ~344MB unpacked and a Vercel function caps at
 * 250MB, so it cannot ship there. @sparticuz/chromium is the same browser
 * repacked to fit, extracted to /tmp on first use. Locally we use the full
 * install, which is faster and does not need extracting.
 */

const { chromium } = require('playwright-core');

const onVercel = !!process.env.VERCEL;
let browserPromise = null;

async function launchArgs() {
  if (!onVercel) {
    return {
      args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'],
      executablePath: undefined
    };
  }
  // @sparticuz/chromium is ESM-only, so a plain require() throws here.
  const mod = await import('@sparticuz/chromium');
  const pack = mod.default || mod;
  return {
    args: pack.args.concat(['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb']),
    executablePath: await pack.executablePath()
  };
}

async function getBrowser(extraArgs) {
  // Hosted, every request gets its own browser. The instance is frozen the
  // moment a response is sent, and an invocation that was killed mid-capture —
  // a timeout, an OOM — leaves the shared Chromium unusable for whoever thaws
  // next. That failure lands on the *following* request, which is how one slow
  // desktop capture takes the mobile one down with it.
  if (onVercel) {
    const fresh = await launchArgs();
    return chromium.launch({
      headless: true,
      args: fresh.args.concat(extraArgs || []),
      executablePath: fresh.executablePath
    });
  }
  if (!browserPromise) {
    browserPromise = (async () => {
      const { args, executablePath } = await launchArgs();
      return chromium.launch({
        headless: true,
        args: args.concat(extraArgs || []),
        executablePath
      });
    })();
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

module.exports = { getBrowser, closeBrowser, onVercel };
