# web-search

Purpose: find relevant pages before answering or scraping.

Use when:
- the user asks for current information
- the user asks for researched synthesis with current sources
- you need a page to inspect but do not have the URL yet

Key params:
- `query`
- `prompt`
- `engine`
- `researchMode`
- `limit`
- `safeSearch`
- `region`
- `domains`
- `languageFilter`
- `timeRange`
- `publishedAfter` / `publishedBefore`
- `updatedAfter` / `updatedBefore`
- `maxTokens`
- `maxTokensPerPage`
- `maxOutputTokens`
- `userLocation`
- `maxSteps`
- `instructions`
- `returnImages`
- `imageDomains`
- `imageFormats`
- `returnVideos`
- `searchMode`
- `searchContextSize`
- `reasoningEffort`

Notes:
- `perplexity` is the working engine in this backend.
- Requires `PERPLEXITY_API_KEY` in the backend environment.
- Default locality is Canadian: use `region: "ca-en"` and `userLocation: { "country": "CA" }` for ordinary searches, and prefer Canadian sources or official Canadian source families first unless the user explicitly asks for another country, region, or publisher set.
- If the user gives no timeframe, make the search freshness-aware. Use "modern" in broad provider/tool/best-practice queries, and for news or technology topics add terms like "recent" or "this month" and set `timeRange: "month"` unless the user asks for a different period.
- `researchMode: "search"` uses Perplexity's raw `/search` endpoint for ranked results.
- `researchMode: "sonar" | "sonar-pro" | "sonar-reasoning-pro" | "sonar-deep-research"` uses Perplexity Sonar `/v1/sonar` for grounded answers, citations, search results, and optional media.
- `researchMode: "fast-search" | "pro-search" | "deep-research" | "advanced-deep-research"` uses Perplexity's `/v1/agent` presets for autonomous searched answers plus source results.
- Use `search` for URL hotlisting, scraping prep, Playwright candidate pages, and routine public research when the local agent can fetch/verify pages itself.
- Use `sonar` or `sonar-pro` for one-shot grounded answers. Use `sonar-pro` for complex comparisons.
- Use `returnImages: true` with optional `imageDomains` and `imageFormats` for image URL hotlisting. Use `returnVideos: true` only when video sources materially help.
- Use `pro-search` when a single Perplexity call should plan, search, and fetch autonomously. Prefer it for daily news, article roundups, source-backed briefings, and research collection where headlines/snippets alone would be too thin but full deep research is not justified.
- Use `sonar-deep-research` only when the user explicitly asks for deep, comprehensive, or long-form research that justifies higher cost.
- Use `domains` to bias Perplexity toward official docs, publishers, or an approved source family.
- For Canadian current-info requests, use authoritative Canadian domains when obvious, such as `weather.gc.ca` for weather.
- Use larger extraction budgets for research-heavy work: default `maxTokens` is 50,000 across results and `maxTokensPerPage` is 4,096 unless overridden by environment/config.
- Use `web-fetch` first on result URLs for direct verification, especially before composing news, reports, slides, or researched HTML.
- Use `web-scrape` only when deeper rendered or structured extraction is needed, or when `web-fetch` cannot read the page.
