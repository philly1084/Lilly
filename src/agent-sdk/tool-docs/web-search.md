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
- `maxToolCalls`
- `agentModel` / `agentModels`
- `responseFormat`
- `agentTools`
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
- Agent presets may change their underlying model over time. Use `agentModel` to pin one model or `agentModels` for an ordered fallback chain of up to five models when reproducibility or a specific quality tier matters.
- Use `responseFormat` with a named `json_schema` when downstream code needs typed comparison rows, evidence records, extracted facts, or other reliably parseable research data. Keep URLs grounded in the returned `citations` and `results` instead of asking the model to invent them inside structured output.
- Use `maxToolCalls` to bound Agent research cost separately from `maxSteps`.
- Use `agentTools: ["finance_search"]` for current public-company quotes, statements, earnings, estimates, or market data, and `agentTools: ["people_search"]` when professional-person lookup is explicitly needed. These are additive Agent API tools and have separate per-call costs.
- Admin `orchestration.perplexityResearchLevel` can override automatic mode selection: `regular` caps research at raw Search, `pro` uses Agent `pro-search` for explicit research, and `deep` escalates explicit research to Sonar Deep Research while leaving URL hotlists on raw Search.
- Use `search` for URL hotlisting, scraping prep, Playwright candidate pages, and link discovery when the local agent only needs candidate pages.
- Use `sonar` or `sonar-pro` for one-shot grounded answers. Use `sonar-pro` for complex comparisons.
- Use `returnImages: true` with optional `imageDomains` and `imageFormats` for image URL hotlisting. Use `returnVideos: true` only when video sources materially help.
- Use `pro-search` when a single Perplexity call should plan, search, and fetch autonomously. Prefer it for explicit research requests, daily news, article roundups, source-backed briefings, and research collection where headlines/snippets alone would be too thin but full deep research is not justified.
- Use `sonar-deep-research` only when the user explicitly asks for deep, comprehensive, or long-form research that justifies higher cost.
- Use `domains` to bias Perplexity toward official docs, publishers, or an approved source family.
- For Canadian current-info requests, use authoritative Canadian domains when obvious, such as `weather.gc.ca` for weather.
- Use larger extraction budgets for research-heavy work: default `maxTokens` is 50,000 across results and `maxTokensPerPage` is 4,096 unless overridden by environment/config.
- Use `web-fetch` first on result URLs for direct verification, especially before composing news, reports, slides, or researched HTML.
- Use `web-scrape` only when deeper rendered or structured extraction is needed, or when `web-fetch` cannot read the page.
- Perplexity code execution is not currently a built-in Agent API tool. When research needs calculations, deduplication, CSV/JSON transformation, statistical checks, or chart data, use a KimiBuilt-native chain: `web-search` -> `web-fetch`/`web-scrape` verification -> isolated `code-sandbox` execution with network disabled -> cited synthesis or artifact generation. Pass only the required source data into the sandbox and preserve source URLs outside generated structured data.
