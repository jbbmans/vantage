# Search engines

> **Legacy deployment.** This page is for the pre-MCEN public site at vantageusmc.com (`VANTAGE_DEPLOYMENT_PROFILE=legacy-public`). It is not the production target; see [deploy-mcen.md](deploy-mcen.md) and [ADR-0007](engineering/ADR/0007-mcen-enterprise-deployment-and-unit-instances.md).

What the code does for search, and the steps only the site's owner can take.

## What the code does

- **One public document.** `/` (for a signed-out visitor), `/display` and `/about` are served `public.html`, a page rendered to HTML at build time (`scripts/prerender.mjs`). A crawler gets the whole page, its structured data and its links without running JavaScript, which matters for Bing, DuckDuckGo and every link-preview scraper. The browser then hydrates that markup with a small bundle of its own; the application's code and stylesheet are not loaded on the public page.
- **One story.** The title, description, FAQ and "last updated" date live in `src/config/site.ts`. The page head, the Open Graph and Twitter cards, the structured data (`src/lib/seo.ts`: Organization, WebSite, the page as an FAQPage, SoftwareApplication, and a VideoObject for each film) and the sitemap all come from it, and `tests/server/publicSeo.test.ts` fails if they drift apart.
- **Sitemap and robots.** `dist/sitemap.xml` is written at build time with the canonical URL (`https://www.vantageusmc.com/`), the social card and every published film. `robots.txt` on www points to it. The app's host has a `robots.txt` of its own that leaves only the sign-in pages crawlable, so engines can read their `noindex`; the console's turns every crawler away.
- **One address for the public page.** The public page lives on `www`; the app (`secure`) and the Unit Manager console (`dev`) serve nothing for search. The bare domain serves the same page with its canonical link naming `www`, so engines index one address.
- **Everything behind sign-in stays out of results**, by `noindex` in the page and in an `X-Robots-Tag` header.
- **Icons and the social card** are drawn from the one definition of the mark (`shared/brand.ts`, `npm run icons`) and versioned by content hash, so browsers and link previews pick up a change.
- **Verification tags.** Set `VANTAGE_GOOGLE_SITE_VERIFICATION` and `VANTAGE_BING_SITE_VERIFICATION` and the public page carries the matching meta tags.
- **IndexNow.** With `VANTAGE_INDEXNOW=true` (set in `render.yaml`), five minutes after a deploy that changed the public page, Vantage tells the IndexNow engines: Bing, and through it the search in Edge, DuckDuckGo and Yahoo, plus Yandex, Seznam and Naver. The key the engines check is served at `/<key>.txt` and derived from `VANTAGE_SECRET`, so it needs no setting of its own. A deploy that does not change the page sends nothing.

When the public page changes in substance, bump `updated` in `src/config/site.ts`.

## What only the owner can do

Search engines rank a new site on what others say about it as much as on the page itself. No code guarantees a position, and nothing honest can promise the first page for every search. These steps are what makes the site eligible and known:

1. **Google Search Console** (search.google.com/search-console). Add a *Domain* property for `vantageusmc.com` and verify it with the DNS TXT record Google gives you, at Namecheap or Cloudflare (see `docs/dns-namecheap.md`). That covers `www`, `http` and `https` at once. If you prefer the tag method, put the token in `VANTAGE_GOOGLE_SITE_VERIFICATION` on Render instead. Then submit `https://www.vantageusmc.com/sitemap.xml` under *Sitemaps*, and use *URL Inspection* on `https://www.vantageusmc.com/` to request indexing.
2. **Bing Webmaster Tools** (bing.com/webmasters). Sign in and choose *Import from Google Search Console*, which brings the site and sitemap across in one step. Bing's index serves Bing, Edge's search, DuckDuckGo, Yahoo and Ecosia. The alternative is the tag method with `VANTAGE_BING_SITE_VERIFICATION`.
3. **Links from places people already trust.** Put `https://vantageusmc.com` in the *Website* field of the GitHub repository, on LinkedIn and on any unit or community page where it is appropriate. One relevant link is worth more than any setting here.
4. **Check the result** a week or two later: Search Console's *Pages* report should list `/` as indexed, and a search for `site:vantageusmc.com` should show it.

Google Search does not use IndexNow, and it stopped reading sitemap pings in 2023: for Google, the sitemap submitted in Search Console is the channel. Google shows FAQ rich results only for well-known government and health sites, and its software-app rich result needs price and rating information this site does not publish, so that markup describes the site for every engine without promising a rich result.
