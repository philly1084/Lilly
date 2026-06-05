/**
 * WebNewsScraperTool - Discover news URLs, extract article bodies, and build a
 * static news-site payload suitable for injection into a deployed frontend.
 */

const { ToolBase } = require('../../ToolBase');
const { WebFetchTool } = require('./WebFetchTool');
const { WebSearchTool } = require('./WebSearchTool');
const { browsePage } = require('./browser-runtime');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');

const DEFAULT_LIMIT = 8;
const DEFAULT_ARTICLE_CHAR_LIMIT = 20000;
const DEFAULT_SITE_TEXT_LIMIT = 900;
const MIN_ARTICLE_TEXT_CHARS = 160;
const READABILITY_CHAR_THRESHOLD = 120;
const FULL_TEXT_RIGHTS = new Set(['owned', 'licensed', 'public-domain', 'creative-commons', 'explicit-permission']);
const QUIET_VIRTUAL_CONSOLE = new VirtualConsole();

QUIET_VIRTUAL_CONSOLE.on('jsdomError', () => {});

const SEMANTIC_ARTICLE_SELECTORS = [
  'article',
  'main article',
  '[itemprop="articleBody"]',
  '[data-testid="article-body"]',
  '[data-test-id="article-body"]',
  '[data-component-name="paragraph"]',
  '[class*="article-body"]',
  '[class*="articleBody"]',
  '[class*="article-content"]',
  '[class*="ArticleContent"]',
  '[class*="story-body"]',
  '[class*="StoryBody"]',
  '[class*="entry-content"]',
  '[class*="post-content"]',
  '[id*="article-body"]',
  '[id*="story-body"]',
];

function clampInteger(value, fallback, { min = 1, max = 50 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(number), max));
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&#(\d+);/g, (_match, code) => {
      const point = Number(code);
      return Number.isFinite(point) ? String.fromCodePoint(point) : '';
    })
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => {
      const point = parseInt(code, 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : '';
    });
}

function stripTags(value = '') {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '));
}

function normalizeText(value = '') {
  return decodeHtml(String(value || ''))
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getHostname(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch (_error) {
    return '';
  }
}

function normalizeUrl(candidate = '', baseUrl = '') {
  const raw = String(candidate || '').trim();
  if (!raw) {
    return '';
  }

  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch (_error) {
    return '';
  }
}

function htmlAttribute(tag = '', attribute = '') {
  const safeAttribute = String(attribute || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${safeAttribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i');
  const match = String(tag || '').match(pattern);
  return decodeHtml(match?.[1] || match?.[2] || match?.[3] || '').trim();
}

function findMetaContent(html = '', names = []) {
  const wanted = new Set(names.map((name) => String(name || '').toLowerCase()));
  const tags = Array.from(String(html || '').matchAll(/<meta\b[^>]*>/gi)).map((match) => match[0]);

  for (const tag of tags) {
    const key = (
      htmlAttribute(tag, 'property')
      || htmlAttribute(tag, 'name')
      || htmlAttribute(tag, 'itemprop')
    ).toLowerCase();
    if (wanted.has(key)) {
      const content = htmlAttribute(tag, 'content');
      if (content) {
        return normalizeText(content);
      }
    }
  }

  return '';
}

function findLinkHref(html = '', relName = '', baseUrl = '') {
  const wanted = String(relName || '').toLowerCase();
  const tags = Array.from(String(html || '').matchAll(/<link\b[^>]*>/gi)).map((match) => match[0]);

  for (const tag of tags) {
    const rels = htmlAttribute(tag, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
    if (rels.includes(wanted)) {
      const href = htmlAttribute(tag, 'href');
      if (href) {
        return normalizeUrl(href, baseUrl);
      }
    }
  }

  return '';
}

function firstMatch(html = '', patterns = []) {
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match?.[1]) {
      return normalizeText(stripTags(match[1]));
    }
  }
  return '';
}

function firstAttribute(html = '', patterns = [], baseUrl = '') {
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match?.[1]) {
      return normalizeUrl(decodeHtml(match[1]).trim(), baseUrl) || decodeHtml(match[1]).trim();
    }
  }
  return '';
}

