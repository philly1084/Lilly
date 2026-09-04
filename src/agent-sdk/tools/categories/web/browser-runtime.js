const fs = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { config } = require('../../../../config');
const { artifactService } = require('../../../../artifacts/artifact-service');
const { getApiBaseUrl, normalizeBrowserReachableUrl } = require('./internal-url');
const { resolveFrontendApiKey } = require('../../../../auth/service');

const execFileAsync = promisify(execFile);

const DEFAULT_BROWSER_ARGS = [
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-features=Translate,BackForwardCache',
  '--allow-running-insecure-content',
  '--ignore-certificate-errors',
];

const DEFAULT_USER_AGENT = 'KimiBuilt-Agent/1.0 (Automated Browser Research)';
const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const MIN_VIEWPORT_EDGE = 240;
const MAX_VIEWPORT_EDGE = 4096;
const privateWorkspaceLocks = new Map();

function splitArgs(value = '') {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getBrowserCandidates() {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    config.artifacts.browserPath,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.BROWSER_EXECUTABLE_PATH,
    process.env.CHROME_BIN,
  ];

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
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium',
      'chromium',
      'chromium-browser',
      'google-chrome',
      'google-chrome-stable',
    );
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

async function resolveSystemBrowserPath() {
  for (const candidate of getBrowserCandidates()) {
    if (candidate.includes(path.sep)) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }

    return candidate;
  }

  return null;
}

function loadPlaywrightPackage() {
  const moduleNames = ['playwright', 'playwright-core'];

  for (const moduleName of moduleNames) {
    try {
      const loaded = require(moduleName);
      if (loaded?.chromium) {
        return { moduleName, chromium: loaded.chromium };
      }
    } catch (error) {
      const missingModule = error?.code === 'MODULE_NOT_FOUND'
        && String(error.message || '').includes(moduleName);
      if (!missingModule) {
        throw error;
      }
    }
  }

  return null;
}

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeViewport(value = null) {
  if (!value) {
    return { ...DEFAULT_VIEWPORT };
  }

  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{2,5})x(\d{2,5})$/i);
    if (match) {
      return normalizeViewport({
        width: Number(match[1]),
        height: Number(match[2]),
      });
    }
  }

  if (typeof value !== 'object') {
    return { ...DEFAULT_VIEWPORT };
  }

  const width = Math.trunc(Number(value.width));
  const height = Math.trunc(Number(value.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { ...DEFAULT_VIEWPORT };
  }

  return {
    width: Math.max(MIN_VIEWPORT_EDGE, Math.min(width, MAX_VIEWPORT_EDGE)),
    height: Math.max(MIN_VIEWPORT_EDGE, Math.min(height, MAX_VIEWPORT_EDGE)),
  };
}

function resolvePrivateBrowserWorkspace(value = '') {
  const scope = String(value || '').trim();
  if (!scope) return null;
  const digest = crypto.createHash('sha256').update(scope).digest('hex');
  return {
    private: true,
    persistent: true,
    scope: 'workload',
    id: digest.slice(0, 24),
    userDataDir: path.join(config.persistence.dataDir, 'agent-browser-workspaces', digest),
  };
}

async function withPrivateWorkspaceLock(workspace, action) {
  if (!workspace?.id) return action();
  const previous = privateWorkspaceLocks.get(workspace.id) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  privateWorkspaceLocks.set(workspace.id, current);
  await previous.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (privateWorkspaceLocks.get(workspace.id) === current) {
      privateWorkspaceLocks.delete(workspace.id);
    }
  }
}

function normalizeUrl(url) {
  const value = normalizeBrowserReachableUrl(url);
  if (!value) {
    throw new Error('URL is required');
  }

  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(withScheme);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
    return parsed.toString();
  } catch (error) {
    throw new Error(`Invalid URL '${value}': ${error.message}`);
  }
}

