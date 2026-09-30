# Changelog — Week-one conversion + polish pack

Static GitHub Pages site (`sanidas33.github.io-main` / drinksbyneat.com). No framework migration; brand voice, layout, and CSS system preserved.

## 1. Plausible Analytics

- Added privacy-friendly Plausible snippet to **every live HTML page** (50 files):
  ```html
  <script defer data-domain="drinksbyneat.com" src="https://plausible.io/js/script.js"></script>
  ```
- Injected in `<head>` immediately after the canonical `<link>` (consistent pattern; pages do not share a partial).
- Skipped: binary/non-HTML assets; nested archive folder `Drinks_By_Neat_Website_No_Public_Prices/` (not the live Pages root).

## 2. Speed / assets

- **`assets/images/hero-stir.jpg`**: recompressed (progressive JPEG, quality ~75).
  - Before: 228,511 bytes → After: 195,061 bytes
- **`assets/images/hero-stir.webp`**: created alongside (112,318 bytes).
- Homepage hero now uses `<picture>` with WebP + JPEG fallback; kept `width="1600" height="995"` and `fetchpriority="high"` (no `loading="lazy"` on LCP).
- **`assets/images/og-image.png`** (898,367 bytes) replaced with compressed **`og-image.jpg`** (96,446 bytes) + **`og-image.webp`** (56,090 bytes).
- Updated all OG/Twitter `og-image` meta references sitewide from `.png` → `.jpg` (68 replacements across 34 pages).
- Added `loading="lazy"` to below-fold `<img>` tags that lacked it (16 images, mostly blog article heroes). LCP hero left untouched.

## 3. CTA consistency

- Primary Calendly CTA label standardized to **"Book a 15-minute call"** linking to `https://calendly.com/drinksbyneat/15` (including nav buttons that previously said “Book a call”).
- Secondary `mailto:sani@drinksbyneat.com` left as-is.
- Contact page section heading `<h3>Book a call</h3>` left as a section title (not a nav/button CTA).
- Sticky mobile CTA: **skipped** — existing CSS has no tasteful sticky-CTA pattern (only sticky header); avoided inventing new UI chrome.

## 4. Trust near hero (index only)

- Added one factual proof line under the hero CTAs:
  > World’s 50 Best Bars #25 · two-time Tales of the Cocktail nominee
- Styled with `.hero__proof` (small, soft ink; matches existing type scale). No invented testimonials or metrics.

## 5. SEO

- **`sitemap.xml`**: clean directory URLs already used where `index.html` pages exist. Four legacy nested `.html` posts remain listed (no clean `index.html` alternatives on disk); each already has a matching `<link rel="canonical">`. Bumped `lastmod` to 2026-09-18 for home, work, services, about, contact, and blog index.
- Added JSON-LD to pages that lacked it:
  - `services/index.html` — `ProfessionalService`
  - `work/index.html` — `CollectionPage` + org reference
  - `contact/index.html` — `ContactPage` + `ProfessionalService` / `ContactPoint`
- No fake `aggregateRating`. Homepage JSON-LD left unchanged.

## 6. Files touched (summary)

| Area | Paths |
|------|--------|
| HTML (50) | `index.html`, `404.html`, `privacy-policy.html`, `about/`, `contact/`, `services/`, `work/`, service landings, all `blog/**/*.html` under the live root |
| CSS | `css/style.css` (`.hero__proof`) |
| Images | `assets/images/hero-stir.jpg`, `hero-stir.webp` (new), `og-image.jpg` (new), `og-image.webp` (new); removed bulky `og-image.png` |
| SEO | `sitemap.xml` |
| Docs | `/workspace/dbn-site/CHANGELOG.md` (this file) |

## Intentionally skipped

- `Drinks_By_Neat_Website_No_Public_Prices/**` — duplicate/archive tree inside the zip, not the published site root.
- Sticky mobile CTA bar — no existing CSS support without a redesign.
- Creating clean URL wrappers for the four legacy `*.html` blog posts — out of scope; kept URLs + canonicals.
- Git commit / push / PR open — not requested for this pass.

---

# Post-launch QA + polish — 2026-09-30 (branch `polish/post-launch-qa`)

Audit of all 67 live HTML pages (incl. SEO landings and `/work/{slug}/`) after PRs #1–#8. No redesign; Editorial 03 system kept. No edits to titles, meta descriptions, OG/Twitter, JSON-LD, canonicals, sitemap, robots, or llms.txt.

- **Conversion tracking.** New `/js/events.js` (~1 KB, deferred, loaded after Plausible on every page) fires Plausible custom events `Book Call` (any `calendly.com/drinksbyneat/…` link) and `Email Click` (any `mailto:`), with a `position` prop (nav / hero / cta-band / inline / footer). **Action needed:** add both as Custom-event goals in Plausible.
- **CTA at the end of every page.** Standard "Fifteen minutes usually answers it" band (Book a 15-minute call + Email instead) added to the 13 posts and 2 utility pages (404, privacy) that ended without one (the 4 legacy `*.html` post copies too, so they stay in sync).
- **Blog hero images fixed.** On 16 recipe/technique posts the hero rendered 746 px tall at every width (the `height` attribute overrode the 21:10 crop), so on phones it was a full-screen tall crop. Added `height:auto`, and the 21:10 frame now holds.
- **Images.** WebP (1200w + 800w) with `srcset`/`sizes` for every blog and case-study image, plus 800/1200/1600 for the home hero; JPEGs kept as fallback. Above-the-fold heroes are no longer lazy (they get `fetchpriority="high"`); below-the-fold images on `/work/` stay lazy. Added the missing `width`/`height` to case-study images.
- **Fonts self-hosted.** Inter + Playfair Display (latin/latin-ext variable woff2) now load from `/assets/fonts/`, with the two above-the-fold faces preloaded. This drops the render-blocking Google Fonts request. Rendering is unchanged (before/after screenshots match pixel for pixel). Privacy policy updated to match.
- **Accessibility.** Heading order fixed (footer column labels h4→h3; services and case-study labels h4→h3/h2 with identical styling). Fixed the low-contrast "Back to Notes" link on 3 older posts (accent → accent-deep). `aria-current` added on /approach/.
- **Lighthouse (local, mobile):** home perf 83→99, FCP 3.4s→1.2s; all audited pages 99–100 perf, a11y 100.
