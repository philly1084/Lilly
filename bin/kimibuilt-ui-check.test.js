const {
  buildAuthHeaders,
  hasCorsConsoleError,
  isAuthWallMetrics,
  normalizeUrl,
  redactSensitiveUrl,
  rewritePreviewUrlWithToken,
} = require('./kimibuilt-ui-check');

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
});