function truncateText(value = '', limit = config.scrape.contentCharLimit) {
  const text = String(value || '').trim();
  if (text.length <= limit) {
    return text;
  }

  return text.slice(0, limit);
}

function isInternalApiUrl(url = '') {
  try {
    const parsed = new URL(url);
    const hostname = String(parsed.hostname || '').toLowerCase();
    const localHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    if (!parsed.pathname.startsWith('/api/')) {
      return false;
    }
    if (localHost || hostname === 'api') {
      return true;
    }

    const configured = getApiBaseUrl();
    if (!configured) {
      return false;
    }
    const configuredOrigin = new URL(configured).origin;
    return parsed.origin === configuredOrigin;
  } catch (_error) {
    return false;
  }
}

function buildInternalBrowserHeaders(url = '') {
  const apiKey = String(
    process.env.KIMIBUILT_FRONTEND_API_KEY
    || process.env.FRONTEND_API_KEY
    || resolveFrontendApiKey()
    || '',
  ).trim();
  if (!apiKey || !isInternalApiUrl(url)) {
    return {};
  }

  return {
    'x-api-key': apiKey,
  };
}

function assertNotAuthWall(snapshot = {}, url = '') {
  const text = normalizeText([
    snapshot.title || '',
    snapshot.text || '',
    snapshot.html || '',
  ].join(' '));

  if (/\bAuthentication required\b/i.test(text) && /\bmissing_token\b/i.test(text)) {
    const error = new Error(`Browser QA hit an authentication wall for ${url}: missing_token`);
    error.code = 'browser_auth_wall';
    error.diagnostics = {
      url,
      title: snapshot.title || '',
      reason: 'missing_token',
    };
    throw error;
  }
}

async function captureScreenshotArtifact({
  page,
  sessionId,
  url,
  title = '',
  contentText = '',
  fullPage = true,
  viewport = null,
  privateWorkspace = null,
  workloadId = null,
}) {
  if (!sessionId) {
    return {
      available: false,
      reason: 'captureScreenshot requires a sessionId in the tool context',
    };
  }

  const buffer = await page.screenshot({
    type: 'png',
    fullPage: fullPage !== false,
  });
  const safeSlug = (title || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'page';
  const stored = await artifactService.createStoredArtifact({
    sessionId,
    direction: 'generated',
    sourceMode: 'chat',
    filename: `${safeSlug}-screenshot.png`,
    extension: 'png',
    mimeType: 'image/png',
    buffer,
    extractedText: truncateText(contentText || title || url, 2000),
    previewHtml: '',
    metadata: {
      browserCapture: true,
      sourceUrl: url,
      pageTitle: title,
      viewport,
      ...(privateWorkspace ? {
        privateAgentWorkspace: true,
        browserWorkspaceId: privateWorkspace.id,
        browserWorkspaceScope: privateWorkspace.scope,
        workloadId: String(workloadId || '').trim() || null,
      } : {}),
    },
    vectorize: false,
  });

  return {
    available: true,
    artifact: artifactService.serializeArtifact(stored),
  };
}

async function runPageActions(page, actions = [], timeout = 30000) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return [];
  }

  const normalizedTimeout = Math.max(1000, Number(timeout) || 30000);
  const executed = [];

  for (const action of actions) {
    if (!action || typeof action !== 'object') {
      continue;
    }

    const type = String(action.type || '').trim().toLowerCase();
    if (!type) {
      continue;
    }

    const selector = String(action.selector || '').trim();
    const text = String(action.text || action.value || '').trim();
    const ms = Math.max(0, Math.min(Number(action.ms) || 0, normalizedTimeout));

    switch (type) {
      case 'wait_for_timeout':
      case 'wait':
        await page.waitForTimeout(ms || 500);
        break;
      case 'wait_for_selector':
        if (!selector) {
          throw new Error('wait_for_selector action requires `selector`');
        }
        await page.waitForSelector(selector, {
          timeout: normalizedTimeout,
          state: action.state || 'visible',
        });
        break;
      case 'click':
        if (!selector) {
          throw new Error('click action requires `selector`');
        }
        await page.click(selector, { timeout: normalizedTimeout });
        break;
      case 'hover':
        if (!selector) {
          throw new Error('hover action requires `selector`');
        }
        await page.hover(selector, { timeout: normalizedTimeout });
        break;
      case 'type':
        if (!selector) {
          throw new Error('type action requires `selector`');
        }
        await page.type(selector, text, {
          timeout: normalizedTimeout,
          delay: Number.isFinite(Number(action.delay)) ? Math.max(0, Number(action.delay)) : 20,
        });
        break;
      case 'fill':
        if (!selector) {
          throw new Error('fill action requires `selector`');
        }
        await page.fill(selector, text, { timeout: normalizedTimeout });
        break;
      case 'press':
        if (selector) {
          await page.press(selector, String(action.key || 'Enter'), { timeout: normalizedTimeout });
        } else {
          await page.keyboard.press(String(action.key || 'Enter'));
        }
        break;
      case 'select':
      case 'select_option': {
        if (!selector) {
          throw new Error('select_option action requires `selector`');
        }

        const values = Array.isArray(action.values)
          ? action.values.map((entry) => String(entry))
          : [String(action.value || '')].filter(Boolean);
        await page.selectOption(selector, values, { timeout: normalizedTimeout });
        break;
      }
      case 'scroll':
        if (selector) {
          await page.locator(selector).scrollIntoViewIfNeeded({ timeout: normalizedTimeout });
        } else {
          await page.mouse.wheel(
            Number.isFinite(Number(action.x)) ? Number(action.x) : 0,
            Number.isFinite(Number(action.y)) ? Number(action.y) : 800,
          );
        }
        break;
      default:
        throw new Error(`Unsupported browser action type: ${type}`);
    }

    executed.push({
      type,
      selector: selector || null,
    });
  }

  return executed;
}

