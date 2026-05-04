/**
 * WebFetchTool - Basic HTTP fetching with retry, caching, and rate limiting
 */

const { ToolBase } = require('../../ToolBase');
const { artifactService } = require('../../../../artifacts/artifact-service');
const { getApiBaseUrl, resolveInternalUrl } = require('./internal-url');
const {
  getArtifactFrontendBundle,
  getFrontendBundleFile,
  injectBundleBaseHref,
  resolveArtifactFrontendBundleFile,
  resolveFrontendBundleContentType,
  rewriteRootRelativeFrontendPaths,
} = require('../../../../frontend-bundles');

class WebFetchTool extends ToolBase {
  constructor() {
    super({
      id: 'web-fetch',
      name: 'Web Fetch',
      description: 'Fetch content from URLs with retry and caching',
      category: 'web',
      version: '1.0.0',
      backend: {
        sideEffects: ['network'],
        sandbox: { network: true },
        timeout: 30000
      },
      inputSchema: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            description: 'URL to fetch',
            format: 'uri'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
            default: 'GET',
            description: 'HTTP method'
          },
          headers: {
            type: 'object',
            description: 'Additional HTTP headers'
          },
          body: {
            type: ['string', 'object'],
            description: 'Request body (for POST/PUT)'
          },
          timeout: {
            type: 'integer',
            description: 'Request timeout in ms',
            default: 30000
          },
          retries: {
            type: 'integer',
            description: 'Number of retries on failure',
            default: 3
          },
          cache: {
            type: 'boolean',
            description: 'Enable response caching',
            default: true
          },
          cacheTtl: {
            type: 'integer',
            description: 'Cache TTL in seconds',
            default: 300
          },
          followRedirects: {
            type: 'boolean',
            description: 'Follow HTTP redirects',
            default: true
          },
          maxRedirects: {
            type: 'integer',
            description: 'Maximum redirects to follow',
            default: 5
          }
        }
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'integer' },
          statusText: { type: 'string' },
          headers: { type: 'object' },
          body: { type: 'string' },
          url: { type: 'string' },
          cached: { type: 'boolean' },
          duration: { type: 'integer' }
        }
      }
    });

    // In-memory cache
    this.cache = new Map();
  }

  async handler(params, context, tracker) {
    const {
      url,
      method = 'GET',
      headers = {},
      body,
      timeout = 30000,
      retries = 3,
      cache = true,
      cacheTtl = 300,
      followRedirects = true,
      maxRedirects = 5
    } = params;

    const normalizedUrl = this.normalizeUrl(url);
    const internalArtifactRequest = this.parseInternalArtifactRequest(normalizedUrl);

    if (internalArtifactRequest) {
      const startTime = Date.now();
      const artifact = await artifactService.getArtifact(internalArtifactRequest.artifactId, { includeContent: true });
      if (!artifact) {
        throw new Error(`Artifact not found for ${normalizedUrl}`);
      }

      const resolvedArtifact = this.resolveInternalArtifactContent(artifact, internalArtifactRequest);

      const result = {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': resolvedArtifact.mimeType || artifact.mimeType || 'application/octet-stream',
        },
        body: this.serializeArtifactBody(resolvedArtifact.contentBuffer, resolvedArtifact.mimeType || artifact.mimeType),
        url: normalizedUrl,
        duration: Date.now() - startTime,
        cached: false,
      };

      tracker.recordNetworkCall(normalizedUrl, method, {
        status: 200,
        internalArtifact: true,
        artifactRoute: internalArtifactRequest.route,
        contentType: resolvedArtifact.mimeType || artifact.mimeType || 'application/octet-stream',
      });

      return result;
    }

    // Check cache first
    const cacheKey = this.getCacheKey({ ...params, url: normalizedUrl });
    if (cache && method === 'GET') {
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        tracker.recordNetworkCall(normalizedUrl, method, { cached: true });
        return { ...cached, cached: true };
      }
    }

    // Default headers
    const defaultHeaders = {
      'User-Agent': 'LillyBuilt-Agent/1.0 (Automated Research Tool)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive'
    };

    const fetchHeaders = { ...defaultHeaders, ...headers };

    // Execute with retries
    let lastError;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const startTime = Date.now();
        
        const response = await this.fetchWithTimeout(normalizedUrl, {
          method,
          headers: fetchHeaders,
          body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
          redirect: followRedirects ? 'follow' : 'manual'
        }, timeout);

        const duration = Date.now() - startTime;
        const responseBody = await response.text();

        // Track side effect
        tracker.recordNetworkCall(normalizedUrl, method, {
          status: response.status,
          contentType: response.headers.get('content-type')
        });

        const result = {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody,
          url: response.url,
          duration,
          cached: false
        };

        // Cache successful GET requests
        if (cache && method === 'GET' && response.ok) {
          this.setCache(cacheKey, result, cacheTtl);
        }

        return result;

      } catch (error) {
        lastError = this.formatFetchError(error, normalizedUrl, timeout);
        tracker.recordNetworkCall(normalizedUrl, method, {
          failed: true,
          error: lastError.message,
        });
        
        if (attempt < retries - 1) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error(`Failed to fetch ${url} after ${retries} attempts`);
  }

  parseInternalArtifactRequest(url) {
    try {
      const parsed = new URL(String(url || ''));
      const match = parsed.pathname.match(
        /^\/api\/artifacts\/([a-f0-9-]+)\/(download|preview|sandbox|preview-access|sandbox-access)(?:\/([^/]+))?(?:\/(.*))?$/i,
      );
      if (!match?.[1]) {
        return null;
      }

      const route = String(match[2] || '').toLowerCase();
      const requestedPath = ['preview-access', 'sandbox-access'].includes(route)
        ? String(match[4] || '')
        : String(match[3] || match[4] || '');

      return {
        artifactId: match[1],
        route,
        requestedPath,
      };
    } catch (_error) {
      return null;
    }
  }

  resolveInternalArtifactContent(artifact, request = {}) {
    if (!request || request.route === 'download') {
      return {
        contentBuffer: artifact.contentBuffer,
        mimeType: artifact.mimeType || 'application/octet-stream',
      };
    }

    const requestedPath = String(request.requestedPath || '').trim();
    const previewBasePath = `/api/artifacts/${encodeURIComponent(artifact.id)}/preview/`;
    const zipPreview = resolveArtifactFrontendBundleFile(artifact, requestedPath, {
      previewBasePath,
    });
    if (zipPreview) {
      return {
        contentBuffer: zipPreview.contentBuffer,
        mimeType: zipPreview.contentType,
      };
    }

    const bundleFile = getFrontendBundleFile(getArtifactFrontendBundle(artifact), requestedPath);
    if (bundleFile?.content != null) {
      const filePath = String(bundleFile.path || requestedPath || 'index.html');
      const contentType = resolveFrontendBundleContentType(filePath);
      const rawContent = Buffer.isBuffer(bundleFile.contentBuffer)
        ? bundleFile.contentBuffer.toString('utf8')
        : String(bundleFile.content || '');
      const content = /\.html?$/i.test(filePath)
        ? injectBundleBaseHref(rewriteRootRelativeFrontendPaths(rawContent, previewBasePath), previewBasePath)
        : rawContent;
      return {
        contentBuffer: Buffer.from(content, 'utf8'),
        mimeType: contentType,
      };
    }

    const previewHtml = String(artifact.previewHtml || '').trim();
    if (previewHtml) {
      return {
        contentBuffer: Buffer.from(previewHtml, 'utf8'),
        mimeType: 'text/html; charset=utf-8',
      };
    }

    return {
      contentBuffer: artifact.contentBuffer,
      mimeType: artifact.mimeType || 'application/octet-stream',
    };
  }

  serializeArtifactBody(contentBuffer, mimeType = '') {
    const buffer = Buffer.isBuffer(contentBuffer)
      ? contentBuffer
      : Buffer.from(contentBuffer || '');

    if (this.isTextLikeMimeType(mimeType)) {
      return buffer.toString('utf8');
    }

    return buffer.toString('base64');
  }

  isTextLikeMimeType(mimeType = '') {
    const normalized = String(mimeType || '').trim().toLowerCase();
    return normalized.startsWith('text/')
      || normalized.includes('json')
      || normalized.includes('xml')
      || normalized.includes('javascript')
      || normalized.includes('html')
      || normalized.includes('svg');
  }

  async fetchWithTimeout(url, options, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  normalizeUrl(url) {
    const value = String(url || '').trim();
    if (!value) {
      throw new Error('URL is required');
    }

    const internalResolved = this.resolveInternalUrl(value);
    if (internalResolved) {
      return internalResolved;
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

  resolveInternalUrl(value) {
    return resolveInternalUrl(value, this.getApiBaseUrl());
  }

  getApiBaseUrl() {
    return getApiBaseUrl();
  }

  formatFetchError(error, url, timeout) {
    if (error?.name === 'AbortError') {
      return new Error(`Request to ${url} timed out after ${timeout}ms`);
    }

    const causeCode = error?.cause?.code || error?.code || '';
    const causeMessage = error?.cause?.message || error?.message || 'Unknown network error';
    const detail = causeCode ? `${causeCode}: ${causeMessage}` : causeMessage;
    return new Error(`Network error fetching ${url}: ${detail}`);
  }

  getCacheKey(params) {
    return `${params.method}:${params.url}:${JSON.stringify(params.headers || {})}`;
  }

  getFromCache(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data;
  }

  setCache(key, data, ttlSeconds) {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + (ttlSeconds * 1000)
    });
    
    // Clean old cache entries periodically
    if (this.cache.size > 1000) {
      this.cleanCache();
    }
  }

  cleanCache() {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { WebFetchTool };
