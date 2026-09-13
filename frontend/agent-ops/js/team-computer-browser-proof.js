'use strict';

// Explicit no-worker fixture QA, using the repository's installed browser driver.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const url = new URL(process.argv[2]);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/agent-ops/'); assert(!url.username && !url.password);
  const teamId = url.searchParams.get('team'); assert.match(teamId, /^[a-f0-9-]{36}$/);
  const workroomPath = `/api/agent-teams/${teamId}/workroom`;
  const get = async route => {
    const response = await fetch(`${url.origin}${route}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert(response.ok); return response.json();
  };
  assert.equal((await get('/api/agent-teams/runtime')).runtime, 'local-ui-fixture');
  const snapshot = await get(workroomPath);
  assert.equal(snapshot.execution.enabled, false);
  assert(snapshot.team.objective.includes('no live workers or models run'));
  assert(snapshot.events.some(event => event.id === 'computer-display-3'));
  const output = path.resolve('output/playwright/computer-checkpoints');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    executablePath: process.env.TEAM_UI_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const checks = [];
  try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      const errors = []; const rejected = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const request = route.request(); const target = new URL(request.url());
        const allowed = target.origin === url.origin && request.method() === 'GET'
          && (target.pathname.startsWith('/agent-ops/') || [workroomPath, '/api/agent-teams', '/api/agent-teams/runtime'].includes(target.pathname));
        if (!allowed) { rejected.push({ method: request.method(), path: target.pathname }); return route.abort(); }
        return route.continue();
      });
      await page.goto(url.href);
      await page.locator('#teamExecutionState').filter({ hasText: 'Execution paused' }).waitFor();
      // Mobile deliberately collapses the header indicator; verify its settled
      // state without requiring that desktop-only chrome be visible.
      await page.locator('#syncState').filter({ hasText: 'Live ·' }).waitFor({ state: 'attached' });
      await page.locator('#tab-screen').click();
      const panel = page.locator('#panel-screen');
      await panel.locator('strong').filter({ hasText: 'Observe private browser · finished' }).waitFor();
      assert.equal(await panel.locator('.private-signal-list article').count(), 4);
      assert((await panel.innerText()).includes('do not confirm the browser is still running'));
      assert.equal(await panel.locator('img,iframe,canvas').count(), 0);
      const contrast = await panel.evaluate(element => {
        const rgb = value => value.match(/[\d.]+/g).map(Number);
        const luminance = values => values.slice(0, 3).map(value => {
          const n = value / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        return [...element.querySelectorAll('.browser-checkpoint-note, strong, small')].map(node => {
          let ancestor = node; let background;
          while (ancestor) {
            const color = rgb(getComputedStyle(ancestor).backgroundColor);
            if (color.length === 3 || color[3] === 1) { background = color; break; }
            if (color[3] !== 0) throw new Error('Composite background requires explicit review.');
            ancestor = ancestor.parentElement;
          }
          if (!background) throw new Error('No opaque panel background.');
          const light = luminance(rgb(getComputedStyle(node).color)); const dark = luminance(background);
          return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
        });
      });
      assert(contrast.length > 0 && contrast.every(ratio => ratio >= 4.5), 'Checkpoint text must meet AA contrast.');
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `${name}-checkpoints.png`), fullPage: true });
      const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth,
        brokenImages: [...document.images].filter(image => !image.complete || !image.naturalWidth).length,
        panelWidth: document.querySelector('#panel-screen').getBoundingClientRect().width }));
      assert(layout.documentWidth <= layout.width); assert.equal(layout.brokenImages, 0);
      assert(layout.panelWidth > 0 && layout.panelWidth <= layout.width);
      // Switching to another teammate must not retain the previous agent's history.
      await page.locator('#crewList button').filter({ hasText: 'Mira' }).click();
      await page.locator('#tab-screen').click();
      assert((await panel.innerText()).includes('Browser screens stay private'));
      assert.equal(await panel.locator('.private-signal-list article').count(), 0);
      assert.deepEqual(errors, []); assert.deepEqual(rejected, []);
      checks.push({ viewport: name, ...layout, checkpoints: 4, minimumTextContrast: Math.min(...contrast), crossAgentHistoryCleared: true, noMutation: true });
      await page.close();
    }
    const report = { passed: true, fixture: 'authored-history-no-workers', output, checks };
    await fs.writeFile(path.join(output, 'proof-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
