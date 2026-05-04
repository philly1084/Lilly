/**
 * WebScrapeTool - Structured data extraction from web pages
 * Supports CSS selectors, XPath, and AI-powered extraction
 */

const { ToolBase } = require('../../ToolBase');
const { config } = require('../../../../config');
const { artifactService } = require('../../../../artifacts/artifact-service');
const { browsePage, normalizeBrowserUrl } = require('./browser-runtime');
const { evaluateResearchSitePolicy, normalizeDomainList } = require('./research-site-policy');

class WebScrapeTool extends ToolBase {
  constructor() {
    super({
      id: 'web-scrape',
      name: 'Web Scraper',
      description: 'Extract structured data from web pages using selectors, with optional headless-browser rendering for dynamic pages and TLS/certificate-problem sites',
      category: 'web',
      version: '1.0.0',
      backend: {
        sideEffects: ['network'],
        sandbox: { network: true },
        timeout: 60000
      },
      inputSchema: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            description: 'URL to scrape'
          },
          selectors: {
            type: 'object',
            description: 'CSS selectors for structured extraction, keyed by field name. Omit for screenshot-only QA; do not send an array.',
            additionalProperties: {
              type: 'object',
              properties: {
                selector: { type: 'string' },
                attribute: { type: 'string' },
                multiple: { type: 'boolean', default: false },
                transform: { type: 'string', enum: ['text', 'html', 'number', 'url'] }
              }
            }
          },
          xpath: {
            type: 'object',
            description: 'XPath expressions for extraction'
          },
          aiExtraction: {
            type: 'object',
            description: 'AI-powered extraction schema',
            properties: {
              enabled: { type: 'boolean', default: false },
              schema: {
                type: 'object',
                description: 'JSON schema describing what to extract'
              },
              prompt: {
                type: 'string',
                description: 'Additional extraction instructions'
              }
            }
          },
          waitForSelector: {
            type: 'string',
            description: 'Wait for a selector in the rendered DOM before extracting (browser mode)'
          },
          captureImages: {
            type: 'boolean',
            description: 'Extract image references from the page. When blindImageCapture is enabled, download them as opaque artifacts instead of exposing image content to the model.',
            default: false,
          },
          blindImageCapture: {
            type: 'boolean',
            description: 'Download captured images as binary artifacts and return only safe metadata such as artifact ids, filenames, and download paths.',
            default: false,
          },
          imageLimit: {
            type: 'integer',
            description: 'Maximum number of images to capture from the page',
            default: 12,
          },
          javascript: {
            type: 'boolean',
            description: 'Use the backend headless browser and rendered DOM for JavaScript-heavy pages',
            default: false
          },
          browser: {
            type: 'boolean',
            description: 'Force backend headless-browser rendering, useful for dynamic pages and certificate/TLS fetch failures',
            default: false
          },
          approvedDomains: {
            type: 'array',
            description: 'Optional approved hosts or domains for research-safe scraping. Matching subdomains are allowed.',
            items: {
              type: 'string',
            },
          },
          researchSafe: {
            type: 'boolean',
            description: 'Treat the scrape as search-follow-up research: skip pages that are outside the approved domains or explicitly disallow bots.',
            default: false,
          },
          respectRobotsTxt: {
            type: 'boolean',
            description: 'Check robots.txt before research-safe scraping and skip pages that explicitly disallow automated access.',
            default: false,
          },
          actions: {
            type: 'array',
            description: 'Optional browser actions to execute before extracting content, such as click, fill, type, press, wait_for_selector, wait_for_timeout, hover, scroll, or select_option',
            items: {
              type: 'object',
            },
          },
          captureScreenshot: {
            type: 'boolean',
            description: 'Capture a screenshot artifact of the rendered page when browser mode is used',
            default: false,
          },
          viewport: {
            type: 'object',
            description: 'Optional browser viewport for rendering and screenshot capture, for example { "width": 390, "height": 844 } for mobile checks',
            properties: {
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
          },
          fullPageScreenshot: {
            type: 'boolean',
            description: 'Capture the full page when captureScreenshot is enabled',
            default: true,
          },
          timeout: {
            type: 'integer',
            default: 30000
          }
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string' },
          contentLength: { type: 'integer' },
          data: { type: 'object' },
          links: { type: 'array' },
          headings: { type: 'array' },
          sitePolicy: { type: ['object', 'null'] },
          screenshot: { type: ['object', 'null'] },
          extractedAt: { type: 'string' },
          method: { type: 'string' }
        }
      }
    });
  }

  validateInputs(params) {
    this.normalizeSelectorParams(params);
    super.validateInputs(params);
  }

  normalizeSelectorParams(params = {}) {
    if (!params || typeof params !== 'object' || !Object.prototype.hasOwnProperty.call(params, 'selectors')) {
      return;
    }

    const normalizedSelectors = this.normalizeSelectors(params.selectors);
    if (normalizedSelectors && Object.keys(normalizedSelectors).length > 0) {
      params.selectors = normalizedSelectors;
      return;
    }

    delete params.selectors;
  }

  normalizeSelectors(selectors) {
    if (!selectors) {
      return null;
    }

    const entries = Array.isArray(selectors)
      ? selectors.map((config, index) => [this.resolveSelectorKey(config, index), config])
      : (typeof selectors === 'object'
        ? Object.entries(selectors)
        : [['content', selectors]]);
    const normalized = {};

    for (const [rawKey, rawConfig] of entries) {
      const config = this.normalizeSelectorConfig(rawConfig);
      if (!config?.selector) {
        continue;
      }

      const key = this.makeUniqueSelectorKey(normalized, rawKey || 'selector');
      normalized[key] = config;
    }

    return normalized;
  }

  resolveSelectorKey(config, index) {
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      const candidate = config.key || config.name || config.field || config.id || config.label;
      if (candidate) {
        return String(candidate);
      }
    }

    return `selector${index + 1}`;
  }

  makeUniqueSelectorKey(existing, key) {
    const base = String(key || 'selector')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      || 'selector';
    let candidate = base;
    let suffix = 2;

    while (Object.prototype.hasOwnProperty.call(existing, candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  normalizeSelectorConfig(config) {
    if (typeof config === 'string') {
      const selector = config.trim();
      return selector ? { selector, transform: 'text' } : null;
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return null;
    }

    const selector = String(
      config.selector
      || config.css
      || config.cssSelector
      || config.query
      || config.value
      || '',
    ).trim();

    if (!selector) {
      return null;
    }

    const transformCandidate = String(config.transform || '').trim().toLowerCase();
    const transform = ['text', 'html', 'number', 'url'].includes(transformCandidate)
      ? transformCandidate
      : 'text';
    const multiple = config.multiple === true
      || String(config.multiple || '').trim().toLowerCase() === 'true';

    return {
      selector,
      ...(typeof config.attribute === 'string' && config.attribute.trim()
        ? { attribute: config.attribute.trim() }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(config, 'multiple')
        ? { multiple }
        : {}),
      transform,
    };
  }

  async handler(params, context, tracker) {
    const {
      url,
      selectors,
      xpath,
      aiExtraction,
      waitForSelector,
      captureImages = false,
      blindImageCapture = false,
      imageLimit = 12,
      javascript = false,
      browser = false,
      approvedDomains = [],
      researchSafe = false,
      actions = [],
      captureScreenshot = false,
      viewport = null,
      fullPageScreenshot = true,
      timeout = 30000
    } = params;
    const effectiveApprovedDomains = normalizeDomainList(approvedDomains);
    const respectRobotsTxt = Object.prototype.hasOwnProperty.call(params || {}, 'respectRobotsTxt')
      ? params.respectRobotsTxt !== false
      : (researchSafe ? config.scrape.respectRobotsTxt : false);
    let sitePolicy = null;

    if (researchSafe || effectiveApprovedDomains.length > 0 || respectRobotsTxt) {
      sitePolicy = await evaluateResearchSitePolicy(url, {
        approvedDomains: effectiveApprovedDomains,
        respectRobotsTxt,
        timeout: config.scrape.robotsTimeoutMs,
      });
      if (researchSafe && sitePolicy.allowed === false) {
        if (sitePolicy.reason === 'host-not-approved') {
          throw new Error(`Research-safe scraping skipped ${url}: host is not in the approved domain set.`);
        }
        if (sitePolicy.reason === 'robots-disallow') {
          const robotsUrl = sitePolicy.robots?.url ? ` (${sitePolicy.robots.url})` : '';
          throw new Error(`Research-safe scraping skipped ${url}: robots.txt disallows automated access${robotsUrl}.`);
        }
        throw new Error(`Research-safe scraping skipped ${url}: site policy check failed.`);
      }
    }

    let html;
    let finalUrl = url;
    let title = '';
    let content = '';
    let links = [];
    let headings = [];
    let browserData = null;
    
    const fetchTool = this.resolveFetchTool(context);
    const internalArtifactPreview = fetchTool
      ? this.parseInternalArtifactPreviewUrl(fetchTool, url)
      : null;

    if (internalArtifactPreview) {
      const fetchResult = await fetchTool.execute({
        url,
        timeout,
        cache: false,
      }, context);
      if (!fetchResult.success) {
        throw new Error(`Failed to fetch internal artifact preview: ${fetchResult.error}`);
      }
      html = fetchResult.data.body;
      finalUrl = fetchResult.data.url;
    } else if (browser || javascript) {
      browserData = await browsePage(url, {
        timeout,
        waitForSelector,
        selectors,
        actions,
        captureScreenshot,
        viewport,
        fullPageScreenshot,
        sessionId: context?.sessionId || null,
        imageLimit,
        contentCharLimit: config.scrape.contentCharLimit,
      });
      html = browserData.html;
      finalUrl = browserData.url || this.normalizeUrl(url);
      title = browserData.title || '';
      content = browserData.text || '';
      links = Array.isArray(browserData.links) ? browserData.links : [];
      headings = Array.isArray(browserData.headings) ? browserData.headings : [];
    } else {
      // Static fetch
      if (!fetchTool) {
        throw new Error('WebFetchTool not available');
      }
      
      const fetchResult = await fetchTool.execute({ url, timeout }, context);
      if (!fetchResult.success) {
        if (this.shouldFallbackToBrowser(fetchResult.error)) {
          browserData = await browsePage(url, {
            timeout,
            waitForSelector,
            selectors,
            actions,
            captureScreenshot,
            viewport,
            fullPageScreenshot,
            sessionId: context?.sessionId || null,
            imageLimit,
            contentCharLimit: config.scrape.contentCharLimit,
          });
          html = browserData.html;
          finalUrl = browserData.url || this.normalizeUrl(url);
          title = browserData.title || '';
          content = browserData.text || '';
          links = Array.isArray(browserData.links) ? browserData.links : [];
          headings = Array.isArray(browserData.headings) ? browserData.headings : [];
        } else {
          throw new Error(`Failed to fetch: ${fetchResult.error}`);
        }
      } else {
        html = fetchResult.data.body;
        finalUrl = fetchResult.data.url;
      }
    }

    tracker.recordRead(url, { type: 'html', size: html.length });

    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      title = titleMatch ? titleMatch[1].trim() : '';
    }
    if (!content) {
      content = this.extractPageText(html);
    }

    let extractedData = {};
    let method = internalArtifactPreview ? 'internal-artifact-preview' : (browserData ? `${browserData.engine}-rendered` : 'static');

    // CSS Selector extraction
    if (selectors) {
      extractedData = browserData?.selectorData && Object.keys(browserData.selectorData).length > 0
        ? browserData.selectorData
        : await this.extractWithSelectors(html, selectors);
      method = browserData
        ? `${browserData.engine}-css-selectors`
        : (internalArtifactPreview ? 'internal-artifact-preview-css-selectors' : (browser || javascript ? 'browser-css-selectors' : 'css-selectors'));
    }

    // XPath extraction (if implemented)
    if (xpath) {
      // Would use xpath library
      extractedData.xpath = { note: 'XPath extraction requires additional library' };
    }

    // AI-powered extraction
    if (aiExtraction?.enabled) {
      const aiData = await this.extractWithAI(html, aiExtraction, context);
      extractedData = { ...extractedData, ...aiData };
      method = 'ai-assisted';
    }

    let imageCapture = null;
    if (captureImages || blindImageCapture) {
      imageCapture = await this.captureImages({
        html,
        imageUrls: browserData?.images,
        pageUrl: finalUrl,
        context,
        blindImageCapture,
        imageLimit,
        timeout,
      });
    }

    return {
      url: finalUrl,
      title,
      content,
      contentLength: content.length,
      data: extractedData,
      links,
      headings,
      sitePolicy,
      browser: browserData
        ? {
          engine: browserData.engine,
          actions: browserData.actions || [],
          warnings: browserData.warnings || [],
        }
        : null,
      screenshot: browserData?.screenshot || null,
      imageCapture,
      extractedAt: new Date().toISOString(),
      method,
      stats: {
        htmlSize: html.length,
        contentChars: content.length,
        fieldsExtracted: Object.keys(extractedData).length,
        imagesCaptured: imageCapture?.count || 0,
        linksCaptured: links.length,
        headingsCaptured: headings.length,
      }
    };
  }

  async captureImages({ html, imageUrls = null, pageUrl, context = {}, blindImageCapture = false, imageLimit = 12, timeout = 30000 }) {
    const normalizedImageUrls = Array.isArray(imageUrls) && imageUrls.length > 0
      ? imageUrls.slice(0, Math.max(1, Math.min(Number(imageLimit) || 12, 50)))
      : this.extractImageUrls(html, pageUrl, imageLimit);
    if (normalizedImageUrls.length === 0) {
      return {
        mode: blindImageCapture ? 'blind-artifacts' : 'listed',
        count: 0,
        items: [],
      };
    }

    if (!blindImageCapture) {
      return {
        mode: 'listed',
        count: normalizedImageUrls.length,
        items: normalizedImageUrls.map((url, index) => ({
          index: index + 1,
          sourceUrl: url,
        })),
      };
    }

    const sessionId = context.sessionId;
    if (!sessionId) {
      throw new Error('blindImageCapture requires a sessionId in the tool context');
    }

    const items = [];
    for (let index = 0; index < normalizedImageUrls.length; index += 1) {
      const sourceUrl = normalizedImageUrls[index];
      const downloaded = await this.downloadImageBinary(sourceUrl, timeout);
      const extension = this.resolveImageExtension(sourceUrl, downloaded.mimeType);
      const filename = `blind-image-${String(index + 1).padStart(2, '0')}.${extension}`;
      const stored = await artifactService.createStoredArtifact({
        sessionId,
        direction: 'generated',
        sourceMode: 'chat',
        filename,
        extension,
        mimeType: downloaded.mimeType,
        buffer: downloaded.buffer,
        extractedText: '',
        previewHtml: '',
        metadata: {
          blindCapture: true,
          sourceHost: this.getHostname(sourceUrl),
          sourceUrl,
          capturedFromPage: pageUrl,
          contentClassification: 'uninspected-sensitive-image',
        },
        vectorize: false,
      });

      items.push({
        index: index + 1,
        artifactId: stored.id,
        filename: stored.filename,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        sourceHost: this.getHostname(sourceUrl),
        downloadPath: `/api/artifacts/${stored.id}/download`,
        inlinePath: `/api/artifacts/${stored.id}/download?inline=1`,
      });
    }

    return {
      mode: 'blind-artifacts',
      count: items.length,
      items,
    };
  }

  resolveFetchTool(context = {}) {
    const contextualTool = typeof context.tools?.get === 'function'
      ? context.tools.get('web-fetch')
      : null;

    if (contextualTool?.execute) {
      return contextualTool;
    }

    if (context.toolManager?.getTool) {
      const managerTool = context.toolManager.getTool('web-fetch');
      if (managerTool?.execute) {
        return managerTool;
      }
    }

    try {
      const { getToolManager } = require('../../index');
      const managerTool = getToolManager().getTool('web-fetch');
      if (managerTool?.execute) {
        return managerTool;
      }
    } catch (_error) {
      // Fall through to a direct tool instance.
    }

    try {
      const { WebFetchTool } = require('./WebFetchTool');
      return new WebFetchTool();
    } catch (_error) {
      return null;
    }
  }

  parseInternalArtifactPreviewUrl(fetchTool, url = '') {
    if (!fetchTool || typeof fetchTool.normalizeUrl !== 'function') {
      return null;
    }

    try {
      const normalizedUrl = fetchTool.normalizeUrl(url);
      const parsed = new URL(normalizedUrl);
      const match = parsed.pathname.match(
        /^\/api\/artifacts\/([a-f0-9-]+)\/(?:preview|sandbox|preview-access|sandbox-access)(?:\/|$)/i,
      );
      return match?.[1]
        ? { artifactId: match[1], url: normalizedUrl }
        : null;
    } catch (_error) {
      return null;
    }
  }

  shouldFallbackToBrowser(errorMessage = '') {
    const normalized = String(errorMessage || '').toLowerCase();
    return [
      'unable_to_get_issuer_cert_locally',
      'self signed certificate',
      'certificate',
      'ssl',
      'tls',
      'cloudflare',
      'javascript challenge',
    ].some((token) => normalized.includes(token));
  }

  normalizeUrl(url) {
    return normalizeBrowserUrl(url);
  }

  extractImageUrls(html, pageUrl, imageLimit = 12) {
    const matches = Array.from(String(html || '').matchAll(/<img\b[^>]*>/gi));
    const unique = new Set();
    const results = [];

    for (const match of matches) {
      const tag = match[0] || '';
      const candidate = this.extractImageSourceFromTag(tag);
      const normalized = this.normalizeImageCandidateUrl(candidate, pageUrl);
      if (!normalized || unique.has(normalized)) {
        continue;
      }

      unique.add(normalized);
      results.push(normalized);
      if (results.length >= Math.max(1, Math.min(Number(imageLimit) || 12, 50))) {
        break;
      }
    }

    return results;
  }

  extractImageSourceFromTag(tag = '') {
    const candidates = [
      /(?:src|data-src|data-lazy-src|data-original)=["']([^"']+)["']/i,
      /srcset=["']([^"']+)["']/i,
    ];

    for (const pattern of candidates) {
      const match = String(tag || '').match(pattern);
      if (!match?.[1]) {
        continue;
      }

      const value = match[1].split(',')[0].trim().split(/\s+/)[0].trim();
      if (value) {
        return value;
      }
    }

    return null;
  }

  normalizeImageCandidateUrl(candidate, pageUrl) {
    const value = String(candidate || '').trim();
    if (!value || value.startsWith('data:')) {
      return null;
    }

    try {
      const normalized = new URL(value, pageUrl).toString();
      return /^https?:\/\//i.test(normalized) ? normalized : null;
    } catch (_error) {
      return null;
    }
  }

  async downloadImageBinary(url, timeout = 30000) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'LillyBuilt-Agent/1.0 (Blind Image Capture)',
        'Accept': 'image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      throw new Error(`Failed to download image (${response.status}) from ${url}`);
    }

    const mimeType = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());
    return { mimeType, buffer };
  }

  resolveImageExtension(url, mimeType = '') {
    const byMime = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'image/avif': 'avif',
    };

    if (byMime[mimeType]) {
      return byMime[mimeType];
    }

    try {
      const pathname = new URL(url).pathname || '';
      const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (match?.[1]) {
        return match[1].toLowerCase();
      }
    } catch (_error) {
      // Ignore URL parsing errors here; caller already normalized the URL.
    }

    return 'bin';
  }

  getHostname(url = '') {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch (_error) {
      return '';
    }
  }

  async extractWithSelectors(html, selectors) {
    const results = {};
    
    for (const [key, config] of Object.entries(selectors)) {
      const { selector, attribute, multiple = false, transform = 'text' } = config;
      
      if (multiple) {
        results[key] = this.extractAllMatches(html, selector, attribute, transform);
      } else {
        results[key] = this.extractFirstMatch(html, selector, attribute, transform);
      }
    }
    
    return results;
  }

  extractFirstMatch(html, selector, attribute, transform) {
    // Simple regex-based CSS selector matching
    // In production, use cheerio or similar
    const regex = this.selectorToRegex(selector);
    const match = html.match(regex);
    
    if (!match) return null;
    
    let value = attribute ? this.extractAttribute(match[0], attribute) : match[1] || match[0];
    
    return this.transformValue(value, transform);
  }

  extractAllMatches(html, selector, attribute, transform) {
    const regex = this.selectorToRegex(selector);
    const matches = [];
    let match;
    
    while ((match = regex.exec(html)) !== null) {
      let value = attribute ? this.extractAttribute(match[0], attribute) : match[1] || match[0];
      matches.push(this.transformValue(value, transform));
    }
    
    return matches;
  }

  selectorToRegex(selector) {
    // Very basic selector to regex conversion
    // e.g., '.price' -> class="price" or class='price'
    // e.g., 'h1' -> <h1>...</h1>
    
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return new RegExp(`class=["'][^"']*${className}[^"']*["'][^>]*>([^<]*)`, 'gi');
    }
    
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      return new RegExp(`id=["']${id}["'][^>]*>([^<]*)`, 'i');
    }
    
    // Tag selector
    return new RegExp(`<${selector}[^>]*>([^<]*)</${selector}>`, 'i');
  }

  extractAttribute(tagHtml, attribute) {
    const regex = new RegExp(`${attribute}=["']([^"']*)["']`, 'i');
    const match = tagHtml.match(regex);
    return match ? match[1] : null;
  }

  transformValue(value, transform) {
    if (!value) return value;
    
    switch (transform) {
      case 'text':
        return this.stripHtml(value).trim();
      case 'html':
        return value;
      case 'number':
        return parseFloat(value.replace(/[^0-9.-]/g, ''));
      case 'url':
        return this.resolveUrl(value);
      default:
        return value;
    }
  }

  stripHtml(html) {
    return html.replace(/<[^>]*>/g, '');
  }

  extractPageText(html = '') {
    const text = String(html || '')
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
      .trim();

    return text.slice(0, config.scrape.contentCharLimit);
  }

  resolveUrl(url) {
    // Basic URL resolution
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    // Would need base URL for relative paths
    return url;
  }

  async extractWithAI(html, aiConfig, context) {
    // Would use LLM to extract structured data
    // This is a placeholder implementation
    return {
      aiExtracted: {
        note: 'AI extraction requires LLM integration',
        prompt: aiConfig.prompt,
        schema: aiConfig.schema
      }
    };
  }
}

module.exports = { WebScrapeTool };
