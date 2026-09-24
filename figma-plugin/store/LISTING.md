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

Open it, paste a URL, press Import. There is no account, no API key and nothing
to install. Rendering happens on a shared capture service that the plugin
registers itself with on first run.

Fair use is 60 captures per day. If you need more, or you would rather captured
pages stayed on your own infrastructure, you can point the plugin at your own
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

No credentials or setup are needed. The plugin registers itself anonymously
with our capture service the first time it runs, so it works immediately on a
clean install.

To test:
1. Open the plugin.
2. Paste a public URL. Suggested:
   https://getbootstrap.com/docs/5.3/getting-started/introduction/
3. Leave Desktop ticked and press "Import to Figma".

You should get the page back as editable Figma layers in roughly 20-40 seconds.

On privacy: the page being captured is fetched by our service and the result is
stored there for 7 days, then deleted automatically by a scheduled job. No
personal data is collected and the plugin has no login. The "Advanced" section
lets anyone run the capture service themselves instead; the source is linked
above.
