jest.mock('../../../../routes/admin/settings.controller', () => ({
  settings: {
    api: {
      baseURL: 'http://localhost:3000',
    },
  },
}));

const {
  assertNotAuthWall,
  buildInternalBrowserHeaders,
  normalizeBrowserUrl,
  resolvePrivateBrowserWorkspace,
} = require('./browser-runtime');

describe('browser-runtime URL normalization', () => {
  const originalApiBaseUrl = process.env.API_BASE_URL;

  afterEach(() => {
    if (originalApiBaseUrl == null) {
      delete process.env.API_BASE_URL;
    } else {
      process.env.API_BASE_URL = originalApiBaseUrl;
    }
  });

  beforeEach(() => {
    delete process.env.API_BASE_URL;
  });

  test('resolves internal preview paths against the configured backend base url', () => {
    expect(normalizeBrowserUrl('/api/sandbox-workspaces/demo/preview/')).toBe(
      'http://localhost:3000/api/sandbox-workspaces/demo/preview/',
    );
    expect(normalizeBrowserUrl('/api/artifacts/artifact-site-1/sandbox')).toBe(
      'http://localhost:3000/api/artifacts/artifact-site-1/sandbox',
    );
  });

  test('rewrites accidental api host preview urls to the configured backend base url', () => {
    expect(normalizeBrowserUrl('https://api/api/artifacts/artifact-site-1/sandbox')).toBe(
      'http://localhost:3000/api/artifacts/artifact-site-1/sandbox',
    );
  });

  test('prefers public API_BASE_URL over default localhost settings for hosted previews', () => {
    process.env.API_BASE_URL = 'https://kimibuilt.secdevsolutions.help';

    expect(normalizeBrowserUrl('/api/artifacts/artifact-site-1/sandbox')).toBe(
      'https://kimibuilt.secdevsolutions.help/api/artifacts/artifact-site-1/sandbox',
    );
  });

  test('adds the frontend API key for internal API preview URLs', () => {
    const original = process.env.KIMIBUILT_FRONTEND_API_KEY;
    process.env.KIMIBUILT_FRONTEND_API_KEY = 'frontend-test-key';
    try {
      expect(buildInternalBrowserHeaders('http://localhost:3000/api/artifacts/site/sandbox')).toEqual({
        'x-api-key': 'frontend-test-key',
      });
      process.env.API_BASE_URL = 'https://kimibuilt.secdevsolutions.help';
      expect(buildInternalBrowserHeaders('https://kimibuilt.secdevsolutions.help/api/artifacts/site/sandbox')).toEqual({
        'x-api-key': 'frontend-test-key',
      });
      expect(buildInternalBrowserHeaders('https://example.com/api/artifacts/site/sandbox')).toEqual({});
    } finally {
      if (original == null) {
        delete process.env.KIMIBUILT_FRONTEND_API_KEY;
      } else {
        process.env.KIMIBUILT_FRONTEND_API_KEY = original;
      }
    }
  });

  test('treats missing-token auth pages as browser QA failures', () => {
    expect(() => assertNotAuthWall({
      title: '',
      text: '{"error":{"message":"Authentication required","code":"missing_token"}}',
      html: '',
    }, 'http://localhost:3000/api/artifacts/site/sandbox')).toThrow(/authentication wall/i);
  });

  test('derives a durable private profile without putting raw workload identity in its path', () => {
    const workspace = resolvePrivateBrowserWorkspace('agent-workload:session-secret:workload-secret');

    expect(workspace).toMatchObject({
      private: true,
      persistent: true,
      scope: 'workload',
    });
    expect(workspace.id).toMatch(/^[a-f0-9]{24}$/);
    expect(workspace.userDataDir).toContain('agent-browser-workspaces');
    expect(workspace.userDataDir).not.toContain('session-secret');
    expect(workspace.userDataDir).not.toContain('workload-secret');
  });
});
