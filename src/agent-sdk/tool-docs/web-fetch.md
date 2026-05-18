# web-fetch

Purpose: retrieve raw content from a URL.

Use when:
- you need the HTML/text/body of a page
- the page is mostly static
- you do not need structured field extraction

Key params:
- `url`
- `method`
- `headers`
- `timeout`
- `retries`

Notes:
- Best for simple HTTP/HTTPS fetches.
- For research follow-up, fetch the strongest candidate pages after `web-search` so synthesis has verified page text, not just headlines or snippets.
- For rendered or JavaScript-heavy pages, prefer `web-scrape` with `browser: true`.
