# Web to Figma

URL → viewport → editable Figma layers. Internal tool, V1.

```
Figma plugin  ──POST /capture──▶  Capture service
                                        │
                                   Playwright + Chromium
                                        │  loads the URL at 1440 or 390
                                        │  freezes animations, scrolls to trigger
                                        │  lazy loading, returns to top
                                        ▼
                                  serializer.js runs in-page
                                        │  walks the rendered DOM
                                        │  reads getComputedStyle + rects
                                        ▼
                                  assets.js downloads images
                                        │  AVIF/WebP → PNG/JPEG, cap 4096px
                                        ▼
Figma plugin  ◀──JSON + bytes──   { root, overlays, fonts, assets }
      │
      └─ code.js reconstructs frames, text, images, vectors
```

## Setup

**Using the plugin** — nothing to set up. Open it, paste a URL, press Import.
On first run it quietly registers itself with the shared capture service and
remembers that; there is no account, no key to paste and nothing to deploy.

The shared service allows 60 captures per install per day. If you need more, or
you would rather captured pages never touch someone else's infrastructure, run
your own (below) and put its URL under **Advanced** in the plugin.

**Running your own capture service (optional)**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/olaamide123/web-to-figma&env=CAPTURE_TOKEN&envDescription=Any%20random%20string.%20Paste%20the%20same%20value%20into%20the%20plugin%20under%20Advanced.&stores=%5B%7B%22type%22%3A%22blob%22%7D%5D)

It provisions a Blob store and asks for one variable:

| Variable | What to put |
|---|---|
| `CAPTURE_TOKEN` | Any random string (`openssl rand -base64 24`). Paste the same value into the plugin under Advanced. Requests carrying it skip the daily limit entirely. |

Captures run 20-100 seconds at 2GB, which is fine on Vercel's Hobby plan for
personal use.

**Running it locally**

```bash
cd capture-service
npm install
npm run setup        # downloads Chromium for Playwright
npm start            # http://localhost:3000
```

Node 18.17+. Put `http://localhost:3000` under Advanced and leave the token
blank — a local service asks for nothing.

**Developing the plugin**

Figma -> Plugins -> Development -> Import plugin from manifest -> pick
`figma-plugin/manifest.json`. No build step; it is plain JS. Changing
`manifest.json` requires re-importing, as Figma only reads it once.

## How public access works

A distributed plugin bundle is readable, so it ships no secret. Instead:

1. On first run the plugin calls `POST /register` and gets back a token signed
   with a key that never leaves the server.
2. It stores that in `figma.clientStorage` and sends it as `x-w2f-install` on
   every later request.
3. The server verifies the signature, then meters that install: 60 captures a
   day, counted in Blob under `meter/<date>/`.
4. `/register` is itself capped per IP per day, so tokens cannot be minted
   without bound.

This is metering, not authentication — nothing proves the caller is really the
plugin, and someone determined can register again. What it buys is a credential
that can be re-keyed without shipping a new plugin version, a per-install
ceiling on cost, and no extractable secret in the bundle. The hard limits on
abuse are that per-IP cap, the private-network guard in `net-guard.js`, and
Vercel's own spend controls.

Set `CAPTURE_TOKEN` on a deployment and it behaves as a private service
instead: that token grants unmetered access and registration is bypassed.

## Publishing to the Figma Community

Before the first publish:

1. **Get a real plugin id.** Figma issues one; you cannot pick it. Create a new
   plugin through Figma (Plugins → Development → New plugin), then copy the
   `id` it generates into `figma-plugin/manifest.json`, replacing the
   placeholder.
2. **Update `allowedDomains`.** It currently allows `https://*.vercel.app` and
   the matching Blob host, which covers the deploy button above. If you expect
   people to host elsewhere, widen it — Figma enforces this list, and review
   will ask why.
4. **Store assets.** A 128x128 icon and a 1920x960 cover, both already in
   `figma-plugin/store/`.
3. **Retention.** Captures are deleted automatically after `RETENTION_DAYS`
   (7 by default) by a daily cron job. Nothing else is stored, and there is no
   central server — each user's captures live only in their own Blob store.