async function collectPageSnapshot(page, {
  selectors = null,
  contentCharLimit = config.scrape.contentCharLimit,
  linkLimit = 24,
  headingLimit = 12,
  imageLimit = 12,
} = {}) {
  const html = await page.content();
  const snapshot = await page.evaluate((args) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const makeAbsoluteUrl = (value) => {
      const candidate = normalize(value);
      if (!candidate || candidate.startsWith('data:')) {
        return '';
      }

      try {
        return new URL(candidate, window.location.href).toString();
      } catch (_error) {
        return '';
      }
    };
    const transformElementValue = (element, config) => {
      const attribute = config?.attribute ? String(config.attribute) : '';
      const transform = config?.transform ? String(config.transform) : 'text';
      let raw = '';

      if (attribute) {
        raw = element.getAttribute(attribute) || '';
      } else if (transform === 'html') {
        raw = element.innerHTML || '';
      } else {
        raw = element.innerText || element.textContent || '';
      }

      const normalized = transform === 'html' ? String(raw || '') : normalize(raw);
      if (!normalized) {
        return transform === 'number' ? null : '';
      }

      if (transform === 'number') {
        const numeric = Number.parseFloat(normalized.replace(/[^0-9.-]/g, ''));
        return Number.isFinite(numeric) ? numeric : null;
      }

      if (transform === 'url') {
        return makeAbsoluteUrl(normalized) || normalized;
      }

      return normalized;
    };
    const selectorData = {};
    const selectorEntries = args.selectors && typeof args.selectors === 'object'
      ? Object.entries(args.selectors)
      : [];

    for (const [key, config] of selectorEntries) {
      const selector = typeof config?.selector === 'string' ? config.selector.trim() : '';
      if (!selector) {
        selectorData[key] = config?.multiple ? [] : null;
        continue;
      }

      const elements = Array.from(document.querySelectorAll(selector));
      if (config?.multiple) {
        selectorData[key] = elements.map((element) => transformElementValue(element, config));
      } else {
        selectorData[key] = elements[0] ? transformElementValue(elements[0], config) : null;
      }
    }

    const text = normalize(document.body?.innerText || '').slice(0, args.contentCharLimit);
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((element) => ({
        text: normalize(element.innerText || element.textContent || ''),
        url: makeAbsoluteUrl(element.getAttribute('href') || ''),
      }))
      .filter((entry) => entry.url)
      .slice(0, args.linkLimit);
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((element) => normalize(element.innerText || element.textContent || ''))
      .filter(Boolean)
      .slice(0, args.headingLimit);
    const images = Array.from(document.querySelectorAll('img'))
      .map((element) => makeAbsoluteUrl(
        element.currentSrc
        || element.getAttribute('src')
        || element.getAttribute('data-src')
        || element.getAttribute('data-lazy-src')
        || ''
      ))
      .filter(Boolean)
      .slice(0, args.imageLimit);

    return {
      title: normalize(document.title || ''),
      text,
      links,
      headings,
      images,
      selectorData,
    };
  }, {
    selectors,
    contentCharLimit,
    linkLimit,
    headingLimit,
    imageLimit,
  });

  return {
    html,
    title: snapshot.title,
    text: snapshot.text,
    links: snapshot.links,
    headings: snapshot.headings,
    images: snapshot.images,
    selectorData: snapshot.selectorData,
  };
}

