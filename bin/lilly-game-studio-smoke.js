#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright-core');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function redactPreviewTokens(value = '') {
  return String(value || '').replace(/(\/(?:preview|sandbox)-access\/)[^/?#]+/gi, '$1[redacted]');
}

function createTriangleGlb() {
  const binary = Buffer.alloc(44);
  const positions = new Float32Array([-0.6, 0, 0, 0.6, 0, 0, 0, 1, 0]);
  Buffer.from(positions.buffer).copy(binary, 0);
  binary.writeUInt16LE(0, 36);
  binary.writeUInt16LE(1, 38);
  binary.writeUInt16LE(2, 40);
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: 'Lilly Game Studio smoke' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Lilly Triangle' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }, { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.6, 0, 0], max: [0.6, 1, 0] }, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR', min: [0], max: [2] }],
  }));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const totalLength = 12 + 8 + jsonLength + 8 + binary.length;
  const glb = Buffer.alloc(totalLength, 0x20);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLength, 8);
  glb.writeUInt32LE(jsonLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);
  const binaryHeader = 20 + jsonLength;
  glb.writeUInt32LE(binary.length, binaryHeader);
  glb.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(glb, binaryHeader + 8);
  return glb;
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
  const apiToken = String(process.env.KIMIBUILT_UI_CHECK_TOKEN || process.env.KIMIBUILT_FRONTEND_API_KEY || '').trim();
  const apiAuthHeaders = apiToken ? { authorization: `Bearer ${apiToken}`, 'x-api-key': apiToken } : {};
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
    headers: apiAuthHeaders,
    body: JSON.stringify({
      name: projectName,
      prompt: 'A compact neon ruin with 7 readable rooms, two fair combat encounters, four guardians, checkpoints, 5 energy cores, pulse traps, and a clear exit beacon.',
      seed: 'browser-canary-seed',
    }),
  });
  const projectId = created.project.id;
  report.projectId = projectId;
  const modelBytes = createTriangleGlb();
  let uploaded = null;

  const executablePath = await existingBrowser();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    let browserAuthCookie = null;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    if (apiToken) {
      const previewSession = await requestJson(`${origin}/api/auth/ws-token`, { headers: apiAuthHeaders });
      assert(previewSession.token, 'Authenticated browser smoke did not receive a signed session token');
      const parsedOrigin = new URL(origin);
      browserAuthCookie = {
        name: process.env.KIMIBUILT_AUTH_COOKIE || process.env.LILLYBUILT_AUTH_COOKIE || 'lillybuilt_auth',
        value: previewSession.token,
        domain: parsedOrigin.hostname,
        path: '/',
        httpOnly: true,
        secure: parsedOrigin.protocol === 'https:',
        sameSite: 'Lax',
      };
      await context.addCookies([browserAuthCookie]);
      report.authenticated = true;
    }
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        const location = message.location();
        report.consoleErrors.push({ text: redactPreviewTokens(message.text()).slice(0, 500), location: { ...location, url: redactPreviewTokens(location.url) } });
      }
    });
    page.on('pageerror', (error) => report.pageErrors.push(redactPreviewTokens(error.message || error).slice(0, 500)));
    page.on('response', (response) => {
      if (response.status() >= 400) report.httpErrors.push({ status: response.status(), url: redactPreviewTokens(response.url()) });
    });
    await page.addInitScript((id) => {
      window.__LILLY_SMOKE_MESSAGES__ = [];
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.schema !== 'LillyPlayerStorage/v1') return;
        window.__LILLY_SMOKE_MESSAGES__.push({
          schema: message.schema,
          type: message.type,
          projectId: message.projectId,
          requestId: message.requestId,
          ok: message.ok,
          sourceIsParent: event.source === window.parent,
          sourceIsTop: event.source === window.top,
        });
      });
      if (location.pathname.startsWith('/game-studio')) localStorage.setItem('lilly-game-studio:project', id);
    }, projectId);

    await record('open-editor', async () => {
      await page.goto(args.url, { waitUntil: 'domcontentloaded' });
      await page.locator('.studio-app').waitFor({ state: 'visible' });
      await page.getByText(projectName, { exact: true }).first().waitFor({ state: 'visible' });
    });

    await record('shared-game-data', async () => {
      await page.getByRole('button', { name: /^Game Data/ }).click();
      await page.locator('.data-workspace').waitFor({ state: 'visible' });
      const initialAssets = await page.locator('.data-asset-list > button').count();
      await waitForCommand(page, () => page.locator('.data-editor').getByRole('button', { name: 'New', exact: true }).click());
      await page.locator('.data-asset-list > button').nth(initialAssets).waitFor({ state: 'visible' });
      const dataResponse = await requestJson(`${origin}/api/game-studio/projects/${projectId}/data-assets`, { headers: apiAuthHeaders });
      assert(dataResponse.dataAssets.length === initialAssets + 1, `Shared data asset did not persist: ${JSON.stringify(dataResponse)}`);
      report.sharedDataProof = { dataAssetId: dataResponse.dataAssets.at(-1).id, count: dataResponse.dataAssets.length };
      await page.getByRole('button', { name: /^Content Browser/ }).click();
    });

    await record('raw-binary-asset-upload-and-byte-replay', async () => {
      const uploadResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/assets$/.test(new URL(response.url()).pathname));
      await page.locator('#game-studio-import-asset').setInputFiles({ name: 'Lilly Triangle Model.glb', mimeType: 'model/gltf-binary', buffer: modelBytes });
      const response = await uploadResponse;
      assert(response.ok(), `Raw binary GLB upload failed with HTTP ${response.status()}`);
      uploaded = await response.json();
      await page.getByRole('button', { name: 'Lilly Triangle Model model', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      const uploadedResponse = await fetch(`${origin}/api/game-studio/projects/${projectId}/assets/${uploaded.asset.id}/content`, { headers: apiAuthHeaders });
      const uploadedBytes = Buffer.from(await uploadedResponse.arrayBuffer());
      assert(uploadedResponse.ok && uploadedBytes.equals(modelBytes), 'Uploaded GLB did not replay byte-for-byte through the authenticated asset route');
      report.assetProof = { id: uploaded.asset.id, sizeBytes: uploadedBytes.length, kind: uploaded.asset.metadata?.kind, glbMagic: uploadedBytes.subarray(0, 4).toString('hex'), transport: 'application/octet-stream' };
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
      const source = page.locator('.react-flow__node').filter({ hasText: /Progress complete\?|Exit unlocked\?|Score = 5\?/ }).locator('.react-flow__handle.source').first();
      const target = delayNode.locator('.react-flow__handle.target').first();
      await connectHandles(page, source, target);
      await page.waitForFunction((count) => document.querySelectorAll('.react-flow__edge').length > count, initialEdgeCount, { timeout: 5000 });
      await waitForCommand(page, () => page.getByRole('button', { name: 'Compile & save', exact: true }).click());
      await page.getByText('Graph valid', { exact: true }).waitFor({ state: 'visible' });
    });

    await record('agent-module-author-compile-and-spec', async () => {
      await page.getByRole('button', { name: /^Code & Modules/ }).click();
      const sourceWrite = page.waitForResponse((response) => response.request().method() === 'PUT' && /\/files$/.test(new URL(response.url()).pathname));
      const inputWrite = page.waitForResponse((response) => response.request().method() === 'POST' && /\/commands$/.test(new URL(response.url()).pathname));
      await page.getByRole('button', { name: 'New mechanic package', exact: true }).click();
      assert((await sourceWrite).ok(), 'Agent mechanic package did not persist');
      assert((await inputWrite).ok(), 'Agent mechanic input action did not persist');
      await page.getByText('mechanic-1.system.ts', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      const compileResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/compile$/.test(new URL(response.url()).pathname));
      await page.getByRole('button', { name: 'Compile', exact: true }).click();
      const compiled = await compileResponse;
      assert(compiled.ok(), `Agent module compile failed with HTTP ${compiled.status()}`);
      const compileBody = await compiled.json();
      assert(compileBody.valid === true && compileBody.systems?.length === 1, `Unexpected compile report: ${JSON.stringify(compileBody)}`);
      const testResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/mechanic-tests$/.test(new URL(response.url()).pathname));
      await page.getByRole('button', { name: /^Run specs/ }).click();
      const tested = await testResponse;
      assert(tested.ok(), `Agent mechanic specs failed with HTTP ${tested.status()}`);
      const testBody = await tested.json();
      assert(testBody.status === 'passed' && testBody.passed === 1, `Unexpected mechanic test report: ${JSON.stringify(testBody)}`);
      await page.getByRole('button', { name: /Run specs 1\/1/ }).waitFor({ state: 'visible' });
    });

    await record('ai-command-review-and-apply', async () => {
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await page.locator('#level-prompt').fill('Build a hard ember foundry with 8 rooms, two combat encounters, four guardians, checkpoints, 4 cores, 6 traps, and a clear exit.');
      const proposalResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/ai-runs$/.test(new URL(response.url()).pathname));
      await page.getByRole('button', { name: 'Generate game', exact: true }).click();
      assert((await proposalResponse).ok(), 'AI level proposal request failed');
      const director = page.locator('.ai-panel');
      await director.getByText('Ready to apply', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      await director.locator('.proposal-metrics').getByText('8', { exact: true }).waitFor({ state: 'visible' });
      await waitForCommand(page, () => director.getByRole('button', { name: 'Use this level', exact: true }).click());
      await page.getByRole('button', { name: 'Close AI Director' }).click();
    });

    await record('world-pack-authoring-variant-and-layout-matrix', async () => {
      await page.getByRole('button', { name: /^Content Browser/ }).click();
      const sourceWrite = page.waitForResponse((response) => response.request().method() === 'PUT' && /\/files$/.test(new URL(response.url()).pathname));
      await page.getByRole('button', { name: 'New world pack', exact: true }).click();
      const sourceResponse = await sourceWrite;
      assert(sourceResponse.ok(), `World pack source write failed with HTTP ${sourceResponse.status()}`);
      const authored = await sourceResponse.json();
      const worldModule = authored.moduleSummary.modules.find((module) => /^world-pack-/.test(module.id));
      const worldPrefab = authored.moduleSummary.prefabs.find((prefab) => prefab.moduleId === worldModule?.id);
      assert(worldModule && worldPrefab, `World pack module or prefab was not exported: ${JSON.stringify(authored.moduleSummary)}`);
      assert(authored.moduleSummary.materials.some((entry) => entry.moduleId === worldModule.id), 'World pack material was not exported');
      assert(authored.moduleSummary.assets.some((entry) => entry.moduleId === worldModule.id && entry.assetId === uploaded.asset.id), 'World pack asset metadata did not bind the uploaded GLB');
      assert(authored.moduleSummary.animations.some((entry) => entry.moduleId === worldModule.id), 'World pack animation controller was not exported');
      assert(authored.moduleSummary.terrains.some((entry) => entry.moduleId === worldModule.id), 'World pack terrain was not exported');
      assert(worldPrefab.variants.some((variant) => variant.id === 'sentinel'), 'World pack sentinel variant was not exposed to the editor');
      await page.getByText(`${worldModule.id}.module.json`, { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      const compileResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/compile$/.test(new URL(response.url()).pathname));
      await page.getByRole('button', { name: 'Compile', exact: true }).click();
      const compiledResponse = await compileResponse;
      assert(compiledResponse.ok(), `World pack compile failed with HTTP ${compiledResponse.status()}`);
      const compiled = await compiledResponse.json();
      assert(compiled.valid === true && compiled.worldIssues.length === 0, `World pack compile was invalid: ${JSON.stringify(compiled)}`);

      await page.getByRole('button', { name: /^Content Browser/ }).click();
      await page.getByRole('button', { name: 'Prefabs', exact: true }).click();
      const prefabCard = page.locator('.asset-card-shell').filter({ hasText: worldPrefab.name });
      await prefabCard.getByLabel(`${worldPrefab.name} variant`).selectOption('sentinel');
      const placedResponse = page.waitForResponse((response) => response.request().method() === 'POST' && /\/prefab-instances$/.test(new URL(response.url()).pathname));
      await prefabCard.getByRole('button', { name: `Place ${worldPrefab.name}`, exact: true }).click();
      const placed = await placedResponse;
      assert(placed.ok(), `World pack prefab placement failed with HTTP ${placed.status()}`);
      const placedProject = await placed.json();
      const sentinel = placedProject.project.scenes.flatMap((scene) => scene.entities).find((entity) => entity.name === 'Sentinel Landmark');
      assert(sentinel, 'Selected prefab variant did not create the Sentinel Landmark entity');
      const linkedRoot = placedProject.project.scenes.flatMap((scene) => scene.entities).find((entity) => entity.tags.some((tag) => tag.startsWith('instance:')) && entity.parentId === 'world');
      assert(linkedRoot, 'Placed prefab did not preserve a linked instance root');
      await page.locator('.tree-row').filter({ hasText: linkedRoot.name }).last().click();
      const prefabBanner = page.locator('.prefab-link-banner');
      await prefabBanner.getByText('Linked prefab', { exact: true }).waitFor({ state: 'visible' });
      assert(await page.getByRole('button', { name: 'Add component', exact: true }).isDisabled(), 'Linked prefab allowed a destructive component-structure edit');
      await waitForCommand(page, () => prefabBanner.getByRole('button', { name: 'Refresh', exact: true }).click());

      const layoutProof = [];
      for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
        await page.setViewportSize(viewport);
        await page.waitForTimeout(150);
        const metrics = await page.evaluate(() => {
          const toolbar = document.querySelector('.content-actions');
          const toolbarRect = toolbar?.getBoundingClientRect();
          const clippedControls = toolbarRect ? [...toolbar.querySelectorAll(':scope > button, :scope > .search-field')]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.left < toolbarRect.left - 1 || rect.right > toolbarRect.right + 1 || rect.top < toolbarRect.top - 1 || rect.bottom > toolbarRect.bottom + 1;
            }).map((element) => element.textContent?.trim() || element.className) : [];
          return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth, clippedControls };
        });
        assert(metrics.documentWidth <= metrics.viewportWidth + 1, `Editor overflowed at ${viewport.width}x${viewport.height}: ${JSON.stringify(metrics)}`);
        assert(metrics.clippedControls.length === 0, `Content controls clipped at ${viewport.width}x${viewport.height}: ${JSON.stringify(metrics)}`);
        const screenshotPath = path.join(args.outDir, `lilly-world-authoring-${viewport.width}x${viewport.height}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
        layoutProof.push({ ...viewport, screenshotPath, ...metrics });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      report.worldAuthoringProof = {
        moduleId: worldModule.id,
        prefabId: worldPrefab.id,
        variant: 'sentinel',
        entityId: sentinel.id,
        resourceCounts: { materials: compiled.materials.length, assets: compiled.assets.length, animations: compiled.animations.length, terrains: compiled.terrains.length },
        layoutProof,
      };
    });

    await record('play-pause-step', async () => {
      await page.getByTitle(/^Play/).click();
      await page.getByText(/Simulation running/).waitFor({ state: 'visible', timeout: 30000 });
      const editorFrame = page.frameLocator('.exact-play-preview iframe');
      await editorFrame.locator('#game-canvas').waitFor({ state: 'visible', timeout: 30000 });
      const runningState = await editorFrame.locator('body').evaluate(async () => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const state = window.__LILLY_GAME__?.getState?.();
          if (state?.systemCount > 0) return state;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
      });
      assert(runningState?.systemCount === 1 && runningState?.moduleSourceHash, `Editor Play did not load the exact module bundle: ${JSON.stringify(runningState)}`);
      assert(runningState.materialCount >= 1 && runningState.assetMetadataCount >= 1 && runningState.animationControllerCount >= 1 && runningState.terrainCount >= 1, `Editor Play did not load the exact authored world resources: ${JSON.stringify(runningState)}`);
      await page.locator('.viewport-panel').screenshot({ path: path.join(args.outDir, 'lilly-editor-exact-play.png') });
      await page.getByTitle(/^Pause/).click();
      await page.getByText('Paused — step to advance', { exact: true }).waitFor({ state: 'visible' });
      const pausedState = await editorFrame.locator('body').evaluate(async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const state = window.__LILLY_GAME__?.getState?.();
          if (state?.editorPaused === true) return state;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return window.__LILLY_GAME__?.getState?.() || null;
      });
      assert(pausedState?.editorPaused === true, `Exact editor player did not pause: ${JSON.stringify(pausedState)}`);
      await page.getByTitle(/^Step/).click();
      assert(await page.locator('.viewport-panel.mode-paused').isVisible(), 'Step did not leave the editor in paused play mode');
      const steppedState = await editorFrame.locator('body').evaluate(async (before) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const state = window.__LILLY_GAME__?.getState?.();
          if ((state?.editorCompletedSteps || 0) > before) return state;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return window.__LILLY_GAME__?.getState?.() || null;
      }, pausedState.editorCompletedSteps || 0);
      assert(steppedState?.editorPaused === true && steppedState?.editorCompletedSteps > (pausedState.editorCompletedSteps || 0), `Exact editor player did not advance one paused step: ${JSON.stringify(steppedState)}`);
      report.editorPlayProof = { runningState, pausedState, steppedState };
      await page.getByTitle('Stop play mode').click();
    });

    await record('immutable-build-and-private-replay', async () => {
      await page.getByRole('button', { name: 'Build Output', exact: true }).click();
      const profileSelect = page.locator('.profile-editor label').filter({ hasText: 'Build profile' }).locator('select');
      const initialProfileCount = await profileSelect.locator('option').count();
      await waitForCommand(page, () => page.getByRole('button', { name: 'Duplicate as new', exact: true }).click());
      await profileSelect.locator('option').nth(initialProfileCount).waitFor({ state: 'attached' });
      const selectedProfileId = await profileSelect.inputValue();
      const selectedProfileName = await page.locator('.profile-editor label').filter({ hasText: 'Name' }).locator('input').inputValue();
      assert(selectedProfileId.startsWith('custom-'), `Versioned build profile was not created: ${selectedProfileId}`);
      await page.locator('.build-summary-actions').getByRole('button', { name: `Build ${selectedProfileName}`, exact: true }).click();
      await page.getByRole('button', { name: 'Private preview', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      const buildCard = page.locator('.build-card').filter({ hasText: selectedProfileName });
      await buildCard.locator('.build-profile-pill').filter({ hasText: selectedProfileName }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Private preview', exact: true }).click();
      const previewIframe = page.locator('.build-preview-wrap iframe');
      await previewIframe.waitFor({ state: 'visible', timeout: 30000 });
      const previewSrc = await previewIframe.getAttribute('src');
      assert(previewSrc && /\/preview(?:-access\/[^/]+)?\/$/.test(new URL(previewSrc, origin).pathname), `Private preview did not use the direct player route: ${previewSrc}`);
      if (apiToken) assert(/\/preview-access\//.test(previewSrc), 'Authenticated private preview did not use signed path access');
      const frame = page.frameLocator('.build-preview-wrap iframe');
      await frame.locator('#game-canvas').waitFor({ state: 'visible', timeout: 30000 });
      const control = await frame.locator('body').evaluate(async () => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (window.__LILLY_GAME__?.controlTest) return window.__LILLY_GAME__.controlTest();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
      });
      assert(control?.passed === true, `Player control test failed: ${JSON.stringify(control)}`);
      const worldState = await frame.locator('body').evaluate(() => window.__LILLY_GAME__?.getState?.() || null);
      assert(worldState?.materialCount >= 1 && worldState?.assetMetadataCount >= 1 && worldState?.animationControllerCount >= 1 && worldState?.terrainCount >= 1, `Immutable player did not replay the authored world resource bundle: ${JSON.stringify(worldState)}`);
      const combat = await frame.locator('body').evaluate(() => window.__LILLY_GAME__?.combatTest?.() || null);
      assert(combat?.passed === true && combat?.cleared === true && combat?.checkpoint === true && combat?.gatesOpen === true, `Player combat/checkpoint test failed: ${JSON.stringify(combat)}`);
      const authoredModule = await frame.locator('body').evaluate(() => window.__LILLY_GAME__?.moduleTest?.() || null);
      assert(authoredModule?.passed === true && authoredModule?.systems?.length === 1, `Agent module runtime test failed: ${JSON.stringify(authoredModule)}`);
      const collision = await frame.locator('body').evaluate(() => window.__LILLY_GAME__?.collisionTest?.() || null);
      assert(collision?.passed === true && collision?.detected === true && collision?.handled === true, `Agent collision lifecycle test failed: ${JSON.stringify(collision)}`);
      report.runtimeProof = { control, combat, authoredModule, collision, worldState, buildProfileId: selectedProfileId, buildProfileName: selectedProfileName, previewPath: redactPreviewTokens(previewSrc) };
      await page.locator('.build-preview-wrap').screenshot({ path: path.join(args.outDir, 'lilly-generated-player.png') });
      await frame.getByRole('button', { name: 'Save', exact: true }).click();
      const savedAcknowledged = await frame.locator('#status-pill').filter({ hasText: 'Saved' }).waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
      const storedSave = await page.evaluate((id) => localStorage.getItem(`lilly:${id}:save`), projectId);
      const storageMessages = [];
      for (const browserFrame of page.frames()) {
        storageMessages.push({
          url: redactPreviewTokens(browserFrame.url()),
          messages: await browserFrame.evaluate(() => window.__LILLY_SMOKE_MESSAGES__ || []).catch(() => []),
        });
      }
      report.storageBridgeProof = { savedAcknowledged, stored: Boolean(storedSave), messages: storageMessages };
      assert(savedAcknowledged && Boolean(storedSave), `Opaque-origin player save bridge failed: ${JSON.stringify(report.storageBridgeProof)}`);
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
      if (browserAuthCookie) await mobileContext.addCookies([browserAuthCookie]);
      const mobilePage = await mobileContext.newPage();
      mobilePage.on('console', (message) => {
        if (message.type() === 'error') {
          const location = message.location();
          report.consoleErrors.push({ text: redactPreviewTokens(message.text()).slice(0, 500), location: { ...location, url: redactPreviewTokens(location.url) }, viewport: 'mobile' });
        }
      });
      mobilePage.on('pageerror', (error) => report.pageErrors.push(`[mobile] ${redactPreviewTokens(error.message || error).slice(0, 500)}`));
      mobilePage.on('response', (response) => {
        if (response.status() >= 400) report.httpErrors.push({ status: response.status(), url: redactPreviewTokens(response.url()), viewport: 'mobile' });
      });
      await mobilePage.addInitScript((id) => {
        if (location.pathname.startsWith('/game-studio')) localStorage.setItem('lilly-game-studio:project', id);
      }, projectId);
      await mobilePage.goto(args.url, { waitUntil: 'domcontentloaded' });
      await mobilePage.locator('.mobile-creator.open').waitFor({ state: 'visible' });
      await mobilePage.locator('#mobile-level-prompt').fill('Make a calm verdant temple with 6 rooms, one guardian encounter, two enemies, a checkpoint, 3 relics, and 2 gentle traps.');
      const mobileProposal = mobilePage.waitForResponse((response) => response.request().method() === 'POST' && /\/ai-runs$/.test(new URL(response.url()).pathname));
      await mobilePage.locator('.mobile-creator').getByRole('button', { name: 'Generate game', exact: true }).click();
      assert((await mobileProposal).ok(), 'Mobile AI level proposal request failed');
      await mobilePage.getByText('Ready to apply', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
      await waitForCommand(mobilePage, () => mobilePage.getByRole('button', { name: 'Use this level', exact: true }).click());
      await mobilePage.screenshot({ path: path.join(args.outDir, 'lilly-game-studio-mobile-create.png'), fullPage: false });
      await mobilePage.locator('.mobile-creator .creator-actions').getByRole('button', { name: 'Play', exact: true }).click();
      const mobileFrame = mobilePage.frameLocator('.exact-play-preview iframe');
      await mobileFrame.locator('#game-canvas').waitFor({ state: 'visible', timeout: 30000 });
      const mobileBefore = await mobileFrame.locator('body').evaluate(async () => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const state = window.__LILLY_GAME__?.getState?.();
          if (state) return state;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
      });
      assert(mobileBefore, 'Exact mobile player did not finish initializing');
      await mobileFrame.locator('.touch-controls').waitFor({ state: 'visible' });
      const touchUp = mobileFrame.locator('.touch-controls .touch-up');
      const movePressed = await touchUp.evaluate((element) => {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true }));
        return element.getAttribute('data-pressed');
      });
      assert(movePressed === 'true', 'Touch movement did not enter pressed state');
      await mobilePage.waitForTimeout(250);
      await touchUp.evaluate((element) => element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true })));
      const mobileAfter = await mobileFrame.locator('body').evaluate(() => window.__LILLY_GAME__?.getState?.() || null);
      assert(mobileAfter?.playerPosition?.[2] < mobileBefore.playerPosition[2] - 0.01, `Touch movement did not move the exact player: ${JSON.stringify({ mobileBefore, mobileAfter })}`);
      const touchAttack = mobileFrame.locator('.touch-action');
      const attackPressed = await touchAttack.evaluate((element) => {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8, pointerType: 'touch', isPrimary: true }));
        return element.getAttribute('data-pressed');
      });
      assert(attackPressed === 'true', 'Touch attack did not enter pressed state');
      await touchAttack.evaluate((element) => element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8, pointerType: 'touch', isPrimary: true })));
      report.mobilePlayProof = { before: mobileBefore.playerPosition, after: mobileAfter.playerPosition, moduleSourceHash: mobileAfter.moduleSourceHash };
      await mobilePage.screenshot({ path: path.join(args.outDir, 'lilly-game-studio-mobile.png'), fullPage: false });
      await mobileContext.close();
    });

    const screenshotPath = path.join(args.outDir, 'lilly-game-studio-smoke.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    report.screenshotPath = screenshotPath;
    report.finalProject = await requestJson(`${origin}/api/game-studio/projects/${projectId}`, { headers: apiAuthHeaders });
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
    report.error = redactPreviewTokens(error.message);
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
