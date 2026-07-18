const {
  buildAuthHeaders,
  hasCorsConsoleError,
  isAuthWallMetrics,
  isExternalHttpRequest,
  normalizeUrl,
  parseArgs,
  redactSensitiveUrl,
  rewritePreviewUrlWithToken,
  waitForClientReady,
} = require('./kimibuilt-ui-check');
const {
  buildUrl: buildFrontendLoadCheckUrl,
  parseArgs: parseFrontendLoadCheckArgs,
} = require('./kimibuilt-frontend-load-check');

describe('kimibuilt-ui-check preview auth helpers', () => {
  const envKeys = [
    'API_BASE_URL',
    'KIMIBUILT_FRONTEND_API_KEY',
    'KIMIBUILT_UI_CHECK_AUTH_TOKEN',
    'KIMIBUILT_UI_CHECK_TOKEN',
    'PUBLIC_API_BASE_URL',
    'PUBLIC_HOST',
    'PUBLIC_URL',
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  test('resolves relative sandbox API URLs against the configured backend', () => {
    process.env.API_BASE_URL = 'https://kimibuilt.secdevsolutions.help';

    expect(normalizeUrl('/api/artifacts/site/sandbox')).toBe(
      'https://kimibuilt.secdevsolutions.help/api/artifacts/site/sandbox',
    );
  });

  test('rewrites accidental api host URLs against the configured backend', () => {
    process.env.API_BASE_URL = 'https://kimibuilt.secdevsolutions.help';

    expect(normalizeUrl('https://api/api/sandbox-workspaces/demo/preview/')).toBe(
      'https://kimibuilt.secdevsolutions.help/api/sandbox-workspaces/demo/preview/',
    );
  });

  test('adds auth headers only for internal preview API URLs', () => {
    process.env.API_BASE_URL = 'https://kimibuilt.secdevsolutions.help';
    process.env.KIMIBUILT_FRONTEND_API_KEY = 'frontend-secret';

    expect(buildAuthHeaders('https://kimibuilt.secdevsolutions.help/api/artifacts/site/sandbox')).toEqual({
      authorization: 'Bearer frontend-secret',
      'x-api-key': 'frontend-secret',
    });
    expect(buildAuthHeaders('https://example.com/api/artifacts/site/sandbox')).toEqual({});
    expect(buildAuthHeaders('https://kimibuilt.secdevsolutions.help/web-chat/')).toEqual({});
  });

  test('rewrites sandbox and preview URLs to tokenized access routes', () => {
    expect(rewritePreviewUrlWithToken(
      'https://kimibuilt.secdevsolutions.help/api/artifacts/site/sandbox',
      'preview-token',
    )).toBe('https://kimibuilt.secdevsolutions.help/api/artifacts/site/sandbox-access/preview-token');

    expect(rewritePreviewUrlWithToken(
      'https://kimibuilt.secdevsolutions.help/api/sandbox-workspaces/demo/preview/',
      'preview-token',
    )).toBe('https://kimibuilt.secdevsolutions.help/api/sandbox-workspaces/demo/preview-access/preview-token/');
  });

  test('detects auth walls and CORS console errors separately', () => {
    expect(isAuthWallMetrics({
      bodyTextPreview: '{"error":{"message":"Authentication required","code":"missing_token"}}',
    })).toBe(true);
    expect(hasCorsConsoleError([
      { text: 'Access to fetch has been blocked by CORS policy' },
    ])).toBe(true);
  });

  test('redacts preview tokens from report URLs', () => {
    expect(redactSensitiveUrl(
      'https://kimibuilt.secdevsolutions.help/api/artifacts/site/preview-access/secret-token/?access_token=also-secret',
    )).toBe(
      'https://kimibuilt.secdevsolutions.help/api/artifacts/site/preview-access/[redacted]/?access_token=[redacted]',
    );
  });

  test('waits for web-chat bootstrap before collecting visual metrics', async () => {
    let readinessPredicate = null;
    const page = {
      waitForFunction: jest.fn(async (predicate) => {
        readinessPredicate = predicate;
      }),
      evaluate: jest.fn(async () => {}),
    };

    await waitForClientReady(page, 30000);

    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), null, {
      timeout: 5000,
    });
    expect(String(readinessPredicate)).toContain('window.chatApp');
    expect(String(readinessPredicate)).toContain('data-theme');
    expect(String(readinessPredicate)).toContain('preload');
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function));
  });

  test('parses frontend load-check budget options', () => {
    expect(parseFrontendLoadCheckArgs([
      '--base-url',
      'http://127.0.0.1:3013',
      '--max-ms',
      '50',
      '--out',
      'ui-checks/custom',
    ])).toMatchObject({
      baseUrl: 'http://127.0.0.1:3013',
      maxMs: 50,
      outDir: 'ui-checks/custom',
    });
  });

  test('builds frontend load-check route URLs from the base URL', () => {
    expect(buildFrontendLoadCheckUrl('http://127.0.0.1:3013', '/web-chat/')).toBe(
      'http://127.0.0.1:3013/web-chat/',
    );
  });
});

describe('kimibuilt UI check network confinement', () => {
  test('parses the explicit same-origin-only release gate', () => {
    expect(parseArgs([
      'https://kimibuilt.example.test/api/artifacts/site-1/preview',
      '--same-origin-only',
    ])).toEqual(expect.objectContaining({
      url: 'https://kimibuilt.example.test/api/artifacts/site-1/preview',
      sameOriginOnly: true,
    }));
  });

  test('classifies only outside-origin HTTP requests as external', () => {
    const origin = 'https://kimibuilt.example.test';

    expect(isExternalHttpRequest(`${origin}/styles.css`, origin)).toBe(false);
    expect(isExternalHttpRequest('https://outside.example.test/leak.css', origin)).toBe(true);
    expect(isExternalHttpRequest('http://kimibuilt.example.test/plain-http', origin)).toBe(true);
    expect(isExternalHttpRequest('data:image/svg+xml;base64,PHN2Zz4=', origin)).toBe(false);
    expect(isExternalHttpRequest('about:blank', origin)).toBe(false);
  });
});
