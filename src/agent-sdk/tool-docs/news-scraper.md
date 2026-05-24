# news-scraper

Purpose: build a richer news source pipeline than headline-only search results.

Use when:
- the user asks for a news scraper, news website, article feed, or news source
- Perplexity search is finding URLs but synthesis is only seeing headlines/snippets
- a deployed frontend needs direct JSON injection for news and weather

Key params:
- `query`
- `urls`
- `limit`
- `region`
- `timeRange`
- `domains`
- `articleCharLimit`
- `siteTextMode`
- `contentRights`
- `weather`
- `includeWeatherPlaceholder`
- `title`

Behavior:
1. If `urls` are supplied, fetch those article pages directly.
2. If only `query` is supplied, use Perplexity `pro-search` with larger budgets to find article URLs.
3. Fetch each source page and extract title, canonical URL, source host, byline, publish date, lead image, description, readable article text, and excerpt.
4. Return `articles[]` for research/internal use, plus `injection` and `site.html` for a static news website.

Publication guardrail:
- `siteTextMode: "excerpt"` is the default for public websites.
- `siteTextMode: "full"` only renders full text when `contentRights` is one of `owned`, `licensed`, `public-domain`, `creative-commons`, or `explicit-permission`.
- For ordinary third-party news, publish excerpts plus source links and keep full extracted text for internal analysis or licensed-source injection.

Weather injection:
- Pass a verified `weather` object when weather data is already available.
- Leave `includeWeatherPlaceholder: true` to render a weather slot that can be replaced later without rebuilding the page.
