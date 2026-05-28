jest.mock('../../../../config', () => ({
  config: {
    search: {
      perplexityApiKey: 'test-perplexity-key',
      perplexityBaseURL: 'https://api.perplexity.ai',
      defaultLimit: 12,
      maxLimit: 20,
      defaultMaxTokens: 50000,
      defaultMaxTokensPerPage: 4096,
      defaultMaxOutputTokens: 3200,
    },
  },
}));

const { WebSearchTool } = require('./WebSearchTool');

describe('WebSearchTool', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('passes normalized filters to the Perplexity Search API', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'search-123',
        results: [{
          title: 'OpenAI API docs',
          url: 'https://platform.openai.com/docs/overview',
          snippet: 'Official API documentation.',
          date: '2026-04-10T10:00:00Z',
        }],
      }),
    });

    const tool = new WebSearchTool();
    const tracker = {
      recordNetworkCall: jest.fn(),
    };

    const result = await tool.handler({
      query: 'latest OpenAI API best practices',
      domains: ['https://platform.openai.com/docs', 'www.developer.mozilla.org/en-US/', '-reddit.com'],
      languageFilter: ['en', 'fr', 'english'],
      timeRange: 'week',
      maxTokens: 9000,
      maxTokensPerPage: 2048,
      publishedAfter: '04/01/2026',
      updatedBefore: '04/10/2026',
      userLocation: {
        country: 'ca',
      },
    }, {}, tracker);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [endpoint, request] = global.fetch.mock.calls[0];
    const payload = JSON.parse(request.body);

    expect(endpoint).toBe('https://api.perplexity.ai/search');
    expect(payload).toEqual(expect.objectContaining({
      query: 'latest OpenAI API best practices',
      max_results: 12,
      max_tokens: 9000,
      max_tokens_per_page: 2048,
      search_domain_filter: [
        'platform.openai.com',
        'developer.mozilla.org',
      ],
      country: 'CA',
      search_recency_filter: 'week',
      search_language_filter: ['en', 'fr'],
      search_after_date_filter: '04/01/2026',
      last_updated_before_filter: '04/10/2026',
    }));
    expect(payload.search_domain_filter).not.toContain('-reddit.com');
    expect(result.researchMode).toBe('search');
    expect(result.domainFilter).toEqual([
      'platform.openai.com',
      'developer.mozilla.org',
      '-reddit.com',
    ]);
    expect(result.results).toEqual([
      expect.objectContaining({
        title: 'OpenAI API docs',
        source: 'platform.openai.com',
      }),
    ]);
    expect(result.searchQueries).toEqual(['latest OpenAI API best practices']);
    expect(result.provider).toEqual({
      api: 'search',
      endpoint: '/search',
      model: '',
      responseId: 'search-123',
    });
    expect(tracker.recordNetworkCall).toHaveBeenCalledWith(
      'https://api.perplexity.ai/search',
      'POST',
      { results: 1, researchMode: 'search' },
    );
  });

  test('defaults ordinary searches to Canadian locality', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'search-ca-default',
        results: [],
      }),
    });

    const tool = new WebSearchTool();
    const tracker = {
      recordNetworkCall: jest.fn(),
    };

    await tool.handler({
      query: 'latest mortgage rates',
    }, {}, tracker);

    const [, request] = global.fetch.mock.calls[0];
    const payload = JSON.parse(request.body);

    expect(payload).toEqual(expect.objectContaining({
      country: 'CA',
      max_tokens: 50000,
      max_tokens_per_page: 4096,
    }));
  });

  test('adds freshness defaults to undated technology searches', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'search-fresh-tech',
        results: [],
      }),
    });

    const tool = new WebSearchTool();
    const tracker = {
      recordNetworkCall: jest.fn(),
    };

    const result = await tool.handler({
      query: 'AI chip startups',
    }, {}, tracker);

    const [, request] = global.fetch.mock.calls[0];
    const payload = JSON.parse(request.body);

    expect(payload).toEqual(expect.objectContaining({
      query: 'AI chip startups recent this month',
      search_recency_filter: 'month',
    }));
    expect(result.query).toBe('AI chip startups recent this month');
    expect(result.searchQueries).toEqual(['AI chip startups recent this month']);
  });

  test('uses Sonar for grounded answers and image URL hotlisting', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'sonar-123',
        model: 'sonar',
        choices: [{
          message: {
            content: 'NASA and Wikimedia are useful sources for public-domain space imagery.',
          },
        }],
        citations: ['https://www.nasa.gov/image-article'],
        search_results: [{
          title: 'NASA image article',
          url: 'https://www.nasa.gov/image-article',
          snippet: 'A NASA image feature.',
          date: '2026-04-15',
        }],
        images: [{
          image_url: 'https://www.nasa.gov/image.png',
          origin_url: 'https://www.nasa.gov/image-article',
          title: 'NASA image',
          width: 1200,
          height: 800,
        }],
        related_questions: ['Which NASA image collections are public domain?'],
        usage: {
          total_tokens: 500,
        },
      }),
    });

    const tool = new WebSearchTool();
    const tracker = {
      recordNetworkCall: jest.fn(),
    };

    const result = await tool.handler({
      query: 'public-domain Mars rover images',
      researchMode: 'search',
      returnImages: true,
      imageDomains: ['nasa.gov', '-gettyimages.com'],
      imageFormats: ['png', 'jpg', 'svg'],
      domains: ['nasa.gov', '-pinterest.com'],
      searchContextSize: 'medium',
      maxOutputTokens: 1200,
    }, {}, tracker);

    const [endpoint, request] = global.fetch.mock.calls[0];
    const payload = JSON.parse(request.body);

    expect(endpoint).toBe('https://api.perplexity.ai/v1/sonar');
    expect(payload).toEqual(expect.objectContaining({
      model: 'sonar',
      max_tokens: 1200,
      return_images: true,
      search_domain_filter: ['nasa.gov'],
      image_domain_filter: ['nasa.gov'],
      image_format_filter: ['png', 'jpeg'],
      web_search_options: {
        search_context_size: 'medium',
      },
    }));
    expect(result.researchMode).toBe('sonar');
    expect(result.answer).toContain('NASA and Wikimedia');
    expect(result.results).toEqual([
      expect.objectContaining({
        title: 'NASA image article',
        source: 'nasa.gov',
      }),
    ]);
    expect(result.images).toEqual([
      expect.objectContaining({
        imageUrl: 'https://www.nasa.gov/image.png',
        originUrl: 'https://www.nasa.gov/image-article',
        source: 'nasa.gov',
      }),
    ]);
    expect(result.citations).toEqual([{
      title: 'NASA image article',
      url: 'https://www.nasa.gov/image-article',
    }]);
    expect(result.provider).toEqual({
      api: 'sonar',
      endpoint: '/v1/sonar',
      model: 'sonar',
      responseId: 'sonar-123',
    });
    expect(tracker.recordNetworkCall).toHaveBeenCalledWith(
      'https://api.perplexity.ai/v1/sonar',
      'POST',
      { results: 1, researchMode: 'sonar' },
    );
  });

  test('routes explicit Sonar deep research through the Sonar Deep Research model', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'sonar-deep-123',
        model: 'sonar-deep-research',
        choices: [{
          message: {
            content: 'Managed Postgres options differ across cost, storage, backups, and operational control.',
          },
        }],
        citations: ['https://neon.tech/pricing'],
        search_results: [{
          title: 'Neon pricing',
          url: 'https://neon.tech/pricing',
          snippet: 'Pricing and plan details.',
        }],
        usage: {
          total_tokens: 5000,
          reasoning_tokens: 2000,
        },
      }),
    });

    const tool = new WebSearchTool();
    const tracker = {
      recordNetworkCall: jest.fn(),
    };

    const result = await tool.handler({
      query: 'Deep research managed Postgres providers for startups',
      researchMode: 'sonar-deep-research',
      reasoningEffort: 'medium',
      searchContextSize: 'high',
      maxOutputTokens: 6500,
    }, {}, tracker);

    const [endpoint, request] = global.fetch.mock.calls[0];
    const payload = JSON.parse(request.body);

    expect(endpoint).toBe('https://api.perplexity.ai/v1/sonar');
    expect(payload).toEqual(expect.objectContaining({
      model: 'sonar-deep-research',
      max_tokens: 6500,
      reasoning_effort: 'medium',
      web_search_options: {
        search_context_size: 'high',
      },
    }));
    expect(result.researchMode).toBe('sonar-deep-research');
    expect(result.answer).toContain('Managed Postgres options differ');
    expect(result.provider).toEqual({
      api: 'sonar',
      endpoint: '/v1/sonar',
      model: 'sonar-deep-research',
      responseId: 'sonar-deep-123',
    });
  });

  test('uses Perplexity Agent API presets for deep research and preserves results output', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'resp_deep_123',
        model: 'openai/gpt-5.2',
        related_questions: ['How do hosted Postgres backups compare?'],
        usage: {
          total_tokens: 4321,
        },
        output: [
          {
            type: 'search_results',
            queries: ['managed postgres startups pricing', 'managed postgres startup backups'],
            results: [
              {
                title: 'Neon pricing',
                url: 'https://neon.tech/pricing',
                snippet: 'Usage-based Postgres pricing.',
                date: '2026-04-01',
                source: 'web',
              },
              {
                title: 'Crunchy Bridge',
                url: 'https://www.crunchydata.com/products/crunchy-bridge',
                snippet: 'Managed Postgres with backups.',
                date: '2026-03-15',
                source: 'web',
              },
            ],
          },
          {
            type: 'fetch_url_results',
            contents: [
              {
                title: 'Neon pricing',
                url: 'https://neon.tech/pricing',
                snippet: 'Serverless Postgres pricing details.',
              },
            ],
          },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Neon and Crunchy Bridge are strong startup options with different cost shapes.',
                annotations: [
                  {
                    title: 'Neon pricing',
                    url: 'https://neon.tech/pricing',
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    const tool = new WebSearchTool();
    const tracker = {
      recordNetworkCall: jest.fn(),
    };

    const result = await tool.handler({
      query: 'Compare managed Postgres providers for startups',
      researchMode: 'deep-research',
      limit: 7,
      domains: ['neon.tech', 'crunchydata.com'],
      timeRange: 'month',
      maxTokens: 12000,
      maxTokensPerPage: 4096,
      maxSteps: 8,
      instructions: 'Focus on startup pricing, backups, and operational tradeoffs.',
      userLocation: {
        country: 'US',
        region: 'New York',
        city: 'New York',
      },
    }, {}, tracker);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [endpoint, request] = global.fetch.mock.calls[0];
    const payload = JSON.parse(request.body);

    expect(endpoint).toBe('https://api.perplexity.ai/v1/agent');
    expect(payload).toEqual(expect.objectContaining({
      preset: 'deep-research',
      input: 'Compare managed Postgres providers for startups',
      max_steps: 8,
      instructions: 'Focus on startup pricing, backups, and operational tradeoffs.',
    }));
    expect(payload.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'web_search',
        max_results_per_query: 7,
        max_tokens: 12000,
        max_tokens_per_page: 4096,
        filters: expect.objectContaining({
          search_domain_filter: ['neon.tech', 'crunchydata.com'],
          search_recency_filter: 'month',
        }),
        user_location: expect.objectContaining({
          country: 'US',
          region: 'New York',
          city: 'New York',
        }),
      }),
      expect.objectContaining({
        type: 'fetch_url',
      }),
    ]));
    expect(result.researchMode).toBe('deep-research');
    expect(result.answer).toContain('Neon and Crunchy Bridge are strong startup options');
    expect(result.searchQueries).toEqual([
      'managed postgres startups pricing',
      'managed postgres startup backups',
    ]);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Neon pricing',
        url: 'https://neon.tech/pricing',
      }),
      expect.objectContaining({
        title: 'Crunchy Bridge',
        url: 'https://www.crunchydata.com/products/crunchy-bridge',
      }),
    ]));
    expect(result.verifiedPages).toEqual([
      {
        title: 'Neon pricing',
        url: 'https://neon.tech/pricing',
        snippet: 'Serverless Postgres pricing details.',
      },
    ]);
    expect(result.citations).toEqual([
      {
        title: 'Neon pricing',
        url: 'https://neon.tech/pricing',
      },
    ]);
    expect(result.provider).toEqual({
      api: 'agent',
      endpoint: '/v1/agent',
      model: 'openai/gpt-5.2',
      responseId: 'resp_deep_123',
    });
    expect(result.usage).toEqual({
      total_tokens: 4321,
    });
    expect(tracker.recordNetworkCall).toHaveBeenCalledWith(
      'https://api.perplexity.ai/v1/agent',
      'POST',
      { results: 2, researchMode: 'deep-research' },
    );
  });
});