## What it does

- Serialises the **full page**, header to footer, at the real responsive width.
  390 renders the site's actual mobile CSS; nothing is scaled down.
- Text stays **editable** — fixed width, auto height, so browser line breaks
  survive. Styled runs are preserved, so an accent-coloured `<span>` inside a
  heading keeps its colour.
- Images come from their **original source**, not element screenshots.
  `srcset`/`<picture>` resolve through `currentSrc`, so you get the variant the
  browser actually chose.
- Inline `<svg>` and `.svg` files become **real vectors** via `createNodeFromSvg`.
- `position: fixed` elements are **hoisted and drawn once** at the top, instead
  of repeating down a 9000px frame.
- Both viewports land side by side inside a section named
  `Website Import — <host>`.

## The fidelity harness

This is the part that makes iteration possible. After an import, click
**Check fidelity against the live page**. The plugin exports the built frame,
the service pixel-diffs it against the Playwright screenshot from the same run,
and you get a score plus the worst horizontal bands:

```
94.2%   Desktop — pixel match against the live page
y 3180–3520    8.4% off
y 1240–1580    3.1% off
```

Heatmaps land in `capture-service/runs/<runId>/diff.png`. Fix the worst band,
re-import, re-score. Without this you are the compiler, describing every
discrepancy by hand.

## Testing protocol

```
https://flock-site-beta.vercel.app/          @ 1440, 390
https://flock-site-beta.vercel.app/discover  @ 1440, 390
```

Node count is not success. Check, in this order:

1. **Total frame height** vs the real page — if this is off, something above it
   collapsed, and everything below inherits the error.
2. **Section boundaries** — the y of each major section against the live page.
3. **Line wrapping** on headings, then body copy.
4. **Image crops** — `object-fit: cover` regions especially.
5. Colours, radii, borders, shadows.
6. Header and footer.
7. Mobile: the 390 frame should look like the mobile site, not a squeezed desktop.

## Where it will be wrong

Being straight about this, because these are the things you'll hit on day one:

- **Text metrics.** Figma's shaper is not Chromium's. `buildText` nudges the
  width up to three times when a block wraps more than 25% taller than captured,
  and reports what it couldn't fix. Some blocks still need a manual drag.
- **Pseudo-elements.** `::before`/`::after` have no measurable box. They're
  captured with the parent's geometry and marked `approx`. Dividers and dots
  land roughly; gradient overlays land approximately.
- **No Figma equivalent:** `backdrop-filter`, `clip-path`, `background-clip: text`,
  most blend modes, `mask-image`. These silently don't render.
- **Rotated elements** use the layout box plus a rotation. Skewed and 3D
  transforms are ignored.
- **Scroll containers** flatten to their scroll-top state.
- **Marquees** freeze at their final keyframe, which may be off-screen. If a
  ticker looks empty, that's why — a per-site selector override in `REVEAL_CSS`
  is the fix.
- **Cookie banners** will be captured as content unless you pass a dismiss
  selector in Capture settings.
- **Auto Layout is deliberately not inferred.** Everything is absolutely
  positioned, per the spec. That's the right V1 trade: coordinates are exact,
  inferred layout is a guess that destroys the visual when it's wrong.

## Tuning knobs

| Where | What |
|---|---|
| `capture.js` → `FREEZE_CSS` | how animations are settled |
| `capture.js` → `REVEAL_CSS` | selectors forced visible; add per-site rules here |
| `serializer.js` → `simplify()` | wrapper-collapsing rules — the biggest lever on how editable the layer tree feels |
| `serializer.js` → `nameFor()` | layer naming; currently strips Tailwind utility soup |
| `serializer.js` → `isTextBlock()` | when an element becomes one text node vs a frame of children |
| `code.js` → `WEIGHT_STYLES` | CSS weight → Figma style-name mapping |

If the layer tree feels too deep or too flat, `simplify()` is the first place to
go, not the reconstruction code.

## Not built, on purpose

Accounts, dashboards, history, teams, component generation, design-system
extraction, responsive constraints, animation conversion. Per the brief.