function extractJsonLdArticles(html = '') {
  const scripts = Array.from(String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  const candidates = [];

  for (const script of scripts) {
    const raw = decodeHtml(script[1] || '').trim();
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw);
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry || typeof entry !== 'object') {
          continue;
        }

        if (Array.isArray(entry['@graph'])) {
          queue.push(...entry['@graph']);
        }

        const type = Array.isArray(entry['@type']) ? entry['@type'].join(' ') : String(entry['@type'] || '');
        if (/\b(NewsArticle|Article|BlogPosting)\b/i.test(type)) {
          candidates.push(entry);
        }
      }
    } catch (_error) {
      // Malformed JSON-LD should not block normal HTML extraction.
    }
  }

  return candidates;
}

function normalizeAuthor(author) {
  if (Array.isArray(author)) {
    return author.map(normalizeAuthor).filter(Boolean).join(', ');
  }
  if (author && typeof author === 'object') {
    return normalizeText(author.name || author.url || '');
  }
  return normalizeText(author || '');
}

function firstImageValue(image) {
  if (Array.isArray(image)) {
    for (const entry of image) {
      const value = firstImageValue(entry);
      if (value) {
        return value;
      }
    }
    return '';
  }

  if (image && typeof image === 'object') {
    return image.url || image.contentUrl || image['@id'] || '';
  }

  return image || '';
}

function createDom(html = '', url = '') {
  return new JSDOM(String(html || ''), {
    url: normalizeUrl(url) || 'https://example.invalid/',
    contentType: 'text/html',
    runScripts: undefined,
    resources: undefined,
    virtualConsole: QUIET_VIRTUAL_CONSOLE,
  });
}

