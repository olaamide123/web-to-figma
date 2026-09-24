# Figma Community listing — copy/paste

## Name
Web to Figma

## Tagline (max ~60 chars)
URL in. Editable layers out.

## Description

Paste a URL and get the page back as real Figma layers — not a screenshot.

- **Text stays editable.** Fixed width, auto height, so the browser's line
  breaks survive. A coloured span inside a heading keeps its colour.
- **Images come from the source**, not from a screen grab. `srcset` and
  `<picture>` resolve through `currentSrc`, so you get the variant the browser
  actually chose.
- **Inline SVG becomes real vectors.**
- **Auto Layout where the page uses flexbox** — direction, gap, padding and
  alignment are read from the page, then checked against the captured
  positions. If applying it would shift anything, that frame stays absolutely
  positioned. It never guesses.
- **Desktop and mobile side by side**, at the real responsive width. 390 renders
  the site's actual mobile CSS; nothing is scaled down.
- **Tabs and accordions** can be clicked through and returned as component sets.
- **Fidelity check.** After an import, score the result against the live page
  and see the worst-matching bands.

### No setup

Open it, paste a URL, press Import. No account, no API key, nothing to install.

Rendering happens on a shared capture service that the plugin registers itself
with on first run. **Nothing you capture is stored** — the page comes back in a
single response and the service keeps no copy of it.

The shared service runs on free infrastructure, so it has a capacity. If it is
ever reached the plugin says so plainly, and you can point it at your own
capture service under Advanced — it is open source and deploys in one click.

Source and self-hosting: https://github.com/olaamide123/web-to-figma

## Images — which file goes where

| Figma field | File | Size |
|---|---|---|
| Plugin icon | `icon.png` | 128 x 128 |
| Thumbnail | `thumbnail.png` | 1920 x 1080 |
| Carousel 1 | `carousel-01.png` | 1920 x 1080 |
| Carousel 2 | `carousel-02.png` | 1920 x 1080 |
| Carousel 3 | `carousel-03.png` | 1920 x 1080 |
| Carousel 4 | `carousel-04.png` | 1920 x 1080 |
| Carousel 5 | `carousel-05.png` | 1920 x 1080 |

Every screenshot in these is a real capture of
`https://flock-site-beta.vercel.app/` made by this plugin, and every figure
quoted on them comes from that import: 1,310 layers, 602 text, 123 images,
37 vectors, 346 frames on Auto Layout. The layer trees are the actual
serialised node names. Nothing is mocked up, so if the plugin's output
changes, regenerate rather than edit.

## Tags
website, import, html, css, web, screenshot, url, developer, handoff, prototype

## Category
Import / Developer tools

## Notes for reviewers  <- paste this into the review-notes field

No credentials, no account and no setup. The plugin registers itself
anonymously with our capture service the first time it runs, so a clean
install works immediately.

To test:
1. Open the plugin.
2. Paste a public URL. Suggested:
   https://getbootstrap.com/docs/5.3/getting-started/introduction/
3. Leave Desktop ticked and press "Import to Figma".

The page comes back as editable Figma layers in roughly 15-25 seconds.

Data handling: the URL you enter is sent to our capture service, which loads
that public page in a headless browser and returns the result in one response.
**Nothing is stored** — no database, no file storage, no logs of page content.
The plugin keeps only an anonymous install token in figma.clientStorage so the
service can tell repeat requests apart; it identifies no person and carries no
personal data. No analytics, no tracking, no third parties.

Anyone who prefers not to use the shared service can run the capture service
themselves; the "Advanced" section takes its URL, and the source is linked
above.
