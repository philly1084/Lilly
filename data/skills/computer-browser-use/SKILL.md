Use this skill when the user asks Lilly to inspect, click, type, fill forms, verify a rendered app, capture screenshots, or prove what is visible in a browser or computer surface.

Current Lilly boundary:
- `web-scrape` can render pages with a browser and capture screenshots.
- Remote Playwright/Chromium checks can run through remote lanes when the runner has browser automation.
- If a true desktop/computer-use provider is not configured, say so and use browser-rendered proof or remote automation instead.

Workflow:
1. Resolve the target URL, file preview, public route, or local app surface.
2. Decide the interaction level:
   - rendered inspection: use browser scrape and screenshots.
   - form/input/navigation: use a browser automation lane when available.
   - high-impact action: ask for approval first.
3. Capture both desktop and mobile when the result is a frontend or public site.
4. Check for page errors, blank render, broken images, clipped text, low contrast, horizontal overflow, and important opened states.
5. For fixes, patch source first, rerender, and compare screenshots.
6. Return the exact URL, viewport(s), screenshots/report paths, failures, and the final visible state.

Do not finish visual UI work from code-only reasoning when a browser surface is available.
