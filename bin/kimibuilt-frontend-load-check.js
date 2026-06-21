#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');

const DEFAULT_BROWSER_ARGS = [
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-features=Translate,BackForwardCache',
  '--allow-running-insecure-content',
  '--ignore-certificate-errors',
];

const DEFAULT_ROUTES = [
  ['web-chat', '/web-chat/'],
  ['notes', '/notes/'],
  ['web-cli', '/web-cli/'],
  ['canvas', '/canvas/'],
];

const DEFAULT_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1000, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
];

function parseArgs(argv = []) {
  const args = {
    baseUrl: 'http://127.0.0.1:3000',
    maxMs: 50,
    outDir: 'ui-checks/perf-critical-shell-gate',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') {
      args.baseUrl = argv[index + 1] || args.baseUrl;
      index += 1;
    } else if (arg === '--max-ms') {
      args.maxMs = Number(argv[index + 1] || args.maxMs);
      index += 1;
    } else if (arg === '--out') {
      args.outDir = argv[index + 1] || args.outDir;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function printUsage() {
  console.log([
    'Usage: kimibuilt-frontend-load-check [--base-url http://127.0.0.1:3000] [--max-ms 50] [--out ui-checks/perf-critical-shell-gate]',
    '',
    'Checks the four active frontend entry routes for critical-shell readiness.',
    'The target server must already be running.',
  ].join('\n'));
}

function loadPlaywright() {
  for (const moduleName of ['playwright', 'playwright-core']) {
    try {
      const loaded = require(moduleName);
      if (loaded?.chromium) {
        return {
          chromium: loaded.chromium,
          moduleName,
        };
      }
    } catch (_error) {
      // Try the next package name.
    }
  }

  throw new Error('Playwright is not installed. Install playwright or playwright-core.');
}

async function fileExists(filePath = '') {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function resolveBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    process.env.ARTIFACT_BROWSER_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.BROWSER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ].filter(Boolean);

  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || '';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  }

  for (const candidate of candidates) {
    if (candidate && await fileExists(candidate)) {
      return candidate;
    }
  }

  return '';
}

function buildUrl(baseUrl, routePath) {
  return new URL(routePath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href;
}

async function measureRoute(browser, route, viewport, baseUrl) {
  const [pageName, routePath] = route;
  const context = await browser.newContext({
    viewport: {
      width: viewport.width,
      height: viewport.height,
    },
    isMobile: viewport.isMobile === true,
    userAgent: 'KimiBuilt-Frontend-Load-Check/1.0',
  });

  try {
    const page = await context.newPage();
    const url = buildUrl(baseUrl, routePath);
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    const metrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')?.[0] || null;
      const shell = window.KimiBuiltFrontendLoadMetrics || null;
      const mark = performance.getEntriesByName('kimibuilt-critical-shell-ready')?.[0] || null;
      return {
        responseEndMs: navigation ? Math.round(navigation.responseEnd) : null,
        domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null,
        criticalShellReadyMs: shell?.criticalShellReadyMs ?? null,
        criticalShellMarkMs: mark ? Math.round(mark.startTime) : null,
        title: document.title,
        bodyTextLength: (document.body?.innerText || '').trim().length,
      };
    });

    return {
      page: pageName,
      viewport: viewport.name,
      url,
      ...metrics,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const { chromium, moduleName } = loadPlaywright();
  const executablePath = await resolveBrowserExecutable();
  if (!executablePath && moduleName === 'playwright-core') {
    throw new Error('playwright-core is installed, but no browser executable was found. Set PLAYWRIGHT_EXECUTABLE_PATH or ARTIFACT_BROWSER_PATH.');
  }

  const browser = await chromium.launch({
    headless: true,
    args: DEFAULT_BROWSER_ARGS,
    ...(executablePath ? { executablePath } : {}),
  });

  const results = [];
  try {
    await measureRoute(browser, DEFAULT_ROUTES[0], DEFAULT_VIEWPORTS[0], args.baseUrl);
    for (const viewport of DEFAULT_VIEWPORTS) {
      for (const route of DEFAULT_ROUTES) {
        results.push(await measureRoute(browser, route, viewport, args.baseUrl));
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const failures = results.filter((result) => (
    result.responseEndMs === null
    || result.criticalShellReadyMs === null
    || result.responseEndMs > args.maxMs
    || result.criticalShellReadyMs > args.maxMs
  ));
  const report = {
    tool: 'kimibuilt-frontend-load-check',
    baseUrl: args.baseUrl,
    maxMs: args.maxMs,
    generatedAt: new Date().toISOString(),
    playwrightModule: moduleName,
    browserExecutable: executablePath || '',
    ok: failures.length === 0,
    results,
    failures,
  };

  await fs.mkdir(args.outDir, { recursive: true });
  const reportPath = path.resolve(args.outDir, 'frontend-load-report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`FRONTEND_LOAD_REPORT=${reportPath}`);
  console.log(`KIMIBUILT_FRONTEND_LOAD_RESULT=${JSON.stringify({
    ok: report.ok,
    checked: results.length,
    failures: failures.length,
    maxMs: args.maxMs,
  })}`);

  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`[kimibuilt-frontend-load-check] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildUrl,
  parseArgs,
};