async function browseWithPlaywrightUnlocked(normalizedUrl, options = {}, privateWorkspace = null) {
  const loaded = loadPlaywrightPackage();
  if (!loaded) {
    throw new Error('Playwright is not installed in the backend runtime');
  }

  const executablePath = await resolveSystemBrowserPath();
  if (loaded.moduleName === 'playwright-core' && !executablePath) {
    throw new Error('playwright-core is installed, but no browser executable path is configured');
  }

  const launchOptions = {
    headless: true,
    timeout: Math.max(1000, Number(options.timeout) || 30000),
    args: [...DEFAULT_BROWSER_ARGS, ...splitArgs(config.artifacts.browserArgs)],
  };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  let browser;
  let context;
  let page;
  const viewport = normalizeViewport(options.viewport);

  try {
    const contextOptions = {
      ignoreHTTPSErrors: true,
      userAgent: DEFAULT_USER_AGENT,
      viewport,
      extraHTTPHeaders: buildInternalBrowserHeaders(normalizedUrl),
    };
    if (privateWorkspace) {
      await fs.mkdir(privateWorkspace.userDataDir, { recursive: true });
      context = await loaded.chromium.launchPersistentContext(privateWorkspace.userDataDir, {
        ...launchOptions,
        ...contextOptions,
      });
      page = context.pages()[0] || await context.newPage();
    } else {
      browser = await loaded.chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
      page = await context.newPage();
    }
    await page.goto(normalizedUrl, {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout: launchOptions.timeout,
    });

    if (options.waitForSelector) {
      await page.waitForSelector(String(options.waitForSelector), {
        timeout: launchOptions.timeout,
        state: 'visible',
      });
    }

    const actions = await runPageActions(page, options.actions, launchOptions.timeout);
    if (actions.length > 0) {
      await page.waitForLoadState('networkidle', {
        timeout: Math.min(launchOptions.timeout, 5000),
      }).catch(() => {});
    }

    const snapshot = await collectPageSnapshot(page, options);
    assertNotAuthWall(snapshot, page.url());
    let screenshot = null;
    if (options.captureScreenshot) {
      screenshot = await captureScreenshotArtifact({
        page,
        sessionId: options.sessionId,
        url: page.url(),
        title: snapshot.title,
        contentText: snapshot.text,
        fullPage: options.fullPageScreenshot,
        viewport,
        privateWorkspace,
        workloadId: options.workloadId,
      });
    }

    return {
      engine: 'playwright',
      url: page.url(),
      title: snapshot.title,
      html: snapshot.html,
      text: snapshot.text,
      links: snapshot.links,
      headings: snapshot.headings,
      images: snapshot.images,
      selectorData: snapshot.selectorData,
      screenshot,
      actions,
      privateWorkspace: privateWorkspace ? {
        private: true,
        persistent: true,
        scope: privateWorkspace.scope,
      } : null,
    };
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function browseWithPlaywright(normalizedUrl, options = {}) {
  const privateWorkspace = resolvePrivateBrowserWorkspace(options.browserWorkspaceId);
  return withPrivateWorkspaceLock(
    privateWorkspace,
    () => browseWithPlaywrightUnlocked(normalizedUrl, options, privateWorkspace),
  );
}

function assertSelectorPresentInHtml(html, selector) {
  const normalized = String(selector || '').trim();
  if (!normalized) {
    return;
  }

  if (normalized.startsWith('.')) {
    const className = normalized.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`class=["'][^"']*${className}[^"']*["']`, 'i').test(html)) {
      return;
    }
  } else if (normalized.startsWith('#')) {
    const id = normalized.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`id=["']${id}["']`, 'i').test(html)) {
      return;
    }
  } else if (new RegExp(`<${normalized}\\b`, 'i').test(html)) {
    return;
  }

  throw new Error(`Selector '${normalized}' was not found in the rendered page`);
}

