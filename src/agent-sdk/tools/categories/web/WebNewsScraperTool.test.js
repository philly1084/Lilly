const { WebNewsScraperTool } = require('./WebNewsScraperTool');

describe('WebNewsScraperTool', () => {
  test('extracts readable article bodies from supplied URLs and renders excerpt-only site output by default', async () => {
    const html = `<!doctype html>
      <html>
        <head>
          <title>Fallback title</title>
          <link rel="canonical" href="https://example.com/news/full-story">
          <meta property="og:title" content="A Full Story From The Source">
          <meta property="og:description" content="Short description from the page.">
          <meta property="og:image" content="/hero.jpg">
          <meta property="article:published_time" content="2026-05-24T10:00:00Z">
          <meta name="author" content="Jane Reporter">
        </head>
        <body>
          <header>Navigation</header>
          <article>
            <h1>A Full Story From The Source</h1>
            <p>First paragraph has enough substance to be kept by the article extractor for downstream research and injection.</p>
            <p>Second paragraph adds enough detail that the generated article body is much more than a headline snippet.</p>
          </article>
          <footer>Copyright footer</footer>
        </body>
      </html>`;
    const fetchTool = {
      execute: jest.fn().mockResolvedValue({
        success: true,
        data: {
          url: 'https://example.com/news/full-story?utm=1',
          body: html,
        },
      }),
    };
    const tool = new WebNewsScraperTool();
    const tracker = { recordRead: jest.fn() };

    const result = await tool.handler({
      urls: ['https://example.com/news/full-story'],
      title: 'Morning News',
      weather: { summary: 'Halifax: rain clearing by afternoon.' },
    }, {
      tools: {
        get: jest.fn((id) => (id === 'web-fetch' ? fetchTool : null)),
      },
    }, tracker);

    expect(fetchTool.execute).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://example.com/news/full-story',
    }), expect.any(Object));
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toEqual(expect.objectContaining({
      title: 'A Full Story From The Source',
      url: 'https://example.com/news/full-story',
      source: 'example.com',
      byline: 'Jane Reporter',
      publishedAt: '2026-05-24T10:00:00Z',
      leadImage: 'https://example.com/hero.jpg',
    }));
    expect(result.articles[0].text).toContain('much more than a headline snippet');
    expect(result.injection.articles[0].hasFullText).toBe(false);
    expect(result.injection.articles[0].text).toBe(result.injection.articles[0].excerpt);
    expect(result.site.textMode).toBe('excerpt');
    expect(result.site.html).toContain('Morning News');
    expect(result.site.html).toContain('Halifax: rain clearing by afternoon.');
    expect(result.site.html).toContain('Read at source');
    expect(result.skipped).toEqual([]);
  });

  test('uses Perplexity pro-search discovery before fetching source pages', async () => {
    const searchTool = {
      execute: jest.fn().mockResolvedValue({
        success: true,
        data: {
          results: [
            { title: 'Story', url: 'https://publisher.example/story' },
          ],
        },
      }),
    };
    const fetchTool = {
      execute: jest.fn().mockResolvedValue({
        success: true,
        data: {
          url: 'https://publisher.example/story',
          body: `<html><head><meta property="og:title" content="Discovered Story"></head><body><article>
            <p>This discovered article has enough body text to prove the fetch step follows Perplexity discovery.</p>
            <p>The scraper should keep source page content rather than only a search-result headline.</p>
          </article></body></html>`,
        },
      }),
    };
    const tool = new WebNewsScraperTool();

    const result = await tool.handler({
      query: 'Canadian AI regulation news today',
      limit: 4,
    }, {
      tools: {
        get: jest.fn((id) => {
          if (id === 'web-search') return searchTool;
          if (id === 'web-fetch') return fetchTool;
          return null;
        }),
      },
    }, { recordRead: jest.fn() });

    expect(searchTool.execute).toHaveBeenCalledWith(expect.objectContaining({
      researchMode: 'pro-search',
      query: 'Canadian AI regulation news today',
      maxTokensPerPage: 12000,
    }), expect.any(Object));
    expect(fetchTool.execute).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://publisher.example/story',
    }), expect.any(Object));
    expect(result.articles[0].title).toBe('Discovered Story');
    expect(result.articles[0].text).toContain('rather than only a search-result headline');
  });

  test('allows full-text site rendering only when content rights permit it', async () => {
    const fetchTool = {
      execute: jest.fn().mockResolvedValue({
        success: true,
        data: {
          url: 'https://owned.example/story',
          body: `<html><body><article>
            <h1>Owned Story</h1>
            <p>Owned publication text can be rendered in full when the caller supplies a compatible rights flag.</p>
            <p>This paragraph should appear in the injected public site text because the rights mode allows republication.</p>
          </article></body></html>`,
        },
      }),
    };
    const tool = new WebNewsScraperTool();

    const result = await tool.handler({
      urls: ['https://owned.example/story'],
      siteTextMode: 'full',
      contentRights: 'owned',
    }, {
      tools: {
        get: jest.fn((id) => (id === 'web-fetch' ? fetchTool : null)),
      },
    }, { recordRead: jest.fn() });

    expect(result.injection.articles[0].hasFullText).toBe(true);
    expect(result.injection.articles[0].text).toContain('rights mode allows republication');
    expect(result.site.textMode).toBe('full');
  });
});