function articleBodyFromHtml(html = '') {
  const withoutNoise = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const containerMatch = withoutNoise.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
    || withoutNoise.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
    || withoutNoise.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);

  const container = String(containerMatch?.[1] || withoutNoise)
    .replace(/<(nav|header|footer|aside|form|button|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<figure\b[\s\S]*?<\/figure>/gi, ' ')
    .replace(/<(h[1-6]|p|li|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/(h[1-6]|p|li|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  const lines = normalizeText(stripTags(container))
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter((line) => line.length >= 30)
    .filter((line) => !/\b(subscribe|sign up|advertisement|cookie policy|all rights reserved)\b/i.test(line));

  return Array.from(new Set(lines)).join('\n\n');
}

function removeDomNoise(root) {
  if (!root?.querySelectorAll) {
    return;
  }

  root.querySelectorAll([
    'script',
    'style',
    'noscript',
    'svg',
    'nav',
    'header',
    'footer',
    'aside',
    'form',
    'button',
    'iframe',
    '[aria-hidden="true"]',
    '[hidden]',
  ].join(',')).forEach((element) => element.remove());
}

function textFromDomNode(node) {
  if (!node?.cloneNode) {
    return '';
  }

  const clone = node.cloneNode(true);
  removeDomNoise(clone);
  const blockSelectors = [
    'h1',
    'h2',
    'h3',
    'p',
    'li',
    'blockquote',
    '[data-component-name="paragraph"]',
    '[data-editable="text"]',
  ].join(',');
  const blocks = Array.from(clone.querySelectorAll?.(blockSelectors) || [])
    .map((element) => normalizeText(element.textContent || ''))
    .filter((line) => line.length >= 30)
    .filter((line) => !/\b(subscribe|sign up|advertisement|cookie policy|all rights reserved)\b/i.test(line));

  if (blocks.length > 0) {
    return Array.from(new Set(blocks)).join('\n\n');
  }

  const fallback = normalizeText(clone.textContent || '');
  return fallback.length >= 30 ? fallback : '';
}

function extractSemanticArticleCandidates(html = '', url = '') {
  let dom;
  try {
    dom = createDom(html, url);
    const document = dom.window.document;
    const candidates = [];
    const seen = new Set();

    for (const selector of SEMANTIC_ARTICLE_SELECTORS) {
      const elements = Array.from(document.querySelectorAll(selector));
      for (const element of elements) {
        if (seen.has(element)) {
          continue;
        }
        seen.add(element);
        const text = textFromDomNode(element);
        if (text) {
          candidates.push(buildArticleCandidate('semantic-dom', text, { selector }));
        }
      }
    }

    return candidates;
  } catch (_error) {
    return [];
  } finally {
    dom?.window?.close();
  }
}

function extractReadabilityArticle(html = '', url = '') {
  let dom;
  try {
    dom = createDom(html, url);
    const document = dom.window.document;
    const readerable = isProbablyReaderable(document, {
      minContentLength: 80,
      minScore: 10,
    });
    const parsed = new Readability(document, {
      charThreshold: READABILITY_CHAR_THRESHOLD,
      keepClasses: false,
    }).parse();
    if (!parsed) {
      return null;
    }

    const textFromContent = articleBodyFromHtml(parsed.content || '');
    const text = normalizeText(textFromContent || parsed.textContent || '');
    if (!text) {
      return null;
    }

    return buildArticleCandidate('readability', text, {
      title: normalizeText(parsed.title || ''),
      byline: normalizeText(parsed.byline || ''),
      dek: normalizeText(parsed.excerpt || ''),
      publishedAt: normalizeText(parsed.publishedTime || ''),
      siteName: normalizeText(parsed.siteName || ''),
      readerable,
      length: parsed.length || text.length,
    });
  } catch (_error) {
    return null;
  } finally {
    dom?.window?.close();
  }
}

function countParagraphs(text = '') {
  return normalizeText(text)
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/)
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length >= 30)
    .length;
}

function boilerplatePenalty(text = '') {
  const matches = String(text || '').match(/\b(subscribe|newsletter|sign up|advertisement|sponsored|cookie policy|privacy policy|all rights reserved|share this article|follow us)\b/gi);
  return matches ? matches.length : 0;
}

function buildArticleCandidate(method, text = '', metadata = {}) {
  const normalized = normalizeText(text);
  const paragraphs = countParagraphs(normalized);
  const penalties = boilerplatePenalty(normalized);
  const methodWeight = {
    readability: 2600,
    'json-ld': 2100,
    'semantic-dom': 1700,
    'html-article': 800,
    'browser-text': 500,
  }[method] || 0;
  const score = methodWeight
    + Math.min(normalized.length, 8000)
    + Math.min(paragraphs * 160, 1600)
    - (penalties * 400);

  return {
    method,
    text: normalized,
    score,
    textChars: normalized.length,
    paragraphs,
    penalties,
    ...metadata,
  };
}

function chooseBestArticleCandidate(candidates = []) {
  return candidates
    .filter((candidate) => candidate?.text && candidate.text.length >= READABILITY_CHAR_THRESHOLD)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function looksLikeRenderedShell(html = '', extractedText = '') {
  const source = String(html || '');
  if (normalizeText(extractedText).length >= 500) {
    return false;
  }

  const scriptCount = (source.match(/<script\b/gi) || []).length;
  const paragraphCount = (source.match(/<p\b/gi) || []).length;
  const hasArticleSignals = /<article\b|itemprop=["']articleBody["']|article-body|story-body|entry-content|post-content/i.test(source);
  const hasAppShellSignals = /__NEXT_DATA__|data-reactroot|id=["'](?:root|app|__next)["']|webpackJsonp|window\.__APOLLO_STATE__|vite\/client/i.test(source);

  return normalizeText(extractedText).length < MIN_ARTICLE_TEXT_CHARS
    ? (hasAppShellSignals || scriptCount >= 8 || paragraphCount < 3)
    : (hasAppShellSignals && !hasArticleSignals);
}

function summarize(text = '', maxChars = DEFAULT_SITE_TEXT_LIMIT) {
  const normalized = normalizeText(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const clipped = normalized.slice(0, Math.max(100, maxChars));
  const sentenceEnd = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('? '), clipped.lastIndexOf('! '));
  return `${clipped.slice(0, sentenceEnd > 200 ? sentenceEnd + 1 : clipped.lastIndexOf(' ')).trim()}...`;
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class WebNewsScraperTool extends ToolBase {
  constructor() {
    super({
      id: 'news-scraper',
      name: 'News Scraper',
      description: 'Discover news with Perplexity, extract article text from source pages, and return a static news-site payload with direct JSON injection data',
      category: 'web',
      version: '1.0.0',
      backend: {
        sideEffects: ['network'],
        sandbox: { network: true },
        timeout: 180000,
      },
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'News topic or source discovery query' },
          urls: {
            type: 'array',
            description: 'Known article URLs to extract. If omitted, query is searched through Perplexity.',
            items: { type: 'string' },
          },
          limit: { type: 'integer', default: DEFAULT_LIMIT },
          region: { type: 'string', default: 'ca-en' },
          timeRange: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year', 'all'], default: 'day' },
          domains: { type: 'array', items: { type: 'string' } },
          articleCharLimit: { type: 'integer', default: DEFAULT_ARTICLE_CHAR_LIMIT },
          siteTextMode: {
            type: 'string',
            enum: ['excerpt', 'full'],
            default: 'excerpt',
            description: 'Use full only for owned, licensed, public-domain, Creative Commons, or explicitly permitted sources.',
          },
          contentRights: {
            type: 'string',
            enum: ['unknown', 'owned', 'licensed', 'public-domain', 'creative-commons', 'explicit-permission'],
            default: 'unknown',
          },
          weather: {
            type: 'object',
            description: 'Optional already-verified weather data to inject beside the news feed.',
          },
          includeWeatherPlaceholder: {
            type: 'boolean',
            default: true,
            description: 'Include a weather injection slot even when weather data is supplied later.',
          },
          title: { type: 'string', default: 'KimiBuilt News Source' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          articles: { type: 'array' },
          injection: { type: 'object' },
          site: { type: 'object' },
          skipped: { type: 'array' },
        },
      },
    });
  }

  validateInputs(params) {
    if (!params?.query && (!Array.isArray(params?.urls) || params.urls.length === 0)) {
      throw new Error('news-scraper requires either query or urls.');
    }
    super.validateInputs(params);
  }

  async handler(params, context, tracker) {
    const limit = clampInteger(params.limit, DEFAULT_LIMIT, { min: 1, max: 20 });
    const articleCharLimit = clampInteger(params.articleCharLimit, DEFAULT_ARTICLE_CHAR_LIMIT, { min: 1000, max: 80000 });
    const urls = await this.resolveArticleUrls(params, context, limit);
    const articles = [];
    const skipped = [];

    for (const url of urls.slice(0, limit)) {
      try {
        const article = await this.extractArticle(url, { articleCharLimit }, context, tracker);
        if (!article.text || article.text.length < MIN_ARTICLE_TEXT_CHARS) {
          skipped.push({ url, reason: 'article-text-too-short' });
          continue;
        }
        articles.push(article);
      } catch (error) {
        skipped.push({ url, reason: error.message });
      }
    }

    const canPublishFullText = params.siteTextMode === 'full' && FULL_TEXT_RIGHTS.has(String(params.contentRights || 'unknown'));
    const injection = this.buildInjectionPayload({
      query: params.query || '',
      title: params.title || 'KimiBuilt News Source',
      articles,
      weather: params.weather || null,
      includeWeatherPlaceholder: params.includeWeatherPlaceholder !== false,
      canPublishFullText,
    });

    return {
      query: params.query || '',
      articles,
      injection,
      site: {
        filename: 'index.html',
        contentType: 'text/html; charset=utf-8',
        html: this.renderNewsSite(injection),
        textMode: canPublishFullText ? 'full' : 'excerpt',
        rightsNotice: canPublishFullText
          ? 'Full-text rendering enabled because contentRights permits republication.'
          : 'Public site output uses excerpts by default; full extracted text remains in articles[] for research and licensed-source injection.',
      },
      skipped,
    };
  }

  async resolveArticleUrls(params, context, limit) {
    const supplied = Array.isArray(params.urls)
      ? params.urls.map((url) => normalizeUrl(url)).filter(Boolean)
      : [];
    if (supplied.length > 0) {
      return Array.from(new Set(supplied)).slice(0, limit);
    }

    const searchTool = this.resolveTool(context, 'web-search') || new WebSearchTool();
    const searchResult = await searchTool.execute({
      query: params.query,
      engine: 'perplexity',
      researchMode: 'pro-search',
      limit,
      region: params.region || 'ca-en',
      timeRange: params.timeRange || 'day',
      includeSnippets: true,
      includeUrls: true,
      domains: Array.isArray(params.domains) ? params.domains : [],
      maxTokens: 50000,
      maxTokensPerPage: 12000,
      maxOutputTokens: 4200,
      maxSteps: 5,
      instructions: [
        'Find article pages, not only homepages or topic pages.',
        'Prefer current source pages with bylines, dates, and readable article bodies.',
        'Return enough verified page evidence for follow-up extraction.',
      ].join(' '),
      userLocation: { country: 'CA' },
    }, context);

    const data = searchResult?.success === false ? null : (searchResult?.data || searchResult);
    const candidates = [
      ...(Array.isArray(data?.verifiedPages) ? data.verifiedPages : []),
      ...(Array.isArray(data?.results) ? data.results : []),
      ...(Array.isArray(data?.citations) ? data.citations : []),
    ];

    return Array.from(new Set(
      candidates
        .map((entry) => normalizeUrl(entry?.url || ''))
        .filter(Boolean),
    )).slice(0, limit);
  }

  async extractArticle(url, { articleCharLimit }, context, tracker) {
    const fetchTool = this.resolveTool(context, 'web-fetch') || new WebFetchTool();
    const fetched = await fetchTool.execute({
      url,
      timeout: 30000,
      cache: true,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, context);

    if (fetched?.success === false) {
      throw new Error(fetched.error || 'fetch-failed');
    }

    const html = String(fetched?.data?.body || fetched?.body || '');
    let finalUrl = normalizeUrl(fetched?.data?.url || fetched?.url || url) || url;
    if (!html) {
      throw new Error('empty-response-body');
    }

    tracker?.recordRead?.(finalUrl, { type: 'news-article-html', size: html.length });
    let article = this.buildArticleFromHtml(html, finalUrl, { articleCharLimit });

    if (looksLikeRenderedShell(html, article.text)) {
      const rendered = await this.fetchRenderedPage(finalUrl, context, tracker).catch((error) => ({
        error: error.message,
      }));
      if (rendered?.html) {
        const renderedUrl = normalizeUrl(rendered.url || finalUrl) || finalUrl;
        const renderedArticle = this.buildArticleFromHtml(rendered.html, renderedUrl, { articleCharLimit });
        const renderedBetter = renderedArticle.text.length > article.text.length
          || renderedArticle.stats.extraction.score > article.stats.extraction.score + 500;
        if (renderedBetter) {
          finalUrl = renderedUrl;
          article = {
            ...renderedArticle,
            stats: {
              ...renderedArticle.stats,
              staticHtmlChars: html.length,
              renderedFallback: true,
              renderedEngine: rendered.engine || 'browser',
              browserWarnings: rendered.warnings || [],
            },
          };
        } else {
          article.stats.renderedFallback = false;
          article.stats.renderedFallbackReason = 'static-extraction-was-better';
        }
      } else if (rendered?.error) {
        article.stats.renderedFallback = false;
        article.stats.renderedFallbackError = rendered.error;
      }
    }

    return article;
  }

  buildArticleFromHtml(html, finalUrl, { articleCharLimit }) {
    const jsonLdArticles = extractJsonLdArticles(html);
    const jsonArticle = jsonLdArticles[0] || {};
    const readabilityCandidate = extractReadabilityArticle(html, finalUrl);
    const semanticCandidates = extractSemanticArticleCandidates(html, finalUrl);
    const jsonBody = normalizeText(jsonArticle.articleBody || jsonArticle.text || '');
    const htmlBody = articleBodyFromHtml(html);
    const bodyCandidate = chooseBestArticleCandidate([
      readabilityCandidate,
      jsonBody ? buildArticleCandidate('json-ld', jsonBody) : null,
      ...semanticCandidates,
      htmlBody ? buildArticleCandidate('html-article', htmlBody) : null,
    ]);
    const canonicalUrl = findLinkHref(html, 'canonical', finalUrl)
      || normalizeUrl(findMetaContent(html, ['og:url']), finalUrl)
      || firstAttribute(html, [
        /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i,
        /<meta\b[^>]*(?:property|name)=["']og:url["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      ], finalUrl)
      || finalUrl;

    const title = normalizeText(
      jsonArticle.headline
      || jsonArticle.name
      || findMetaContent(html, ['og:title', 'twitter:title'])
      || firstMatch(html, [
        /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
        /<title\b[^>]*>([\s\S]*?)<\/title>/i,
      ])
      || readabilityCandidate?.title,
    ) || canonicalUrl;
    const byline = normalizeAuthor(jsonArticle.author) || findMetaContent(html, ['author', 'article:author']) || readabilityCandidate?.byline || firstMatch(html, [
      /<span\b[^>]*class=["'][^"']*(?:author|byline)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      /<p\b[^>]*class=["'][^"']*(?:author|byline)[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    ]);
    const publishedAt = normalizeText(
      jsonArticle.datePublished
      || jsonArticle.dateCreated
      || findMetaContent(html, ['article:published_time', 'date', 'publishdate', 'pubdate', 'dc.date', 'dc.date.issued'])
      || firstMatch(html, [
        /<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i,
      ])
      || readabilityCandidate?.publishedAt,
    );
    const leadImage = normalizeUrl(
      firstImageValue(jsonArticle.image)
        || findMetaContent(html, ['og:image', 'twitter:image'])
        || firstAttribute(html, [
          /<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
          /<meta\b[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
        ], finalUrl),
      finalUrl,
    );
    const body = normalizeText(bodyCandidate?.text || '').slice(0, articleCharLimit);
    const dek = findMetaContent(html, ['og:description', 'twitter:description', 'description'])
      || readabilityCandidate?.dek
      || firstMatch(html, [
        /<meta\b[^>]*(?:property|name)=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
        /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      ]);

    return {
      title,
      url: canonicalUrl,
      sourceUrl: finalUrl,
      source: getHostname(canonicalUrl || finalUrl),
      byline,
      publishedAt,
      leadImage,
      dek,
      text: body,
      excerpt: summarize(body),
      extractedAt: new Date().toISOString(),
      stats: {
        htmlChars: html.length,
        textChars: body.length,
        extraction: {
          method: bodyCandidate?.method || 'none',
          score: bodyCandidate?.score || 0,
          paragraphs: bodyCandidate?.paragraphs || 0,
          candidates: [
            readabilityCandidate,
            ...(jsonBody ? [buildArticleCandidate('json-ld', jsonBody)] : []),
            ...semanticCandidates,
            ...(htmlBody ? [buildArticleCandidate('html-article', htmlBody)] : []),
          ].filter(Boolean).map((candidate) => ({
            method: candidate.method,
            selector: candidate.selector,
            textChars: candidate.textChars,
            paragraphs: candidate.paragraphs,
            score: candidate.score,
          })),
        },
      },
    };
  }

  async fetchRenderedPage(url, context, tracker) {
    tracker?.recordNetworkCall?.(url, 'GET', { browserFallback: true });
    const rendered = await browsePage(url, {
      timeout: 45000,
      waitForSelector: 'body',
      actions: [{ type: 'wait_for_timeout', ms: 1200 }],
      sessionId: context?.sessionId || null,
      contentCharLimit: DEFAULT_ARTICLE_CHAR_LIMIT,
    });
    tracker?.recordRead?.(rendered.url || url, {
      type: 'news-article-rendered-html',
      size: String(rendered.html || '').length,
      engine: rendered.engine || 'browser',
    });
    return rendered;
  }

  buildInjectionPayload({ query, title, articles, weather, includeWeatherPlaceholder, canPublishFullText }) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      query,
      title,
      weather: weather || (includeWeatherPlaceholder ? {
        status: 'pending',
        note: 'Inject verified weather data here without rebuilding the site.',
      } : null),
      articles: articles.map((article, index) => ({
        id: `article-${String(index + 1).padStart(2, '0')}`,
        title: article.title,
        source: article.source,
        url: article.url,
        byline: article.byline,
        publishedAt: article.publishedAt,
        leadImage: article.leadImage,
        dek: article.dek,
        excerpt: article.excerpt,
        text: canPublishFullText ? article.text : article.excerpt,
        hasFullText: canPublishFullText,
      })),
    };
  }

  renderNewsSite(injection) {
    const payload = JSON.stringify(injection, null, 2).replace(/</g, '\\u003c');
    const articles = injection.articles.map((article, index) => `
      <article class="story${index === 0 ? ' story-lead' : ''}">
        ${article.leadImage ? `<img src="${escapeHtml(article.leadImage)}" alt="">` : ''}
        <div class="story-body">
          <p class="source">${escapeHtml(article.source || 'Source')}</p>
          <h2>${escapeHtml(article.title)}</h2>
          <p class="meta">${escapeHtml([article.byline, article.publishedAt].filter(Boolean).join(' - '))}</p>
          <p>${escapeHtml(article.text || article.excerpt)}</p>
          <a href="${escapeHtml(article.url)}" rel="noopener noreferrer" target="_blank">Read at source</a>
        </div>
      </article>`).join('\n');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(injection.title || 'KimiBuilt News Source')}</title>
  <style>
    :root { --page: #f7f5ef; --text: #17201b; --muted: #5e665f; --surface: #ffffff; --panel: #14231c; --panelText: #f6f3e9; --accent: #b43f2e; --border: #d8d1c2; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--page); color: var(--text); font: 16px/1.55 Georgia, 'Times New Roman', serif; }
    header { background: var(--panel); color: var(--panelText); padding: 28px clamp(18px, 4vw, 56px); border-bottom: 6px solid var(--accent); }
    header h1 { margin: 0; font-size: clamp(2rem, 5vw, 4.5rem); line-height: 0.95; letter-spacing: 0; }
    header p { max-width: 780px; margin: 14px 0 0; color: #ddd8ca; font-family: Arial, sans-serif; }
    main { width: min(1180px, calc(100% - 32px)); margin: 28px auto 56px; display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 28px; }
    .feed { display: grid; gap: 18px; }
    .story { background: var(--surface); border: 1px solid var(--border); display: grid; grid-template-columns: 180px minmax(0, 1fr); min-height: 180px; }
    .story-lead { grid-template-columns: minmax(0, 1fr); }
    .story img { width: 100%; height: 100%; min-height: 180px; object-fit: cover; background: #e4ded1; }
    .story-lead img { height: 340px; }
    .story-body { padding: 18px; }
    .source { color: var(--accent); font: 700 0.78rem/1.2 Arial, sans-serif; text-transform: uppercase; margin: 0 0 8px; }
    h2 { font-size: clamp(1.35rem, 2.2vw, 2.4rem); line-height: 1.05; margin: 0 0 8px; letter-spacing: 0; }
    .meta { color: var(--muted); font: 0.9rem/1.4 Arial, sans-serif; margin: 0 0 12px; }
    a { color: #8f2d22; font-weight: 700; }
    aside { align-self: start; position: sticky; top: 18px; display: grid; gap: 16px; }
    .widget { background: var(--surface); border: 1px solid var(--border); padding: 18px; font-family: Arial, sans-serif; }
    .widget h2 { font-family: Georgia, 'Times New Roman', serif; font-size: 1.25rem; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.78rem; background: #f0ece2; padding: 12px; max-height: 320px; overflow: auto; }
    @media (max-width: 820px) { main { grid-template-columns: 1fr; } aside { position: static; } .story { grid-template-columns: 1fr; } .story img { height: 220px; } }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(injection.title || 'KimiBuilt News Source')}</h1>
    <p>Updated ${escapeHtml(injection.generatedAt)}. News and weather are driven by the embedded JSON payload, so a deployed frontend can replace it directly without rebuilding the page.</p>
  </header>
  <main>
    <section class="feed">${articles || '<p>No articles extracted yet.</p>'}</section>
    <aside>
      <section class="widget">
        <h2>Weather</h2>
        <p>${escapeHtml(injection.weather?.summary || injection.weather?.note || 'Weather injection slot ready.')}</p>
      </section>
      <section class="widget">
        <h2>Injection Payload</h2>
        <pre id="payload"></pre>
      </section>
    </aside>
  </main>
  <script type="application/json" id="news-data">${payload}</script>
  <script>document.getElementById('payload').textContent = document.getElementById('news-data').textContent;</script>
</body>
</html>`;
  }

  resolveTool(context = {}, toolId) {
    const contextualTool = typeof context.tools?.get === 'function' ? context.tools.get(toolId) : null;
    if (contextualTool?.execute) {
      return contextualTool;
    }
    if (context.toolManager?.getTool) {
      const managerTool = context.toolManager.getTool(toolId);
      if (managerTool?.execute) {
        return managerTool;
      }
    }
    return null;
  }
}

module.exports = { WebNewsScraperTool };