async function browseWithDumpDom(normalizedUrl, options = {}) {
  const browserPath = await resolveSystemBrowserPath();
  if (!browserPath) {
    throw new Error('Headless browser is not installed in the backend container');
  }

  const timeout = Math.max(1000, Number(options.timeout) || 30000);
  const virtualTimeBudget = Math.min(Math.max(timeout, 3000), 45000);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-browser-'));

  try {
    const { stdout, stderr } = await execFileAsync(browserPath, [
      '--headless',
      ...DEFAULT_BROWSER_ARGS,
      '--user-data-dir=' + userDataDir,
      `--virtual-time-budget=${virtualTimeBudget}`,
      '--dump-dom',
      normalizedUrl,
    ], {
      timeout,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });

    const html = String(stdout || '').trim();
    if (!html) {
      const detail = String(stderr || '').trim();
      throw new Error(detail || `Browser returned empty DOM for ${normalizedUrl}`);
    }

    if (options.waitForSelector) {
      assertSelectorPresentInHtml(html, options.waitForSelector);
    }

    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const text = truncateText(
      html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim(),
      options.contentCharLimit || config.scrape.contentCharLimit,
    );

    const snapshot = {
      engine: 'dump-dom',
      url: normalizedUrl,
      title: normalizeText(titleMatch?.[1] || ''),
      html,
      text,
      links: [],
      headings: [],
      images: [],
      selectorData: {},
      screenshot: options.captureScreenshot
        ? {
          available: false,
          reason: 'Screenshot capture requires Playwright-backed browser mode',
        }
        : null,
      actions: [],
    };
    assertNotAuthWall(snapshot, normalizedUrl);
    return snapshot;
  } finally {
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function browsePage(url, options = {}) {
  const normalizedUrl = normalizeUrl(url);
  const browserErrors = [];

  try {
    return await browseWithPlaywright(normalizedUrl, options);
  } catch (error) {
    browserErrors.push(`playwright: ${error.message}`);
  }

  try {
    const fallback = await browseWithDumpDom(normalizedUrl, options);
    return {
      ...fallback,
      warnings: browserErrors,
    };
  } catch (error) {
    browserErrors.push(`dump-dom: ${error.message}`);
    throw new Error(`Browser fetch failed for ${normalizedUrl}: ${browserErrors.join('; ')}`);
  }
}

module.exports = {
  assertNotAuthWall,
  buildInternalBrowserHeaders,
  browsePage,
  normalizeBrowserUrl: normalizeUrl,
  normalizeBrowserViewport: normalizeViewport,
  resolvePrivateBrowserWorkspace,
};
