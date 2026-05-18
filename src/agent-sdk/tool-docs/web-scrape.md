# web-scrape

Purpose: extract named fields from a web page.

Use when:
- the user asks to pull headings, prices, links, labels, or repeated items
- you need structured extraction rather than raw HTML
- the page requires browser rendering or interaction before the data is visible

Key params:
- `url`
- `selectors`
- `browser`
- `javascript`
- `researchSafe`
- `approvedDomains`
- `respectRobotsTxt`
- `waitForSelector`
- `actions`
- `captureScreenshot`
- `viewport`

Patterns:
- Static page: use selectors only.
- Dynamic page: set `browser: true` or `javascript: true`.
- Cert/TLS problems: browser mode is the preferred fallback.
- Interactive page: use `browser: true` plus `actions` like `click`, `fill`, `type`, `press`, `wait_for_selector`, `wait_for_timeout`, `hover`, `scroll`, or `select_option`.
- Visual review: add `captureScreenshot: true` in browser mode to persist a Playwright/Chromium screenshot artifact.
- Responsive UI checks: run separate calls with `viewport: {"width":1440,"height":960}` and `viewport: {"width":390,"height":844}` to capture desktop and mobile states.
- Screenshot-only QA: omit `selectors`; they are not required to capture a page image.

Selector format:
- `selectors` must be an object keyed by field name, not an array.
- Example: `{"headline":{"selector":"h1","transform":"text"},"links":{"selector":"a[href]","attribute":"href","multiple":true,"transform":"url"}}`
- Each field can include `selector`, `attribute`, `multiple`, and `transform`.

Notes:
- Selector support is intentionally basic.
- Good for tags, ids, classes, and repeated simple fields.
- Not the default follow-up for ordinary research verification; prefer `web-fetch` when simple page retrieval is enough.
- For search-follow-up research, use `researchSafe: true` and `approvedDomains` so the backend can skip pages that are outside the approved source set or explicitly disallow bots in `robots.txt`.
- Use `web-scrape` after `web-fetch` fails, when article text is rendered by JavaScript, or when the task needs specific fields such as article headline, byline, date, price, event details, or repeated listings.
