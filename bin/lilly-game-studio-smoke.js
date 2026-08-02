#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright-core');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const args = {
    url: process.env.GAME_STUDIO_URL || 'http://127.0.0.1:3000/game-studio/',
    outDir: process.env.GAME_STUDIO_SMOKE_OUT || path.resolve('ui-checks', 'game-studio-smoke'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--url') args.url = argv[++index] || args.url;
    else if (argv[index] === '--out') args.outDir = path.resolve(argv[++index] || args.outDir);
    else if (!argv[index].startsWith('--')) args.url = argv[index];
  }
  return args;
}

async function existingBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    process.env.ARTIFACT_BROWSER_PATH,
    process.env.CHROME_BIN,
    process.platform === 'win32' && path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.platform === 'win32' && path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (_error) {
      // Continue through the fixed allowlist.
    }
  }
  return '';
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${url} returned ${response.status}: ${body.error || body.message || 'request failed'}`);
  return body;
}

async function waitForCommand(page, action) {
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && /\/commands$/.test(new URL(response.url()).pathname));
  await action();
  const response = await responsePromise;
  assert(response.ok(), `Editor command failed with HTTP ${response.status()}`);
  const saved = page.getByText('All changes saved', { exact: true });
  if (await saved.isVisible().catch(() => false)) await saved.waitFor({ state: 'visible' });
  else await page.waitForTimeout(250);
}

async function connectHandles(page, source, target) {
  await source.evaluate((element) => element.click());
  await page.waitForTimeout(150);
  assert((await source.getAttribute('class') || '').includes('clickconnecting'), 'Blueprint source handle did not enter click-connect mode');
  await target.evaluate((element) => element.click());
  await page.waitForTimeout(150);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const origin = new URL(args.url).origin;
  const report = { schema: 'LillyGameStudioSmoke/v1', url: args.url, startedAt: new Date().toISOString(), steps: [], consoleErrors: [], pageErrors: [], httpErrors: [] };
  const record = async (name, task) => {
    const startedAt = Date.now();
    await task();
    report.steps.push({ name, status: 'passed', durationMs: Date.now() - startedAt });
  };

  await fs.mkdir(args.outDir, { recursive: true });
  const projectName = `Browser Canary ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const created = await requestJson(`${origin}/api/game-studio/projects`, {
    method: 'POST',
    body: JSON.stringify({
      name: projectName,
      prompt: 'A compact neon ruin with 7 readable rooms, 5 energy cores, fair pulse traps, and a clear exit beacon.',
      seed: 'browser-canary-seed',
    }),
  });
  const projectId = created.project.id;
  report.projectId = projectId;

  const executablePath = await existingBrowser();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') report.consoleErrors.push({ text: message.text().slice(0, 500), location: message.location() });
    });
    page.on('pageerror', (error) => report.pageErrors.push(String(error.message || error).slice(0, 500)));
    page.on('response', (response) => {
      if (response.status() >= 400) report.httpErrors.push({ status: response.status(), url: response.url() });
    });
    await page.addInitScript((id) => {
      if (location.pathname.startsWith('/game-studio')) localStorage.setItem('lilly-game-studio:project', id);
    }, projectId);

    await record('open-editor', async () => {
      await page.goto(args.url, { waitUntil: 'domcontentloaded' });
      await page.locator('.studio-app').waitFor({ state: 'visible' });
      await page.getByText(projectName, { exact: true }).first().waitFor({ state: 'visible' });
    });

    await record('hierarchy-and-inspector-edit', async () => {
      await page.locator('.tree-row').filter({ hasText: 'Player' }).click();
      await waitForCommand(page, async () => {
        const input = page.locator('.entity-name-input');
        await input.fill('Canary Player');
        await input.press('Tab');
      });
      await waitForCommand(page, async () => {
        const input = page.locator('.component-card').filter({ hasText: 'Transform' }).locator('.number-field input').first();
        await input.fill('1.25');
        await input.press('Tab');
      });
      const pickup = page.locator('.tree-row').filter({ hasText: 'Energy Core 3' });
      const player = page.locator('.tree-row').filter({ hasText: 'Canary Player' });
      await waitForCommand(page, async () => {
        const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
        await pickup.dispatchEvent('dragstart', { dataTransfer });
        await player.dispatchEvent('dragenter', { dataTransfer });
        await player.dispatchEvent('dragover', { dataTransfer });
        await player.dispatchEvent('drop', { dataTransfer });
      });
    });

    await record('typed-blueprint-connection', async () => {
      await page.getByRole('button', { name: /^Blueprints/ }).click();
      await page.locator('.react-flow__node').first().waitFor({ state: 'visible' });
      const initialEdgeCount = await page.locator('.react-flow__edge').count();
      assert(initialEdgeCount >= 3, `Expected the canary graph to start with at least 3 edges, found ${initialEdgeCount}`);
      await page.locator('.node-add-wrap > button').filter({ hasText: 'Node' }).click();
      await page.locator('.node-menu button').filter({ hasText: /^Delay/ }).click();
      const delayNode = page.locator('.react-flow__node').filter({ hasText: /^Delay/ }).last();
      await delayNode.waitFor({ state: 'visible' });
      const source = page.locator('.react-flow__node').filter({ hasText: 'Score = 5?' }).locator('.react-flow__handle.source').first();
      const target = delayNode.locator('.react-flow__handle.target').first();
      await connectHandles(page, source, target);
      await page.waitForFunction((count) => document.querySelectorAll('.react-flow__edge').length > count, initialEdgeCount, { timeout: 5000 });
      await waitForCommand(page, () => page.getByRole('button', { name: 'Compile & save', exact: true }).click());
      await page.getByText('Graph valid', { exact: true }).waitFor({ state: 'visible' });
    });

    await record('ai-command-review-and-apply', async () => {
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await page.locator('#level-prompt').fill('Build a hard ember foundry with 8 rooms, 4 cores, 6 traps, strong landmarks, and a clear exit.');
      const proposalResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/ai-runs$/.test(new URL(response.url()).pathname));
      await page.getByRole('button', { name: 'Generate level', exact: true }).click();
      assert((await proposalResponse).ok(), 'AI level proposal request failed');
      const director = page.locator('.ai-panel');
      await director.getByText('Ready to apply', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      await director.locator('.proposal-metrics').getByText('8', { exact: true }).waitFor({ state: 'visible' });
      await waitForCommand(page, () => director.getByRole('button', { name: 'Use this level', exact: true }).click());
      await page.getByRole('button', { name: 'Close AI Director' }).click();
    });

    await record('play-pause-step', async () => {
      await page.getByTitle(/^Play/).click();
      await page.getByText('Simulation running', { exact: true }).waitFor({ state: 'visible' });
      await page.getByTitle(/^Pause/).click();
      await page.getByText('Paused — step to advance', { exact: true }).waitFor({ state: 'visible' });
      await page.getByTitle(/^Step/).click();
      assert(await page.locator('.viewport-panel.mode-paused').isVisible(), 'Step did not leave the editor in paused play mode');
      await page.getByTitle('Stop play mode').click();
    });

    await record('immutable-build-and-private-replay', async () => {
      await page.getByRole('button', { name: 'Build Output', exact: true }).click();
      await page.getByRole('button', { name: 'Build current revision', exact: true }).click();
      await page.getByRole('button', { name: 'Private preview', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      await page.getByRole('button', { name: 'Private preview', exact: true }).click();
      const frame = page.frameLocator('.build-preview-wrap iframe').frameLocator('iframe');
      await frame.locator('#game-canvas').waitFor({ state: 'visible', timeout: 30000 });
      const control = await frame.locator('body').evaluate(async () => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (window.__LILLY_GAME__?.controlTest) return window.__LILLY_GAME__.controlTest();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
      });
      assert(control?.passed === true, `Player control test failed: ${JSON.stringify(control)}`);
      await frame.getByRole('button', { name: 'Save', exact: true }).click();
      await frame.locator('#status-pill').filter({ hasText: 'Saved' }).waitFor({ state: 'visible' });
      const storedSave = await page.evaluate((id) => localStorage.getItem(`lilly:${id}:save`), projectId);
      assert(Boolean(storedSave), 'Opaque-origin player save was not persisted through the bounded parent bridge');
    });

    await record('publish-failure-preserves-preview', async () => {
      await page.getByRole('button', { name: 'Publish HTTPS', exact: true }).click();
      await page.getByRole('button', { name: /^Console/ }).click();
      await page.getByText(/Publishing requires the configured PostgreSQL and managed-app\/GitLab deployment lane/).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Build Output', exact: true }).click();
      const previewButton = page.getByRole('button', { name: 'Private preview', exact: true });
      await previewButton.waitFor({ state: 'visible' });
      await previewButton.click();
      assert(await page.locator('.build-preview-wrap iframe').isVisible(), 'Private preview was removed after the publish lane rejected the request');
    });

    await record('rollback', async () => {
      const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && /\/rollback$/.test(new URL(response.url()).pathname));
      await page.getByRole('button', { name: 'Rollback to r1', exact: true }).click();
      const response = await responsePromise;
      assert(response.ok(), `Rollback failed with HTTP ${response.status()}`);
      await page.getByRole('button', { name: /^Console/ }).click();
      await page.getByText(/Rolled back r\d+ to snapshot r1/).waitFor({ state: 'visible' });
    });

    await record('mobile-create-and-touch-flow', async () => {
      const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
      const mobilePage = await mobileContext.newPage();
      mobilePage.on('console', (message) => {
        if (message.type() === 'error') report.consoleErrors.push({ text: message.text().slice(0, 500), location: message.location(), viewport: 'mobile' });
      });
      mobilePage.on('pageerror', (error) => report.pageErrors.push(`[mobile] ${String(error.message || error).slice(0, 500)}`));
      mobilePage.on('response', (response) => {
        if (response.status() >= 400) report.httpErrors.push({ status: response.status(), url: response.url(), viewport: 'mobile' });
      });
      await mobilePage.addInitScript((id) => {
        if (location.pathname.startsWith('/game-studio')) localStorage.setItem('lilly-game-studio:project', id);
      }, projectId);
      await mobilePage.goto(args.url, { waitUntil: 'domcontentloaded' });
      await mobilePage.locator('.mobile-creator.open').waitFor({ state: 'visible' });
      await mobilePage.locator('#mobile-level-prompt').fill('Make a calm verdant temple with 6 rooms, 3 relics, and 2 gentle traps.');
      const mobileProposal = mobilePage.waitForResponse((response) => response.request().method() === 'POST' && /\/ai-runs$/.test(new URL(response.url()).pathname));
      await mobilePage.locator('.mobile-creator').getByRole('button', { name: 'Generate level', exact: true }).click();
      assert((await mobileProposal).ok(), 'Mobile AI level proposal request failed');
      await mobilePage.getByText('Ready to apply', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      await waitForCommand(mobilePage, () => mobilePage.getByRole('button', { name: 'Use this level', exact: true }).click());
      await mobilePage.screenshot({ path: path.join(args.outDir, 'lilly-game-studio-mobile-create.png'), fullPage: false });
      await mobilePage.locator('.mobile-creator .creator-actions').getByRole('button', { name: 'Play', exact: true }).click();
      await mobilePage.locator('.editor-touch-controls').waitFor({ state: 'visible' });
      const touchUp = mobilePage.locator('.editor-touch-controls .touch-up');
      await touchUp.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true });
      await mobilePage.waitForTimeout(250);
      assert(await touchUp.getAttribute('data-pressed') === 'true', 'Touch movement did not enter pressed state');
      await touchUp.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', isPrimary: true });
      await mobilePage.screenshot({ path: path.join(args.outDir, 'lilly-game-studio-mobile.png'), fullPage: false });
      await mobileContext.close();
    });

    const screenshotPath = path.join(args.outDir, 'lilly-game-studio-smoke.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    report.screenshotPath = screenshotPath;
    report.finalProject = await requestJson(`${origin}/api/game-studio/projects/${projectId}`);
    assert(report.pageErrors.length === 0, `Page errors: ${report.pageErrors.join('; ')}`);
    const expectedPublishErrors = report.httpErrors.filter((entry) => entry.status === 503 && /\/publish$/.test(new URL(entry.url).pathname));
    const unexpectedHttpErrors = report.httpErrors.filter((entry) => !expectedPublishErrors.includes(entry));
    assert(unexpectedHttpErrors.length === 0, `Unexpected HTTP errors: ${JSON.stringify(unexpectedHttpErrors)}`);
    const unexpectedConsoleErrors = report.consoleErrors.filter((message) => !/Failed to load resource: the server responded with a status of 503/.test(message.text));
    assert(unexpectedConsoleErrors.length === 0, `Console errors: ${JSON.stringify(unexpectedConsoleErrors)}`);
    report.status = 'passed';
    report.finishedAt = new Date().toISOString();
    await context.close();
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    report.finishedAt = new Date().toISOString();
    throw error;
  } finally {
    await fs.writeFile(path.join(args.outDir, 'lilly-game-studio-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
  }

  console.log(`LILLY_GAME_STUDIO_SMOKE=${JSON.stringify({ status: report.status, projectId: report.projectId, steps: report.steps.length, screenshotPath: report.screenshotPath })}`);
}

run().catch((error) => {
  console.error(`[LillyGameStudioSmoke] ${error.stack || error.message}`);
  process.exitCode = 1;
});
