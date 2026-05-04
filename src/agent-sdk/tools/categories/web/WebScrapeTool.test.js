jest.mock('./browser-runtime', () => ({
    browsePage: jest.fn(),
    normalizeBrowserUrl: jest.fn((url) => String(url || '')),
}));

jest.mock('./research-site-policy', () => {
    const actual = jest.requireActual('./research-site-policy');
    return {
        ...actual,
        evaluateResearchSitePolicy: jest.fn(),
    };
});

const { WebScrapeTool } = require('./WebScrapeTool');
const { browsePage } = require('./browser-runtime');
const { evaluateResearchSitePolicy } = require('./research-site-policy');

describe('WebScrapeTool content extraction', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        evaluateResearchSitePolicy.mockResolvedValue({
            url: 'https://example.com/article',
            hostname: 'example.com',
            approved: true,
            approvedDomains: [],
            allowed: true,
            reason: 'approved-by-default',
            robots: null,
        });
    });

    test('returns cleaned page text even when no selectors are provided', async () => {
        const tool = new WebScrapeTool();
        const fetchTool = {
            execute: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    url: 'https://example.com/article',
                    body: '<!DOCTYPE html><html><head><title>Example Article</title><style>.hidden{display:none;}</style></head><body><main><h1>Headline</h1><p>Alpha beta gamma.</p></main><script>window.ignore = true;</script></body></html>',
                },
            }),
        };
        const context = {
            tools: {
                get: jest.fn().mockReturnValue(fetchTool),
            },
        };
        const tracker = {
            recordRead: jest.fn(),
        };

        const result = await tool.handler({
            url: 'https://example.com/article',
        }, context, tracker);

        expect(result.title).toBe('Example Article');
        expect(result.url).toBe('https://example.com/article');
        expect(result.content).toContain('Headline Alpha beta gamma.');
        expect(result.content).not.toContain('<main>');
        expect(result.content).not.toContain('window.ignore');
        expect(result.contentLength).toBe(result.content.length);
        expect(result.stats.contentChars).toBe(result.content.length);
    });

    test('uses the browser runtime for rendered extraction and returns richer page metadata', async () => {
        browsePage.mockResolvedValue({
            engine: 'playwright',
            url: 'https://example.com/news',
            title: 'Example News',
            html: '<html><body><h1>Breaking News</h1><a href="/story">Read more</a></body></html>',
            text: 'Breaking News Read more',
            links: [{ text: 'Read more', url: 'https://example.com/story' }],
            headings: ['Breaking News'],
            images: ['https://example.com/hero.png'],
            selectorData: {
                headline: 'Breaking News',
            },
            screenshot: {
                available: true,
                artifact: {
                    id: 'artifact-1',
                    downloadUrl: '/api/artifacts/artifact-1/download',
                },
            },
            actions: [{ type: 'click', selector: 'button.load-more' }],
        });

        const tool = new WebScrapeTool();
        const tracker = {
            recordRead: jest.fn(),
        };

        const result = await tool.handler({
            url: 'https://example.com/news',
            browser: true,
            captureScreenshot: true,
            viewport: { width: 390, height: 844 },
            selectors: {
                headline: {
                    selector: 'h1',
                    transform: 'text',
                },
            },
            actions: [{ type: 'click', selector: 'button.load-more' }],
        }, {
            sessionId: 'session-1',
        }, tracker);

        expect(browsePage).toHaveBeenCalledWith('https://example.com/news', expect.objectContaining({
            selectors: {
                headline: {
                    selector: 'h1',
                    transform: 'text',
                },
            },
            captureScreenshot: true,
            viewport: { width: 390, height: 844 },
            sessionId: 'session-1',
        }));
        expect(result.url).toBe('https://example.com/news');
        expect(result.title).toBe('Example News');
        expect(result.content).toBe('Breaking News Read more');
        expect(result.data.headline).toBe('Breaking News');
        expect(result.links).toEqual([{ text: 'Read more', url: 'https://example.com/story' }]);
        expect(result.headings).toEqual(['Breaking News']);
        expect(result.browser).toEqual({
            engine: 'playwright',
            actions: [{ type: 'click', selector: 'button.load-more' }],
            warnings: [],
        });
        expect(result.screenshot).toEqual({
            available: true,
            artifact: {
                id: 'artifact-1',
                downloadUrl: '/api/artifacts/artifact-1/download',
            },
        });
        expect(result.method).toBe('playwright-css-selectors');
        expect(result.stats.linksCaptured).toBe(1);
        expect(result.stats.headingsCaptured).toBe(1);
    });

    test('uses direct artifact preview lookup instead of browser auth for internal sandbox urls', async () => {
        const artifactId = '3ee64601-2cb4-43e1-b56b-973bc2856419';
        const fetchTool = {
            normalizeUrl: jest.fn((url) => `http://localhost:3000${url}`),
            execute: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    url: `http://localhost:3000/api/artifacts/${artifactId}/sandbox`,
                    body: '<!doctype html><html><head><title>Star Garden</title></head><body><main><h1>Playable Game</h1><p>Collect stars.</p></main></body></html>',
                },
            }),
        };
        const tool = new WebScrapeTool();
        const tracker = {
            recordRead: jest.fn(),
        };

        const result = await tool.handler({
            url: `/api/artifacts/${artifactId}/sandbox`,
            browser: true,
            captureScreenshot: true,
        }, {
            tools: {
                get: jest.fn().mockReturnValue(fetchTool),
            },
        }, tracker);

        expect(fetchTool.execute).toHaveBeenCalledWith({
            url: `/api/artifacts/${artifactId}/sandbox`,
            timeout: 30000,
            cache: false,
        }, expect.any(Object));
        expect(browsePage).not.toHaveBeenCalled();
        expect(result.title).toBe('Star Garden');
        expect(result.content).toContain('Playable Game Collect stars.');
        expect(result.method).toBe('internal-artifact-preview');
    });

    test('normalizes array selector params before execute validation', async () => {
        browsePage.mockResolvedValue({
            engine: 'playwright',
            url: 'https://example.com/news',
            title: 'Example News',
            html: '<html><body><main><h1>Breaking News</h1></main></body></html>',
            text: 'Breaking News',
            links: [],
            headings: ['Breaking News'],
            images: [],
            selectorData: {
                headline: 'Breaking News',
                selector2: 'Breaking News',
            },
            screenshot: {
                available: true,
                artifact: {
                    id: 'artifact-1',
                },
            },
            actions: [],
        });

        const tool = new WebScrapeTool();
        const result = await tool.execute({
            url: 'https://example.com/news',
            browser: true,
            captureScreenshot: true,
            selectors: [
                { name: 'headline', selector: 'h1' },
                'main',
            ],
        }, {
            sessionId: 'session-1',
        });

        expect(result.success).toBe(true);
        expect(browsePage).toHaveBeenCalledWith('https://example.com/news', expect.objectContaining({
            selectors: {
                headline: {
                    selector: 'h1',
                    transform: 'text',
                },
                selector2: {
                    selector: 'main',
                    transform: 'text',
                },
            },
            captureScreenshot: true,
        }));
        expect(result.data.data.headline).toBe('Breaking News');
    });

    test('normalizes string-valued selector maps before static extraction', async () => {
        const tool = new WebScrapeTool();
        const fetchTool = {
            execute: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    url: 'https://example.com/article',
                    body: '<html><body><main><h1>Headline</h1><p>Alpha beta gamma.</p></main></body></html>',
                },
            }),
        };
        const context = {
            tools: {
                get: jest.fn().mockReturnValue(fetchTool),
            },
        };

        const result = await tool.execute({
            url: 'https://example.com/article',
            selectors: {
                headline: 'h1',
            },
        }, context);

        expect(result.success).toBe(true);
        expect(result.data.data.headline).toBe('Headline');
        expect(result.data.method).toBe('css-selectors');
    });

    test('includes research site policy metadata when research-safe scraping is allowed', async () => {
        const tool = new WebScrapeTool();
        const fetchTool = {
            execute: jest.fn().mockResolvedValue({
                success: true,
                data: {
                    url: 'https://example.com/article',
                    body: '<html><body><article><h1>Approved Source</h1><p>Verified content.</p></article></body></html>',
                },
            }),
        };
        const context = {
            tools: {
                get: jest.fn().mockReturnValue(fetchTool),
            },
        };
        const tracker = {
            recordRead: jest.fn(),
        };

        const result = await tool.handler({
            url: 'https://example.com/article',
            researchSafe: true,
            approvedDomains: ['example.com'],
        }, context, tracker);

        expect(evaluateResearchSitePolicy).toHaveBeenCalledWith('https://example.com/article', expect.objectContaining({
            approvedDomains: ['example.com'],
            respectRobotsTxt: true,
        }));
        expect(result.sitePolicy).toEqual(expect.objectContaining({
            hostname: 'example.com',
            allowed: true,
        }));
        expect(fetchTool.execute).toHaveBeenCalled();
    });

    test('skips research-safe scraping when robots.txt disallows bots', async () => {
        evaluateResearchSitePolicy.mockResolvedValue({
            url: 'https://example.com/article',
            hostname: 'example.com',
            approved: true,
            approvedDomains: ['example.com'],
            allowed: false,
            reason: 'robots-disallow',
            robots: {
                url: 'https://example.com/robots.txt',
                found: true,
                allowed: false,
                matchedUserAgent: '*',
                matchedRule: {
                    type: 'disallow',
                    path: '/',
                },
            },
        });

        const tool = new WebScrapeTool();
        const fetchTool = {
            execute: jest.fn(),
        };
        const context = {
            tools: {
                get: jest.fn().mockReturnValue(fetchTool),
            },
        };
        const tracker = {
            recordRead: jest.fn(),
        };

        await expect(tool.handler({
            url: 'https://example.com/article',
            researchSafe: true,
            approvedDomains: ['example.com'],
        }, context, tracker)).rejects.toThrow('robots.txt disallows automated access');

        expect(fetchTool.execute).not.toHaveBeenCalled();
    });
});
