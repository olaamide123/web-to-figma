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

### One-time setup

Figma's sandbox has no browser, so rendering happens in a small capture service
that **you deploy and own** — one click on Vercel's free tier. The plugin has no
backend: your captures never touch a server belonging to anyone else, and they
are deleted from your own storage after 7 days.

Setup instructions: https://github.com/olaamide123/web-to-figma

## Tags
website, import, html, css, web, screenshot, url, developer, handoff, prototype

## Category
Import / Developer tools

## Notes for reviewers  ← paste this into the review-notes field

This plugin needs a capture service, which each user deploys themselves (the
plugin has no backend by design — see the setup link above).

So that you can test without deploying anything, here is a working instance:

    Service URL:   https://web-to-figma-capture.vercel.app
    Access token:  <paste it here in Figma - never commit it to this repo>

Open the plugin, put those two values into "Capture settings", enter any public
URL, and press Import to Figma.

Suggested test URL: https://getbootstrap.com/docs/5.3/getting-started/introduction/

This instance is provided so the plugin can be reviewed without deploying
anything. Published users deploy their own; the plugin has no shared backend.
