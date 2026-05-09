/**
 * WebSearchTool - Search or research the web using Perplexity APIs.
 */

const { ToolBase } = require('../../ToolBase');
const { config } = require('../../../../config');
const { normalizeDomainList } = require('./research-site-policy');

const DEFAULT_SEARCH_LIMIT = Math.min(config.search.defaultLimit, config.search.maxLimit);
const DEFAULT_MAX_TOKENS = 10000;
const DEFAULT_MAX_TOKENS_PER_PAGE = 4096;
const DEFAULT_MAX_OUTPUT_TOKENS = 1800;
const DEFAULT_DEEP_RESEARCH_OUTPUT_TOKENS = 7000;
const DEFAULT_SEARCH_REGION = 'ca-en';
const DEFAULT_SEARCH_COUNTRY = 'CA';
const AGENT_RESEARCH_MODES = Object.freeze([
  'fast-search',
  'pro-search',
  'deep-research',
  'advanced-deep-research',
]);
const SONAR_RESEARCH_MODES = Object.freeze([
  'sonar',
  'sonar-pro',
  'sonar-reasoning-pro',
  'sonar-deep-research',
]);
const RESEARCH_MODES = Object.freeze([
  'search',
  ...SONAR_RESEARCH_MODES,
  ...AGENT_RESEARCH_MODES,
]);
const IMAGE_FORMATS = Object.freeze(['gif', 'jpeg', 'png', 'webp']);
const SEARCH_CONTEXT_SIZES = Object.freeze(['low', 'medium', 'high']);
const SEARCH_MODES = Object.freeze(['web', 'academic', 'sec']);
const REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high']);

function normalizeDomainFilterEntry(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const negate = raw.startsWith('-');
  const normalized = normalizeDomainList([negate ? raw.slice(1) : raw])[0] || '';
  if (!normalized) {
    return '';
  }

  return negate ? `-${normalized}` : normalized;
}

function normalizeSearchDomainFilters(values = []) {
  const input = Array.isArray(values) ? values : [values];
  return Array.from(new Set(
    input
      .map((value) => normalizeDomainFilterEntry(value))
      .filter(Boolean),
  ));
}

function normalizePerplexityDomainFilters(values = [], { max = 20, allowNegated = true } = {}) {
  const normalized = normalizeSearchDomainFilters(values).slice(0, Math.max(1, max));
  const allowList = normalized.filter((entry) => !entry.startsWith('-'));
  const denyList = normalized.filter((entry) => entry.startsWith('-'));

  if (allowList.length > 0) {
    return allowList.slice(0, max);
  }

  if (allowNegated) {
    return denyList.slice(0, max);
  }

  return [];
}

function normalizeLanguageFilter(values = []) {
  const input = Array.isArray(values) ? values : [values];
  return Array.from(new Set(
    input
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => /^[a-z]{2}$/.test(value)),
  ));
}

function normalizeDateFilter(value = '') {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeImageFormatFilters(values = []) {
  const input = Array.isArray(values) ? values : [values];
  return Array.from(new Set(
    input
      .map((value) => String(value || '').trim().toLowerCase().replace(/^\./, ''))
      .map((value) => (value === 'jpg' ? 'jpeg' : value))
      .filter((value) => IMAGE_FORMATS.includes(value)),
  )).slice(0, 10);
}

function normalizeEnum(value = '', allowed = [], fallback = null) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeBoolean(value = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return /^(?:1|true|yes|y|on)$/i.test(value.trim());
  }

  return value === 1;
}

function normalizeUserLocation(userLocation = null, region = DEFAULT_SEARCH_REGION) {
  const countryFromRegion = String(region || DEFAULT_SEARCH_REGION).split('-')[0].toUpperCase();
  const raw = userLocation && typeof userLocation === 'object' && !Array.isArray(userLocation)
    ? userLocation
    : {};

  const normalized = {
    country: String(raw.country || countryFromRegion || DEFAULT_SEARCH_COUNTRY).trim().toUpperCase(),
    region: String(raw.region || '').trim(),
    city: String(raw.city || '').trim(),
  };

  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    normalized.latitude = latitude;
    normalized.longitude = longitude;
  }

  if (!normalized.country || normalized.country.length !== 2) {
    normalized.country = DEFAULT_SEARCH_COUNTRY;
  }

  return normalized;
}

function compactObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === null || entry === undefined) {
        return false;
      }
      if (Array.isArray(entry)) {
        return entry.length > 0;
      }
      if (typeof entry === 'string') {
        return entry.trim().length > 0;
      }
      if (typeof entry === 'object') {
        return Object.keys(entry).length > 0;
      }
      return true;
    }),
  );
}

function isSonarResearchMode(researchMode = '') {
  return SONAR_RESEARCH_MODES.includes(researchMode);
}

function isAgentResearchMode(researchMode = '') {
  return AGENT_RESEARCH_MODES.includes(researchMode);
}

class WebSearchTool extends ToolBase {
  constructor() {
    super({
      id: 'web-search',
      name: 'Web Search',
      description: 'Search or research the web using the configured Perplexity APIs',
      category: 'web',
      version: '1.2.0',
      backend: {
        sideEffects: ['network'],
        sandbox: { network: true },
        timeout: 120000,
      },
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
          engine: {
            type: 'string',
            enum: ['perplexity'],
            default: 'perplexity',
            description: 'Search engine to use',
          },
          researchMode: {
            type: 'string',
            enum: RESEARCH_MODES,
            default: 'search',
            description: 'Perplexity mode: raw Search API, Sonar grounded-answer model, or Agent API research preset',
          },
          limit: {
            type: 'integer',
            description: 'Maximum results to return or use per Perplexity search pass',
            default: DEFAULT_SEARCH_LIMIT,
            maximum: config.search.maxLimit,
          },
          safeSearch: {
            type: 'boolean',
            description: 'Safe search preference. Perplexity may apply its own safety handling.',
            default: true,
          },
          region: {
            type: 'string',
            description: 'Region hint such as ca-en, us-en, or uk-en',
            default: DEFAULT_SEARCH_REGION,
          },
          timeRange: {
            type: 'string',
            enum: ['hour', 'day', 'week', 'month', 'year', 'all'],
            default: 'all',
            description: 'Time range for results',
          },
          includeSnippets: {
            type: 'boolean',
            default: true,
          },
          includeUrls: {
            type: 'boolean',
            default: true,
          },
          domains: {
            type: 'array',
            description: 'Optional domain filters for authoritative or approved search targets. Use a leading "-" to exclude a domain in research modes.',
            items: {
              type: 'string',
            },
          },
          languageFilter: {
            type: 'array',
            description: 'Optional ISO 639-1 language filters (for example ["en", "fr"]).',
            items: {
              type: 'string',
            },
          },
          maxTokens: {
            type: 'integer',
            description: 'Maximum extracted search tokens budget used by Perplexity.',
            default: DEFAULT_MAX_TOKENS,
          },
          maxTokensPerPage: {
            type: 'integer',
            description: 'Maximum extracted tokens per page used by Perplexity.',
            default: DEFAULT_MAX_TOKENS_PER_PAGE,
          },
          maxOutputTokens: {
            type: 'integer',
            description: 'Maximum answer tokens for Perplexity Sonar or Agent researched-answer modes.',
            default: DEFAULT_MAX_OUTPUT_TOKENS,
          },
          returnImages: {
            type: 'boolean',
            description: 'Use Sonar media support to return image URLs with the grounded answer.',
            default: false,
          },
          imageDomains: {
            type: 'array',
            description: 'Optional Sonar image domain filters. Prefix with "-" to exclude. Max 10.',
            items: {
              type: 'string',
            },
          },
          imageFormats: {
            type: 'array',
            description: 'Optional Sonar image formats: gif, jpeg, png, or webp.',
            items: {
              type: 'string',
              enum: IMAGE_FORMATS,
            },
          },
          returnVideos: {
            type: 'boolean',
            description: 'Use Sonar media support to return videos when video evidence is valuable.',
            default: false,
          },
          returnRelatedQuestions: {
            type: 'boolean',
            description: 'Ask Sonar to include suggested related questions.',
            default: true,
          },
          searchMode: {
            type: 'string',
            enum: SEARCH_MODES,
            description: 'Sonar/Search mode for web, academic, or SEC filings.',
            default: 'web',
          },
          searchContextSize: {
            type: 'string',
            enum: SEARCH_CONTEXT_SIZES,
            description: 'Sonar search context size. Use low by default for cost control.',
            default: 'low',
          },
          reasoningEffort: {
            type: 'string',
            enum: REASONING_EFFORTS,
            description: 'Optional Sonar reasoning effort for reasoning/deep-research models.',
          },
          languagePreference: {
            type: 'string',
            description: 'Optional ISO 639-1 language preference for Sonar or Agent responses.',
          },
          publishedAfter: {
            type: 'string',
            description: 'Only include results published after this MM/DD/YYYY date.',
          },
          publishedBefore: {
            type: 'string',
            description: 'Only include results published before this MM/DD/YYYY date.',
          },
          updatedAfter: {
            type: 'string',
            description: 'Only include results updated after this MM/DD/YYYY date.',
          },
          updatedBefore: {
            type: 'string',
            description: 'Only include results updated before this MM/DD/YYYY date.',
          },
          maxSteps: {
            type: 'integer',
            description: 'Optional override for Perplexity preset reasoning/tool steps in research modes.',
          },
          instructions: {
            type: 'string',
            description: 'Optional extra instructions appended to Perplexity researched modes.',
          },
          userLocation: {
            type: 'object',
            description: 'Optional geographic context for Perplexity research modes.',
            properties: {
              country: { type: 'string' },
              region: { type: 'string' },
              city: { type: 'string' },
              latitude: { type: 'number' },
              longitude: { type: 'number' },
            },
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          engine: { type: 'string' },
          researchMode: { type: 'string' },
          answer: { type: 'string' },
          domainFilter: {
            type: 'array',
            items: { type: 'string' },
          },
          searchQueries: {
            type: 'array',
            items: { type: 'string' },
          },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
              },
            },
          },
          verifiedPages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                snippet: { type: 'string' },
              },
            },
          },
          relatedQuestions: {
            type: 'array',
            items: { type: 'string' },
          },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                imageUrl: { type: 'string' },
                originUrl: { type: 'string' },
                title: { type: 'string' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                source: { type: 'string' },
              },
            },
          },
          videos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                title: { type: 'string' },
                source: { type: 'string' },
                thumbnailUrl: { type: 'string' },
              },
            },
          },
          reasoningSteps: {
            type: 'array',
            items: { type: 'object' },
          },
          provider: {
            type: 'object',
            properties: {
              api: { type: 'string' },
              endpoint: { type: 'string' },
              model: { type: 'string' },
              responseId: { type: 'string' },
            },
          },
          usage: {
            type: 'object',
          },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                snippet: { type: 'string' },
                source: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          totalResults: { type: 'integer' },
          searchTime: { type: 'number' },
        },
      },
    });
  }

  async handler(params, context, tracker) {
    const {
      query,
      engine = 'perplexity',
      researchMode = 'search',
      limit = DEFAULT_SEARCH_LIMIT,
      safeSearch = true,
      region = DEFAULT_SEARCH_REGION,
      timeRange = 'all',
      includeSnippets = true,
      includeUrls = true,
      domains = [],
      languageFilter = [],
      maxTokens = DEFAULT_MAX_TOKENS,
      maxTokensPerPage = DEFAULT_MAX_TOKENS_PER_PAGE,
      maxOutputTokens = null,
      publishedAfter = null,
      publishedBefore = null,
      updatedAfter = null,
      updatedBefore = null,
      maxSteps = null,
      instructions = '',
      userLocation = null,
      imageDomains = [],
      imageDomainFilter = [],
      image_domain_filter: snakeImageDomainFilter = [],
      imageFormats = [],
      imageFormatFilter = [],
      image_format_filter: snakeImageFormatFilter = [],
      returnRelatedQuestions = true,
      return_related_questions: snakeReturnRelatedQuestions = null,
      searchMode = 'web',
      search_mode: snakeSearchMode = '',
      searchContextSize = 'low',
      search_context_size: snakeSearchContextSize = '',
      reasoningEffort = null,
      reasoning_effort: snakeReasoningEffort = null,
      languagePreference = null,
      language_preference: snakeLanguagePreference = null,
    } = params;
    const returnImages = normalizeBoolean(params.returnImages ?? params.return_images ?? false);
    const returnVideos = normalizeBoolean(params.returnVideos ?? params.return_videos ?? false);
    if (!RESEARCH_MODES.includes(researchMode)) {
      throw new Error(`Research mode '${researchMode}' is not supported by this backend`);
    }

    const resolvedResearchMode = this.resolveResearchMode(researchMode, { returnImages, returnVideos });
    const resolvedImageDomains = [
      ...[].concat(imageDomains || []),
      ...[].concat(imageDomainFilter || []),
      ...[].concat(snakeImageDomainFilter || []),
    ];
    const resolvedImageFormats = [
      ...[].concat(imageFormats || []),
      ...[].concat(imageFormatFilter || []),
      ...[].concat(snakeImageFormatFilter || []),
    ];
    const resolvedReturnRelatedQuestions = snakeReturnRelatedQuestions === null
      ? normalizeBoolean(returnRelatedQuestions)
      : normalizeBoolean(snakeReturnRelatedQuestions);
    const resolvedSearchMode = normalizeEnum(snakeSearchMode || searchMode, SEARCH_MODES, 'web');
    const resolvedSearchContextSize = normalizeEnum(
      snakeSearchContextSize || searchContextSize,
      SEARCH_CONTEXT_SIZES,
      'low',
    );
    const resolvedReasoningEffort = normalizeEnum(
      snakeReasoningEffort || reasoningEffort,
      REASONING_EFFORTS,
      null,
    );
    const resolvedLanguagePreference = String(snakeLanguagePreference || languagePreference || '').trim().toLowerCase();

    if (engine !== 'perplexity') {
      throw new Error(`Search engine '${engine}' is not supported by this backend`);
    }

    const domainFilter = normalizeSearchDomainFilters(domains);
    const normalizedLanguageFilter = normalizeLanguageFilter(languageFilter);
    const normalizedUserLocation = normalizeUserLocation(userLocation, region);
    const startTime = Date.now();
    const result = resolvedResearchMode === 'search'
      ? await this.searchPerplexity({
        query,
        limit,
        safeSearch,
        region,
        timeRange,
        includeSnippets,
        includeUrls,
        domains: domainFilter,
        languageFilter: normalizedLanguageFilter,
        maxTokens,
        maxTokensPerPage,
        searchMode: resolvedSearchMode,
        publishedAfter,
        publishedBefore,
        updatedAfter,
        updatedBefore,
        userLocation: normalizedUserLocation,
      })
      : isSonarResearchMode(resolvedResearchMode)
        ? await this.sonarPerplexity({
          query,
          researchMode: resolvedResearchMode,
          limit,
          region,
          timeRange,
          includeSnippets,
          includeUrls,
          domains: domainFilter,
          languageFilter: normalizedLanguageFilter,
          publishedAfter,
          publishedBefore,
          updatedAfter,
          updatedBefore,
          maxOutputTokens,
          instructions,
          userLocation: normalizedUserLocation,
          returnImages,
          imageDomains: resolvedImageDomains,
          imageFormats: resolvedImageFormats,
          returnVideos,
          returnRelatedQuestions: resolvedReturnRelatedQuestions,
          searchMode: resolvedSearchMode,
          searchContextSize: resolvedSearchContextSize,
          reasoningEffort: resolvedReasoningEffort,
          languagePreference: resolvedLanguagePreference,
        })
      : await this.researchPerplexity({
        query,
        researchMode: resolvedResearchMode,
        limit,
        region,
        timeRange,
        includeSnippets,
        includeUrls,
        domains: domainFilter,
        languageFilter: normalizedLanguageFilter,
        maxTokens,
        maxTokensPerPage,
        publishedAfter,
        publishedBefore,
        updatedAfter,
        updatedBefore,
        maxOutputTokens,
        maxSteps,
        instructions,
        userLocation: normalizedUserLocation,
        languagePreference: resolvedLanguagePreference,
      });
    const searchTime = (Date.now() - startTime) / 1000;

    tracker.recordNetworkCall(
      `${config.search.perplexityBaseURL.replace(/\/$/, '')}${result.provider?.endpoint || '/search'}`,
      'POST',
      {
        results: result.results.length,
        researchMode: resolvedResearchMode,
      },
    );

    return {
      query,
      engine,
      researchMode: resolvedResearchMode,
      domainFilter,
      answer: result.answer || '',
      citations: result.citations || [],
      verifiedPages: result.verifiedPages || [],
      relatedQuestions: result.relatedQuestions || [],
      images: result.images || [],
      videos: result.videos || [],
      reasoningSteps: result.reasoningSteps || [],
      searchQueries: result.searchQueries || [],
      provider: result.provider || null,
      usage: result.usage || null,
      results: result.results,
      totalResults: result.results.length,
      searchTime,
    };
  }

  async searchPerplexity({
    query,
    limit,
    region,
    timeRange,
    includeSnippets,
    includeUrls,
    domains,
    languageFilter,
    maxTokens,
    maxTokensPerPage,
    searchMode,
    publishedAfter,
    publishedBefore,
    updatedAfter,
    updatedBefore,
    userLocation,
  }) {
    if (!config.search.perplexityApiKey) {
      throw new Error('Perplexity search is not configured. Set PERPLEXITY_API_KEY in the backend environment.');
    }

    const endpoint = `${config.search.perplexityBaseURL.replace(/\/$/, '')}/search`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.search.perplexityApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(compactObject({
        query,
        max_results: Math.max(1, Math.min(Number(limit) || DEFAULT_SEARCH_LIMIT, config.search.maxLimit)),
        max_tokens: Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS),
        max_tokens_per_page: Math.max(1, Number(maxTokensPerPage) || DEFAULT_MAX_TOKENS_PER_PAGE),
        search_mode: searchMode && searchMode !== 'web' ? searchMode : null,
        search_domain_filter: normalizePerplexityDomainFilters(domains, { max: 20, allowNegated: true }),
        country: userLocation?.country || this.mapRegionToCountry(region),
        search_recency_filter: this.mapTimeRange(timeRange),
        search_language_filter: normalizeLanguageFilter(languageFilter),
        search_after_date_filter: normalizeDateFilter(publishedAfter),
        search_before_date_filter: normalizeDateFilter(publishedBefore),
        last_updated_after_filter: normalizeDateFilter(updatedAfter),
        last_updated_before_filter: normalizeDateFilter(updatedBefore),
      })),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity search failed (${response.status}): ${errorText || response.statusText}`);
    }

    const payload = await response.json();
    const results = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.search_results)
        ? payload.search_results
        : [];

    return {
      answer: '',
      citations: [],
      verifiedPages: [],
      relatedQuestions: [],
      searchQueries: Array.isArray(query) ? query.map((entry) => String(entry || '').trim()).filter(Boolean) : [String(query || '').trim()].filter(Boolean),
      results: results.map((result) => this.normalizeResult(result, { includeSnippets, includeUrls })),
      provider: {
        api: 'search',
        endpoint: '/search',
        model: '',
        responseId: payload.id || '',
      },
      usage: null,
    };
  }

  async sonarPerplexity({
    query,
    researchMode,
    limit,
    region,
    timeRange,
    includeSnippets,
    includeUrls,
    domains,
    languageFilter,
    publishedAfter,
    publishedBefore,
    updatedAfter,
    updatedBefore,
    maxOutputTokens,
    instructions,
    userLocation,
    returnImages,
    imageDomains,
    imageFormats,
    returnVideos,
    returnRelatedQuestions,
    searchMode,
    searchContextSize,
    reasoningEffort,
    languagePreference,
  }) {
    if (!config.search.perplexityApiKey) {
      throw new Error('Perplexity search is not configured. Set PERPLEXITY_API_KEY in the backend environment.');
    }

    const endpoint = `${config.search.perplexityBaseURL.replace(/\/$/, '')}/v1/sonar`;
    const messages = [];
    if (instructions && String(instructions).trim()) {
      messages.push({
        role: 'system',
        content: String(instructions).trim(),
      });
    }

    messages.push({
      role: 'user',
      content: Array.isArray(query)
        ? query.map((entry) => String(entry || '').trim()).filter(Boolean).join('\n')
        : String(query || '').trim(),
    });

    const requestBody = compactObject({
      model: researchMode,
      messages,
      max_tokens: this.normalizeMaxOutputTokens(maxOutputTokens, researchMode),
      search_mode: searchMode || 'web',
      return_images: returnImages ? true : null,
      return_related_questions: returnRelatedQuestions ? true : null,
      search_domain_filter: normalizePerplexityDomainFilters(domains, { max: 20, allowNegated: true }),
      search_language_filter: normalizeLanguageFilter(languageFilter),
      search_recency_filter: this.mapTimeRange(timeRange),
      search_after_date_filter: normalizeDateFilter(publishedAfter),
      search_before_date_filter: normalizeDateFilter(publishedBefore),
      last_updated_after_filter: normalizeDateFilter(updatedAfter),
      last_updated_before_filter: normalizeDateFilter(updatedBefore),
      image_domain_filter: returnImages
        ? normalizePerplexityDomainFilters(imageDomains, { max: 10, allowNegated: true })
        : [],
      image_format_filter: returnImages ? normalizeImageFormatFilters(imageFormats) : [],
      web_search_options: compactObject({
        search_context_size: searchContextSize || 'low',
      }),
      media_response: returnVideos
        ? { overrides: { return_videos: true } }
        : null,
      reasoning_effort: reasoningEffort || null,
      language_preference: languagePreference && /^[a-z]{2}$/.test(languagePreference) ? languagePreference : null,
      user_location: compactObject(userLocation || {
        country: this.mapRegionToCountry(region),
      }),
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.search.perplexityApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity Sonar failed (${response.status}): ${errorText || response.statusText}`);
    }

    const payload = await response.json();
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const answer = choices
      .map((choice) => choice?.message?.content || choice?.delta?.content || '')
      .filter(Boolean)
      .join('\n\n')
      .trim();
    const results = Array.isArray(payload.search_results)
      ? payload.search_results.map((result) => this.normalizeResult(result, { includeSnippets, includeUrls }))
      : [];
    const images = Array.isArray(payload.images)
      ? payload.images.map((image) => this.normalizeImageResult(image, { includeUrls }))
      : [];
    const videos = this.normalizeVideoResults(payload, { includeUrls });
    const citationUrls = Array.isArray(payload.citations)
      ? payload.citations.map((url) => String(url || '').trim()).filter(Boolean)
      : [];
    const citations = this.dedupeCitations(citationUrls.map((url) => ({
      title: this.titleForCitation(url, results),
      url,
    })));

    return {
      answer,
      citations,
      verifiedPages: [],
      relatedQuestions: Array.isArray(payload.related_questions)
        ? payload.related_questions.map((value) => String(value || '').trim()).filter(Boolean)
        : [],
      searchQueries: Array.isArray(query)
        ? query.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [String(query || '').trim()].filter(Boolean),
      results: this.dedupeResults(results).slice(0, Math.max(1, Math.min(Number(limit) || DEFAULT_SEARCH_LIMIT, config.search.maxLimit))),
      images,
      videos,
      provider: {
        api: 'sonar',
        endpoint: '/v1/sonar',
        model: String(payload.model || researchMode || '').trim(),
        responseId: String(payload.id || '').trim(),
      },
      usage: payload.usage || null,
      reasoningSteps: Array.isArray(payload.reasoning_steps) ? payload.reasoning_steps : [],
    };
  }

  async researchPerplexity({
    query,
    researchMode,
    limit,
    region,
    timeRange,
    includeSnippets,
    includeUrls,
    domains,
    languageFilter,
    maxTokens,
    maxTokensPerPage,
    publishedAfter,
    publishedBefore,
    updatedAfter,
    updatedBefore,
    maxOutputTokens,
    maxSteps,
    instructions,
    userLocation,
    languagePreference,
  }) {
    if (!config.search.perplexityApiKey) {
      throw new Error('Perplexity search is not configured. Set PERPLEXITY_API_KEY in the backend environment.');
    }

    const endpoint = `${config.search.perplexityBaseURL.replace(/\/$/, '')}/v1/agent`;
    const webSearchTool = compactObject({
      type: 'web_search',
      max_results_per_query: Math.max(1, Math.min(Number(limit) || DEFAULT_SEARCH_LIMIT, config.search.maxLimit)),
      max_tokens: Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS),
      max_tokens_per_page: Math.max(1, Number(maxTokensPerPage) || DEFAULT_MAX_TOKENS_PER_PAGE),
      filters: compactObject({
        search_domain_filter: normalizePerplexityDomainFilters(domains, { max: 20, allowNegated: true }),
        search_language_filter: normalizeLanguageFilter(languageFilter),
        search_recency_filter: this.mapTimeRange(timeRange),
        search_after_date_filter: normalizeDateFilter(publishedAfter),
        search_before_date_filter: normalizeDateFilter(publishedBefore),
        last_updated_after_filter: normalizeDateFilter(updatedAfter),
        last_updated_before_filter: normalizeDateFilter(updatedBefore),
      }),
      user_location: compactObject(userLocation || {
        country: this.mapRegionToCountry(region),
      }),
    });

    const tools = [webSearchTool];
    if (researchMode !== 'fast-search') {
      tools.push({ type: 'fetch_url' });
    }

    const requestBody = {
      preset: researchMode,
      input: query,
      tools,
    };

    const requestedMaxOutputTokens = Number(maxOutputTokens);
    if (Number.isFinite(requestedMaxOutputTokens) && requestedMaxOutputTokens > 0) {
      requestBody.max_output_tokens = Math.max(1, Math.trunc(requestedMaxOutputTokens));
    }

    if (Number.isFinite(Number(maxSteps)) && Number(maxSteps) > 0) {
      requestBody.max_steps = Math.trunc(Number(maxSteps));
    }

    if (instructions && String(instructions).trim()) {
      requestBody.instructions = String(instructions).trim();
    }

    if (languagePreference && /^[a-z]{2}$/.test(languagePreference)) {
      requestBody.language_preference = languagePreference;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.search.perplexityApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity research failed (${response.status}): ${errorText || response.statusText}`);
    }

    const payload = await response.json();
    const output = Array.isArray(payload.output) ? payload.output : [];
    const searchResults = [];
    const verifiedPages = [];
    const searchQueries = [];
    let answer = '';
    const annotationCitations = [];

    output.forEach((entry) => {
      if (entry?.type === 'search_results') {
        if (Array.isArray(entry.queries)) {
          searchQueries.push(...entry.queries.map((value) => String(value || '').trim()).filter(Boolean));
        }
        if (Array.isArray(entry.results)) {
          searchResults.push(...entry.results.map((result) => this.normalizeResult(result, { includeSnippets, includeUrls })));
        }
        return;
      }

      if (entry?.type === 'fetch_url_results' && Array.isArray(entry.contents)) {
        verifiedPages.push(...entry.contents.map((item) => ({
          title: item?.title || item?.url || 'Verified page',
          url: includeUrls ? (item?.url || '') : '',
          snippet: includeSnippets ? (item?.snippet || '') : '',
        })));
        return;
      }

      if (entry?.type === 'message' && Array.isArray(entry.content)) {
        entry.content.forEach((item) => {
          if (item?.type !== 'output_text') {
            return;
          }
          if (item.text) {
            answer += (answer ? '\n\n' : '') + item.text;
          }
          if (Array.isArray(item.annotations)) {
            annotationCitations.push(...item.annotations
              .map((annotation) => ({
                title: annotation?.title || annotation?.url || 'Citation',
                url: annotation?.url || '',
              }))
              .filter((annotation) => annotation.url));
          }
        });
      }
    });

    const dedupedResults = this.dedupeResults(searchResults);
    const dedupedVerifiedPages = this.dedupeResults(verifiedPages);
    const citations = annotationCitations.length > 0
      ? this.dedupeCitations(annotationCitations)
      : this.dedupeCitations([
        ...dedupedVerifiedPages.map((page) => ({ title: page.title, url: page.url })),
        ...dedupedResults.map((result) => ({ title: result.title, url: result.url })),
      ]);

    return {
      answer: answer.trim(),
      citations,
      verifiedPages: dedupedVerifiedPages,
      relatedQuestions: Array.isArray(payload.related_questions)
        ? payload.related_questions.map((value) => String(value || '').trim()).filter(Boolean)
        : [],
      searchQueries: Array.from(new Set(searchQueries)),
      results: dedupedResults,
      provider: {
        api: 'agent',
        endpoint: '/v1/agent',
        model: String(payload.model || '').trim(),
        responseId: String(payload.id || '').trim(),
      },
      usage: payload.usage || null,
      reasoningSteps: Array.isArray(payload.reasoning_steps) ? payload.reasoning_steps : [],
    };
  }

  mapRegionToCountry(region = DEFAULT_SEARCH_REGION) {
    const prefix = String(region).split('-')[0].toUpperCase();
    if (prefix.length === 2) {
      return prefix;
    }
    return DEFAULT_SEARCH_COUNTRY;
  }

  resolveResearchMode(researchMode = 'search', { returnImages = false, returnVideos = false } = {}) {
    const requestedMode = RESEARCH_MODES.includes(researchMode) ? researchMode : 'search';
    if (!returnImages && !returnVideos) {
      return requestedMode;
    }

    if (isSonarResearchMode(requestedMode)) {
      return requestedMode;
    }

    if (requestedMode === 'advanced-deep-research' || requestedMode === 'deep-research') {
      return 'sonar-deep-research';
    }

    if (requestedMode === 'pro-search') {
      return 'sonar-pro';
    }

    return 'sonar';
  }

  normalizeMaxOutputTokens(maxOutputTokens = null, researchMode = 'sonar') {
    const requested = Number(maxOutputTokens);
    if (Number.isFinite(requested) && requested > 0) {
      return Math.max(1, Math.trunc(requested));
    }

    if (researchMode === 'sonar-deep-research') {
      return DEFAULT_DEEP_RESEARCH_OUTPUT_TOKENS;
    }

    if (researchMode === 'sonar-pro' || researchMode === 'sonar-reasoning-pro') {
      return 2400;
    }

    return DEFAULT_MAX_OUTPUT_TOKENS;
  }

  mapTimeRange(timeRange = 'all') {
    const map = {
      hour: 'hour',
      day: 'day',
      week: 'week',
      month: 'month',
      year: 'year',
    };
    return map[timeRange] || null;
  }

  dedupeResults(results = []) {
    const deduped = [];
    const seen = new Set();

    (Array.isArray(results) ? results : []).forEach((result) => {
      const key = String(result?.url || `${result?.title || ''}::${result?.snippet || ''}`).trim();
      if (!key || seen.has(key)) {
        return;
      }
      seen.add(key);
      deduped.push(result);
    });

    return deduped;
  }

  dedupeCitations(citations = []) {
    const deduped = [];
    const seen = new Set();

    (Array.isArray(citations) ? citations : []).forEach((citation) => {
      const url = String(citation?.url || '').trim();
      if (!url || seen.has(url)) {
        return;
      }
      seen.add(url);
      deduped.push({
        title: citation?.title || url,
        url,
      });
    });

    return deduped;
  }

  normalizeResult(result = {}, { includeSnippets, includeUrls }) {
    const url = result.url || result.link || '';

    let source = '';
    if (url) {
      try {
        source = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        source = '';
      }
    }

    return {
      title: result.title || result.name || 'Untitled result',
      url: includeUrls ? url : '',
      snippet: includeSnippets ? (result.snippet || result.description || '') : '',
      source,
      publishedAt: result.date || result.published_at || result.last_updated || null,
    };
  }

  normalizeImageResult(image = {}, { includeUrls }) {
    const imageUrl = image.image_url || image.url || '';
    const originUrl = image.origin_url || image.source_url || image.page_url || '';
    const sourceUrl = originUrl || imageUrl;
    let source = '';
    if (sourceUrl) {
      try {
        source = new URL(sourceUrl).hostname.replace(/^www\./, '');
      } catch {
        source = '';
      }
    }

    return {
      imageUrl: includeUrls ? imageUrl : '',
      originUrl: includeUrls ? originUrl : '',
      title: image.title || image.alt || 'Image result',
      width: Number.isFinite(Number(image.width)) ? Number(image.width) : null,
      height: Number.isFinite(Number(image.height)) ? Number(image.height) : null,
      source,
    };
  }

  normalizeVideoResults(payload = {}, { includeUrls }) {
    const rawVideos = Array.isArray(payload.videos)
      ? payload.videos
      : Array.isArray(payload.media_response?.videos)
        ? payload.media_response.videos
        : [];

    return rawVideos.map((video) => {
      const url = video.url || video.video_url || video.watch_url || '';
      const thumbnailUrl = video.thumbnail_url || video.thumbnail || '';
      let source = '';
      if (url) {
        try {
          source = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          source = '';
        }
      }

      return {
        url: includeUrls ? url : '',
        title: video.title || url || 'Video result',
        source,
        thumbnailUrl: includeUrls ? thumbnailUrl : '',
      };
    });
  }

  titleForCitation(url = '', results = []) {
    const match = results.find((result) => result.url === url);
    return match?.title || url;
  }
}

module.exports = { WebSearchTool };
