# claude-bridge — landing site

A single-page static showcase. No build step. No dependencies.

## Files

- `index.html` — markup + the SVG node graph
- `styles.css` — design tokens, layout, responsive rules
- `bridge.js` — text scramble, copy button, hero animation loop

## Run it locally

Any static server works. Pick one:

```bash
# Python
python3 -m http.server 5173

# Node (no install needed if you have npx)
npx serve .

# Just open it (most things work, but the clipboard API needs a server)
open index.html
```

Then visit http://localhost:5173.

## What's on the page

- A hero with five Claude agent nodes (frontend / backend / research / db / tests) wired together. Messages travel along the wires in real time — questions go one way, replies come back. The transcript below the graph mirrors the same exchange.
- The word "bridge" in the lede scrambles into adjacent metaphors (wire / thread / channel) on a loop.
- A copy-to-clipboard install command and a github link. No marketing fluff.

## Design notes

- Warm-black (`#0d0c0a`) + bone + acid-yellow + terracotta + dusty teal. Four hues, one unexpected (acid).
- Fonts: JetBrains Mono (display + node labels), Instrument Serif (italic accents), IBM Plex Sans (body). Deliberately not Inter / Geist.
- Aesthetic: editorial dark, hand-sketched line work (SVG turbulence + displacement filter), risograph-inspired palette.
- Reduced-motion users get a static graph and a sample transcript.

## Verified at

- 375px (mobile), 768px (tablet), 1440px (desktop)
- Chrome / Safari / Firefox

## SEO checklist applied

- `<title>`, meta description, keywords, author, robots, theme-color, canonical (GitHub URL until a domain ships)
- Open Graph + Twitter Card with a 1200x630 `og-image.png` (cropped from the hero render)
- JSON-LD `SoftwareApplication` block (MIT licence, JavaScript, macOS/Linux, author)
- Favicons: `favicon.ico` (16/32/48 multi-size), `favicon.svg`, `apple-touch-icon.png` (180x180), `manifest.json` with 192/512 icons
- `robots.txt` and `sitemap.xml` at site root
- Semantic HTML: one `<h1>`, sequential `<h2>`/`<h3>`, `<main>`, `<header>`, `<footer>`, `<nav>`, `<section>`, ordered list for steps
- Skip-link, visible focus rings, ARIA labels on nav and CTAs, `<title>`/`<desc>` inside the hero SVG
- `prefers-reduced-motion` already respected in `styles.css`
- Compact "What is claude-bridge?" paragraph using priority keywords without stuffing

Lighthouse (headless Chrome, localhost): Performance 91, Accessibility 100, Best Practices 100, SEO 100.
