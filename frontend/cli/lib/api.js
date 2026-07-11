const OpenAI = require('openai');
const { getApiBaseUrl, get } = require('./config');
const {
  buildGatewayHeaders,
  extractAssistantMetadata,
  extractAssistantText,
  extractStreamMetadata,
  resolvePreferredChatModel,
  splitSSEFrames,
  streamGatewayResponse,
  DEFAULT_CODEX_MODEL_ID,
} = require('../../shared/openai-sse');

// Default timeout for requests (60 seconds)
const DEFAULT_TIMEOUT = 60000;
const CLI_TASK_TYPE = 'chat';
const CLI_CLIENT_SURFACE = 'cli';
const CLI_REMOTE_BUILD_AUTONOMY_APPROVED = true;
const DEFAULT_CHAT_MODEL = DEFAULT_CODEX_MODEL_ID;
const PROVIDER_SESSION_MODE = 'interactive';

function stripGatewaySuffix(baseURL = '') {
  return String(baseURL || '').replace(/\/v1\/?$/i, '');
}

function ensureOpenAIBaseUrl(baseURL = '') {
  const trimmed = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return trimmed;
  }
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function parseProviderSessionFrame(frame = '') {
  const lines = String(frame || '').split('\n');
  let event = 'message';
  const dataLines = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '').trimEnd();
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || event;
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^\s/, ''));
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join('\n'),
  };
}

function normalizeArtifactMetadata(artifact = null) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return null;
  }

  const sizeValue = artifact.sizeBytes ?? artifact.size_bytes ?? artifact.size;
  const sizeBytes = Number(sizeValue);
  const normalized = {
    ...artifact,
    id: String(artifact.id || artifact.artifactId || artifact.artifact_id || '').trim(),
    filename: String(artifact.filename || artifact.name || '').trim(),
    format: String(artifact.format || artifact.extension || artifact.type || '').trim(),
    mimeType: String(artifact.mimeType || artifact.mime_type || '').trim(),
    downloadUrl: String(artifact.downloadUrl || artifact.download_url || '').trim(),
    previewUrl: String(artifact.previewUrl || artifact.preview_url || '').trim(),
    sandboxUrl: String(artifact.sandboxUrl || artifact.sandbox_url || '').trim(),
    bundleDownloadUrl: String(
      artifact.bundleDownloadUrl
      || artifact.bundle_download_url
      || artifact.bundle_download
      || ''
    ).trim(),
  };

  if (Number.isFinite(sizeBytes)) {
    normalized.sizeBytes = sizeBytes;
  }

  return normalized.id || normalized.downloadUrl ? normalized : null;
}

function normalizeArtifacts(artifacts = []) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .map(normalizeArtifactMetadata)
    .filter(Boolean);
}

/**
 * Custom API Error class with additional context.
 */
class APIError extends Error {
  constructor(message, statusCode = null, responseBody = null) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

/**
 * OpenAI Client wrapper for LillyBuilt backend.
 */
class OpenAIClient {
  constructor() {
    this.baseURL = ensureOpenAIBaseUrl(getApiBaseUrl());
    this.client = new OpenAI({
      baseURL: this.baseURL,
      apiKey: this.getFrontendApiKey() || 'any-key',
      timeout: DEFAULT_TIMEOUT,
    });
  }

  /**
   * Refresh the client with current config (in case URL changed).
   */
  refreshClient() {
    this.baseURL = ensureOpenAIBaseUrl(getApiBaseUrl());
    this.client = new OpenAI({
      baseURL: this.baseURL,
      apiKey: this.getFrontendApiKey() || 'any-key',
      timeout: DEFAULT_TIMEOUT,
    });
  }

  getGatewayBaseUrl() {
    return stripGatewaySuffix(this.baseURL);
  }

  getFrontendApiKey() {
    return String(
      process.env.KIMIBUILT_FRONTEND_API_KEY
      || process.env.FRONTEND_API_KEY
      || process.env.KIMIBUILT_GATEWAY_API_KEY
      || get('frontendApiKey', '')
      || ''
    ).trim();
  }

  buildFrontendAuthHeaders(headers = {}) {
    const authToken = this.getFrontendApiKey();
    if (!authToken) {
      throw new APIError(
        'Provider CLI access requires a frontend API key. Set KIMIBUILT_FRONTEND_API_KEY or FRONTEND_API_KEY before using /providers or /attach.',
      );
    }

    return buildGatewayHeaders(headers, { authToken });
  }

  buildApiHeaders(headers = {}) {
    const authToken = this.getFrontendApiKey();
    return buildGatewayHeaders(headers, authToken ? { authToken } : {});
  }

  async adminRequest(routePath, options = {}) {
    this.refreshClient();

    const method = options.method || 'GET';
    const headers = this.buildFrontendAuthHeaders({
      Accept: 'application/json',
      ...(options.headers || {}),
    });
    const requestInit = {
      method,
      headers,
      timeout: options.timeout || DEFAULT_TIMEOUT,
    };

    if (options.body !== undefined) {
      requestInit.body = JSON.stringify(options.body);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        requestInit.headers['Content-Type'] = 'application/json';
      }
    }

    try {
      const response = await fetch(`${this.getGatewayBaseUrl()}${routePath}`, requestInit);
      if (!response.ok) {
        const responseBody = await this._parseFetchResponseBody(response);
        const errorMessage = responseBody?.error?.message
          || responseBody?.message
          || `HTTP ${response.status}`;
        throw new APIError(errorMessage, response.status, responseBody);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return response.json();
      }

      const text = await response.text();
      return text ? { message: text } : {};
    } catch (err) {
      throw this._handleError(err);
    }
  }

  async apiRequest(routePath, options = {}) {
    this.refreshClient();

    const method = options.method || 'GET';
    const headers = this.buildApiHeaders({
      Accept: 'application/json',
      ...(options.headers || {}),
    });
    const requestInit = {
      method,
      headers,
      timeout: options.timeout || DEFAULT_TIMEOUT,
    };

    if (options.body !== undefined) {
      requestInit.body = JSON.stringify(options.body);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        requestInit.headers['Content-Type'] = 'application/json';
      }
    }

    try {
      const response = await fetch(`${this.getGatewayBaseUrl()}${routePath}`, requestInit);
      if (!response.ok) {
        const responseBody = await this._parseFetchResponseBody(response);
        const errorMessage = responseBody?.error?.message
          || responseBody?.message
          || `HTTP ${response.status}`;
        throw new APIError(errorMessage, response.status, responseBody);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return response.json();
      }

      const text = await response.text();
      return text ? { message: text } : {};
    } catch (err) {
      throw this._handleError(err);
    }
  }

  /**
   * Send a chat message with streaming support.
   * @param {string} message - Message to send
   * @param {string|null} sessionId - Optional session ID
   * @param {Function} onDelta - Callback for delta events
   * @param {Function} onDone - Callback for done event
   * @param {string|null} model - Optional model ID
   * @returns {Promise<Object>} Final response data
   */
  async chat(message, sessionId, onDelta, onDone, model = null, outputFormat = null, onReasoning = null, options = {}) {
    this.refreshClient();
    
    const messages = [{ role: 'user', content: message }];
    const selectedModel = resolvePreferredChatModel([], model || DEFAULT_CHAT_MODEL);
    const params = {
      model: selectedModel,
      messages,
      stream: true,
      enableConversationExecutor: true,
      taskType: CLI_TASK_TYPE,
      clientSurface: CLI_CLIENT_SURFACE,
      metadata: {
        remoteBuildAutonomyApproved: CLI_REMOTE_BUILD_AUTONOMY_APPROVED,
        clientSurface: CLI_CLIENT_SURFACE,
        enableConversationExecutor: true,
        ...(options.metadata && typeof options.metadata === 'object'
          ? options.metadata
          : {}),
      },
    };
    
    if (sessionId) {
      params.session_id = sessionId;
    }
    if (outputFormat) {
      params.output_format = outputFormat;
    }

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.buildApiHeaders({
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        }),
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const responseBody = await this._parseFetchResponseBody(response);
        const errorMessage = responseBody?.error?.message
          || responseBody?.message
          || `HTTP ${response.status}`;
        throw new APIError(errorMessage, response.status, responseBody);
      }

      const responseSessionId = response.headers.get('X-Session-Id');
      let finalSessionId = sessionId;
      let finalResponseId = null;
      let finalArtifacts = [];
      let finalToolEvents = [];
      let finalAssistantMetadata = null;

      if (responseSessionId) {
        finalSessionId = responseSessionId;
      }

      for await (const event of streamGatewayResponse(response)) {
        if (event.type === 'error') {
          const errorMessage = event.error?.message || event.error?.error?.message || 'Stream error';
          throw new APIError(errorMessage, 502, event.error);
        }

        if (event.sessionId) {
          finalSessionId = event.sessionId;
        }
        if (event.responseId) {
          finalResponseId = event.responseId;
        }
        if (Array.isArray(event.artifacts) && event.artifacts.length > 0) {
          finalArtifacts = event.artifacts;
        }
        if (Array.isArray(event.toolEvents) && event.toolEvents.length > 0) {
          finalToolEvents = event.toolEvents;
        }
        if (event.assistantMetadata && typeof event.assistantMetadata === 'object') {
          finalAssistantMetadata = {
            ...(finalAssistantMetadata || {}),
            ...event.assistantMetadata,
          };
        }

        if (event.type === 'text_delta' && event.content && onDelta) {
          onDelta(event.content);
        }

        if (event.type === 'reasoning_delta' && event.content && onReasoning) {
          onReasoning(event.content, {
            summary: event.summary || event.content,
          });
        }
      }
      
      if (onDone) {
        onDone({
          sessionId: finalSessionId,
          responseId: finalResponseId,
          artifacts: finalArtifacts,
          toolEvents: finalToolEvents,
          assistantMetadata: finalAssistantMetadata,
        });
      }
      
      return {
        sessionId: finalSessionId,
        responseId: finalResponseId,
        artifacts: finalArtifacts,
        toolEvents: finalToolEvents,
        assistantMetadata: finalAssistantMetadata,
      };
    } catch (err) {
      throw this._handleError(err);
    }
  }

  /**
   * Send a chat message without streaming.
   * @param {string} message - Message to send
   * @param {string|null} sessionId - Optional session ID
   * @param {string|null} model - Optional model ID
   * @returns {Promise<Object>} Response data
   */
  async chatNonStreaming(message, sessionId, model = null) {
    this.refreshClient();
    
    const messages = [{ role: 'user', content: message }];
    const selectedModel = resolvePreferredChatModel([], model || DEFAULT_CHAT_MODEL);
    const params = {
      model: selectedModel,
      messages,
      stream: false,
      enableConversationExecutor: true,
      taskType: CLI_TASK_TYPE,
      clientSurface: CLI_CLIENT_SURFACE,
      metadata: {
        remoteBuildAutonomyApproved: CLI_REMOTE_BUILD_AUTONOMY_APPROVED,
        clientSurface: CLI_CLIENT_SURFACE,
        enableConversationExecutor: true,
      },
    };
    
    if (sessionId) {
      params.session_id = sessionId;
    }

    try {
      const response = await this.client.chat.completions.create(params);
      
      const content = extractAssistantText(
        response?.choices?.[0]?.message?.content
        ?? response?.choices?.[0]?.message
        ?? response?.output_text
        ?? response
      );
      const metadata = extractStreamMetadata(response);
      const assistantMetadata = metadata.assistantMetadata
        || extractAssistantMetadata({
          assistantMetadata: response?.choices?.[0]?.message?.assistantMetadata,
          assistant_metadata: response?.choices?.[0]?.message?.assistant_metadata,
        });
      
      return {
        message: content,
        content,
        sessionId: metadata.sessionId || response.session_id || response.sessionId || sessionId,
        responseId: metadata.responseId || response.id,
        artifacts: metadata.artifacts,
        toolEvents: metadata.toolEvents,
        assistantMetadata,
      };
    } catch (err) {
      throw this._handleError(err);
    }
  }

  /**
   * Send a canvas mode request.
   * @param {string} message - Message to send
   * @param {string|null} sessionId - Optional session ID
   * @param {string} canvasType - Canvas type (code, document, diagram)
   * @param {string} existingContent - Existing content to modify
   * @param {string|null} model - Optional model ID
   * @returns {Promise<Object>} Response data
   */
  async canvas(message, sessionId, canvasType = 'document', existingContent = '', model = null) {
    this.refreshClient();

    const payload = {
      model: resolvePreferredChatModel([], model || DEFAULT_CHAT_MODEL),
      message,
      canvasType,
      existingContent,
      clientSurface: CLI_CLIENT_SURFACE,
      taskType: 'canvas',
      enableConversationExecutor: true,
      metadata: {
        clientSurface: CLI_CLIENT_SURFACE,
        enableConversationExecutor: true,
      },
    };
    
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    try {
      const response = await this.apiRequest('/api/canvas', {
        method: 'POST',
        body: payload,
        timeout: 120000,
      });
      
      return {
        content: response.content || response.message || response.result || '',
        canvasType: response.canvasType || response.type || canvasType,
        metadata: response.metadata || {},
        suggestions: Array.isArray(response.suggestions) ? response.suggestions : [],
        sessionId: response.sessionId || response.session_id || sessionId,
        assistantMetadata: response.assistantMetadata || response.assistant_metadata || null,
      };
    } catch (err) {
      throw this._handleError(err);
    }
  }

  /**
   * Send a notation mode request.
   * @param {string} notation - Notation to process
   * @param {string|null} sessionId - Optional session ID
   * @param {string} helperMode - Helper mode (expand, explain, validate)
   * @param {string} context - Additional context
   * @param {string|null} model - Optional model ID
   * @returns {Promise<Object>} Response data
   */
  async notation(notationText, sessionId, helperMode = 'expand', context = '', model = null) {
    this.refreshClient();

    const payload = {
      model: resolvePreferredChatModel([], model || DEFAULT_CHAT_MODEL),
      notation: notationText,
      helperMode,
      context,
      clientSurface: CLI_CLIENT_SURFACE,
      taskType: 'notation',
    };
    
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    try {
      const response = await this.apiRequest('/api/notation', {
        method: 'POST',
        body: payload,
      });

      return {
        result: response.result || response.content || '',
        helperMode: response.helperMode || helperMode,
        annotations: response.annotations || [],
        suggestions: response.suggestions || [],
        sessionId: response.sessionId || sessionId,
        assistantMetadata: response.assistantMetadata || response.assistant_metadata || null,
      };
    } catch (err) {
      throw this._handleError(err);
    }
  }

  /**
   * Create a new session using custom endpoint.
   * @param {Object} metadata - Session metadata
   * @returns {Promise<Object>} Session data
   */
  async createSession(metadata = {}) {
    // Sessions are managed via custom LillyBuilt endpoints
    // Fall back to HTTP request for session management
    return this._legacyRequest('/api/sessions', {
      method: 'POST',
      body: {
        taskType: CLI_TASK_TYPE,
        clientSurface: CLI_CLIENT_SURFACE,
        metadata: {
          ...metadata,
          taskType: CLI_TASK_TYPE,
          clientSurface: CLI_CLIENT_SURFACE,
        },
      },
    });
  }

  /**
   * List all sessions.
   * @returns {Promise<Object>} Sessions list
   */
  async listSessions() {
    const params = new URLSearchParams({
      taskType: CLI_TASK_TYPE,
      clientSurface: CLI_CLIENT_SURFACE,
    });
    return this._legacyRequest(`/api/sessions?${params.toString()}`, { method: 'GET' });
  }

  /**
   * Get a specific session by ID.
   * @param {string} sessionId - Session ID
   * @returns {Promise<Object>} Session data
   */
  async getSession(sessionId) {
    return this._legacyRequest(`/api/sessions/${sessionId}`, { method: 'GET' });
  }

  async listArtifacts(sessionId) {
    this.refreshClient();
    const response = await this._legacyRequest(`/api/sessions/${sessionId}/artifacts`, { method: 'GET' });
    return {
      ...(response && typeof response === 'object' && !Array.isArray(response) ? response : {}),
      artifacts: normalizeArtifacts(response?.artifacts),
    };
  }

  /**
   * Delete a session.
   * @param {string} sessionId - Session ID to delete
   * @returns {Promise<boolean>} Success status
   */
  async deleteSession(sessionId) {
    try {
      await this._legacyRequest(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the API is accessible.
   * @returns {Promise<boolean>} True if API is reachable
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.buildApiHeaders({
          'Accept': 'application/json',
        }),
      });
      if (!response.ok) {
        return false;
      }
      await response.json();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get available chat models from the API.
   * @returns {Promise<Array>} Array of model objects
   */
  async getModels() {
    try {
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.buildApiHeaders({
          'Accept': 'application/json',
        }),
      });

      if (!response.ok) {
        const responseBody = await this._parseFetchResponseBody(response);
        const errorMessage = responseBody?.error?.message
          || responseBody?.message
          || `HTTP ${response.status}`;
        throw new APIError(errorMessage, response.status, responseBody);
      }

      const data = await response.json();
      return Array.isArray(data?.data) ? data.data : [];
    } catch (err) {
      throw this._handleError(err);
    }
  }

  /**
   * Get available image generation models from the API.
   * @returns {Promise<Array>} Array of image model objects
   */
  async getImageModels() {
    try {
      this.refreshClient();
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.buildApiHeaders({
          'Accept': 'application/json',
        }),
      });

      if (!response.ok) {
        const responseBody = await this._parseFetchResponseBody(response);
        const errorMessage = responseBody?.error?.message
          || responseBody?.message
          || `HTTP ${response.status}`;
        throw new APIError(errorMessage, response.status, responseBody);
      }

      const data = await response.json();
      const imageModels = (Array.isArray(data.data) ? data.data : [])
        .filter((model) => this._modelHasCapability(model, 'image_generation'))
        .map((model) => this._normalizeImageModelRecord(model))
        .filter((model) => model.id);

      if (imageModels.length > 0) {
        return imageModels;
      }

      const legacyResponse = await this._legacyRequest('/api/images/models', { method: 'GET', timeout: 10000 });
      return legacyResponse.models || [];
    } catch (err) {
      throw new APIError(`Failed to fetch image models: ${err.message}`, err.statusCode);
    }
  }

  _normalizeImageModelRecord(model = {}) {
    const id = String(model?.id || '').trim();
    const metadata = model?.metadata && typeof model.metadata === 'object' ? model.metadata : {};
    const lower = id.toLowerCase();

    return {
      ...metadata,
      id,
      name: metadata.name || id,
      owned_by: model.owned_by || metadata.owned_by || 'openai',
      sizes: Array.isArray(metadata.sizes) && metadata.sizes.length > 0
        ? metadata.sizes
        : (lower.includes('gpt-image')
          ? ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152']
          : ['1024x1024']),
      qualities: Array.isArray(metadata.qualities) && metadata.qualities.length > 0
        ? metadata.qualities
        : (lower.includes('gpt-image') ? ['auto', 'low', 'medium', 'high'] : []),
      styles: Array.isArray(metadata.styles) ? metadata.styles : [],
      maxImages: metadata.maxImages || (lower.includes('gpt-image') ? 10 : 5),
    };
  }

  _collectModelCapabilities(model = {}) {
    const capabilities = new Set();
    const addValue = (value) => {
      if (Array.isArray(value)) {
        value.forEach(addValue);
        return;
      }
      if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, entry]) => {
          if (entry === true || entry === 'true' || entry === 'available' || entry === 'supported') {
            capabilities.add(String(key).trim().toLowerCase());
          } else if (entry && typeof entry === 'object' && !Array.isArray(entry)
            && (entry.supported === true || entry.supported === 'true' || entry.available === true || entry.available === 'true')) {
            capabilities.add(String(key).trim().toLowerCase());
          } else if (Array.isArray(entry) || (entry && typeof entry === 'object')) {
            addValue(entry);
          }
        });
        return;
      }

      const normalized = String(value || '').trim().toLowerCase();
      if (normalized) {
        capabilities.add(normalized);
      }
    };

    const metadata = model?.metadata && typeof model.metadata === 'object' ? model.metadata : {};
    const contract = model?.contract && typeof model.contract === 'object' ? model.contract : {};
    addValue(model?.capabilities);
    addValue(metadata.capabilities);
    addValue(metadata.capabilityMap || metadata.capability_map);
    addValue(contract.capabilities);
    addValue(contract.capabilityMap || contract.capability_map);
    return capabilities;
  }

  _modelHasCapability(model = {}, capability = '') {
    return this._collectModelCapabilities(model).has(String(capability || '').trim().toLowerCase());
  }

  /**
   * Generate an image using the API.
   * @param {string} prompt - Image generation prompt
   * @param {Object} options - Generation options
   * @returns {Promise<Object>} Response data with image URLs
   */
  async generateImage(prompt, options = {}) {
    const {
      model = 'gpt-image-2',
      size,
      quality,
      style,
      n,
      response_format,
      output_format,
      output_compression,
      moderation,
      background,
      sessionId,
    } = options;
    
    const params = {
      prompt,
      model: model || 'gpt-image-2',
      size: size || 'auto',
      taskType: 'image',
      clientSurface: CLI_CLIENT_SURFACE,
    };
    
    if (n) params.n = n;
    if (quality) params.quality = quality;
    if (style) params.style = style;
    if (background) params.background = background;
    if (response_format) params.response_format = response_format;
    if (output_format) params.output_format = output_format;
    if (Number.isFinite(Number(output_compression))) params.output_compression = Number(output_compression);
    if (moderation) params.moderation = moderation;
    if (sessionId) params.session_id = sessionId;

    try {
      this.refreshClient();
      const response = await fetch(`${this.baseURL}/images/generations`, {
        method: 'POST',
        headers: this.buildApiHeaders({
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const responseBody = await this._parseFetchResponseBody(response);
        const errorMessage = responseBody?.error?.message
          || responseBody?.message
          || `HTTP ${response.status}`;
        throw new APIError(errorMessage, response.status, responseBody);
      }

      const data = await response.json();
      
      return {
        data: data.data || [],
        artifacts: Array.isArray(data.artifacts) ? data.artifacts : [],
        diagnostics: data.diagnostics || null,
        model: data.model || model || null,
        size: data.size || params.size,
        quality: data.quality || quality || null,
        style: data.style || style || null,
        sessionId: data.sessionId || data.session_id || sessionId,
      };
    } catch (err) {
      throw this._handleError(err);
    }
  }

  async getProviderCapabilities() {
    const response = await this.adminRequest('/admin/provider-capabilities', {
      method: 'GET',
      timeout: 15000,
    });
    return Array.isArray(response?.data) ? response.data : [];
  }

  async getAvailableTools(options = {}) {
    const params = new URLSearchParams();
    if (options.category) {
      params.set('category', options.category);
    }
    if (options.sessionId) {
      params.set('sessionId', options.sessionId);
    }
    if (options.taskType) {
      params.set('taskType', options.taskType);
    }
    if (options.clientSurface) {
      params.set('clientSurface', options.clientSurface);
    }
    if (options.executionProfile) {
      params.set('executionProfile', options.executionProfile);
    }
    if (options.includeAll) {
      params.set('includeAll', 'true');
    }

    const query = params.toString();
    return this.apiRequest(`/api/tools/available${query ? `?${query}` : ''}`, {
      method: 'GET',
      timeout: options.timeout || 10000,
    });
  }

  async listSkills(options = {}) {
    const params = new URLSearchParams();
    if (options.search) {
      params.set('search', options.search);
    }
    if (options.includeBody) {
      params.set('includeBody', 'true');
    }
    if (options.includeDisabled) {
      params.set('includeDisabled', 'true');
    }

    const query = params.toString();
    return this.apiRequest(`/api/skills${query ? `?${query}` : ''}`, {
      method: 'GET',
      timeout: options.timeout || 10000,
    });
  }

  async getSkill(skillId, options = {}) {
    const params = new URLSearchParams();
    if (options.includeBody !== false) {
      params.set('includeBody', 'true');
    }
    const query = params.toString();
    return this.apiRequest(`/api/skills/${encodeURIComponent(skillId)}${query ? `?${query}` : ''}`, {
      method: 'GET',
      timeout: options.timeout || 10000,
    });
  }

  async createSkill(payload = {}) {
    return this.apiRequest('/api/skills', {
      method: 'POST',
      timeout: 10000,
      body: payload,
    });
  }

  async updateSkill(skillId, payload = {}) {
    return this.apiRequest(`/api/skills/${encodeURIComponent(skillId)}`, {
      method: 'PUT',
      timeout: 10000,
      body: payload,
    });
  }

  async getToolDetails(toolId, options = {}) {
    return this.apiRequest(`/api/tools/${encodeURIComponent(toolId)}`, {
      method: 'GET',
      timeout: options.timeout || 10000,
    });
  }

  async invokeTool(toolId, params = {}, options = {}) {
    return this.apiRequest('/api/tools/invoke', {
      method: 'POST',
      timeout: options.timeout || params.timeout || DEFAULT_TIMEOUT,
      body: {
        tool: toolId,
        params,
        sessionId: options.sessionId || null,
        taskType: options.taskType || CLI_TASK_TYPE,
        clientSurface: options.clientSurface || CLI_CLIENT_SURFACE,
        executionProfile: options.executionProfile || options.clientSurface || 'tool-invoke',
        model: options.model || null,
        metadata: {
          ...(options.metadata || {}),
          clientSurface: options.clientSurface || CLI_CLIENT_SURFACE,
          requestedModel: options.model || null,
        },
      },
    });
  }

  async runRemoteCommand(command, options = {}) {
    return this.invokeTool('remote-command', {
      command,
      profile: options.profile || 'inspect',
      workflowAction: options.workflowAction || 'cli-workbench-command',
      timeout: options.timeout || 120000,
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.approval ? { approval: options.approval } : {}),
    }, {
      sessionId: options.sessionId,
      taskType: options.taskType || CLI_TASK_TYPE,
      clientSurface: options.clientSurface || CLI_CLIENT_SURFACE,
      executionProfile: options.executionProfile || 'remote-build',
      model: options.model,
      timeout: options.timeout || 120000,
      metadata: options.metadata,
    });
  }

  async runRemoteCliAgent(task, options = {}) {
    return this.invokeTool('remote-cli-agent', {
      task,
      waitMs: options.waitMs || 30000,
      maxTurns: options.maxTurns || 30,
      ...(options.cwd || options.workingDirectory ? { cwd: options.cwd || options.workingDirectory } : {}),
        ...(options.targetId ? { targetId: options.targetId } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.mcpSessionId ? { mcpSessionId: options.mcpSessionId } : {}),
        ...(options.adminMode !== undefined ? { adminMode: options.adminMode === true } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.instructions ? { instructions: options.instructions } : {}),
      }, {
      sessionId: options.backendSessionId,
      taskType: options.taskType || CLI_TASK_TYPE,
      clientSurface: options.clientSurface || CLI_CLIENT_SURFACE,
      executionProfile: options.executionProfile || 'remote-build',
      model: options.model,
      timeout: options.timeout || 900000,
      metadata: {
        remoteBuildAutonomyApproved: true,
        remoteCommandSource: options.clientSurface || CLI_CLIENT_SURFACE,
        ...(options.metadata || {}),
      },
    });
  }

  async runK3sDeploy(params = {}, options = {}) {
    return this.invokeTool('k3s-deploy', params, {
      sessionId: options.sessionId,
      taskType: options.taskType || CLI_TASK_TYPE,
      clientSurface: options.clientSurface || CLI_CLIENT_SURFACE,
      executionProfile: options.executionProfile || 'remote-build',
      model: options.model,
      timeout: options.timeout || params.timeout || 180000,
      metadata: options.metadata,
    });
  }

  async createProviderSession(options = {}) {
    const body = {
      providerId: options.providerId,
      mode: options.mode || PROVIDER_SESSION_MODE,
      cols: options.cols,
      rows: options.rows,
    };

    if (options.cwd) {
      body.cwd = options.cwd;
    }

    if (options.model) {
      body.model = options.model;
    }

    return this.adminRequest('/admin/provider-sessions', {
      method: 'POST',
      body,
      timeout: 30000,
    });
  }

  async sendProviderSessionInput(sessionId, data) {
    return this.adminRequest(`/admin/provider-sessions/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      body: { data },
      timeout: 15000,
    });
  }

  async sendProviderSessionSignal(sessionId, signalName = 'SIGINT') {
    return this.adminRequest(`/admin/provider-sessions/${encodeURIComponent(sessionId)}/signal`, {
      method: 'POST',
      body: { signal: signalName },
      timeout: 15000,
    });
  }

  async deleteProviderSession(sessionId) {
    return this.adminRequest(`/admin/provider-sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      timeout: 15000,
    });
  }

  async resizeProviderSession(sessionId, cols, rows) {
    return this.adminRequest(`/admin/provider-sessions/${encodeURIComponent(sessionId)}/resize`, {
      method: 'POST',
      body: { cols, rows },
      timeout: 15000,
    });
  }

  async *streamProviderSession(streamUrl, options = {}) {
    this.refreshClient();

    const streamBase = `${this.getGatewayBaseUrl().replace(/\/$/, '')}/`;
    const targetUrl = new URL(String(streamUrl || ''), streamBase);
    if (options.after !== undefined && options.after !== null) {
      targetUrl.searchParams.set('after', String(options.after));
    }

    const response = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: this.buildFrontendAuthHeaders({
        Accept: 'text/event-stream',
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const responseBody = await this._parseFetchResponseBody(response);
      const errorMessage = responseBody?.error?.message
        || responseBody?.message
        || `HTTP ${response.status}`;
      throw new APIError(errorMessage, response.status, responseBody);
    }

    const reader = response?.body?.getReader?.();
    if (!reader) {
      throw new APIError('Provider stream body is unavailable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const split = splitSSEFrames(buffer);
        buffer = split.remainder;

        for (const frame of split.frames) {
          const parsedFrame = parseProviderSessionFrame(frame);
          if (!parsedFrame) {
            continue;
          }

          let payload;
          try {
            payload = JSON.parse(parsedFrame.data);
          } catch {
            payload = { raw: parsedFrame.data };
          }

          yield {
            type: parsedFrame.event,
            ...payload,
          };
        }
      }

      buffer += decoder.decode();
      const trailingFrame = parseProviderSessionFrame(buffer);
      if (trailingFrame) {
        let payload;
        try {
          payload = JSON.parse(trailingFrame.data);
        } catch {
          payload = { raw: trailingFrame.data };
        }

        yield {
          type: trailingFrame.event,
          ...payload,
        };
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Handle errors from OpenAI SDK.
   * @private
   */
  _handleError(err) {
    if (err.status) {
      const statusCode = err.status;
      let message = err.message || 'Unknown error';
      
      if (statusCode === 404) {
        message = 'API endpoint not found. Please check that the server is running and the API URL is correct.';
      } else if (statusCode === 401) {
        message = 'Authentication failed. Please check your API credentials.';
      } else if (statusCode === 429) {
        message = 'Rate limit exceeded. Please wait a moment before trying again.';
      } else if (statusCode >= 500) {
        message = 'Server error. The AI backend may be experiencing issues. Please try again later.';
      }
      
      return new APIError(message, statusCode, err.error);
    }
    
    if (err.code === 'ECONNREFUSED') {
      return new APIError(`Connection refused. Please ensure the LillyBuilt server is running at ${this.baseURL}`);
    }
    
    if (err.code === 'ENOTFOUND') {
      return new APIError(`Host not found. Please check your API URL configuration: ${this.baseURL}`);
    }
    
    if (err.code === 'ETIMEDOUT') {
      return new APIError('Connection timed out. The server may be slow or unreachable.');
    }
    
    return new APIError(err.message || 'Request failed');
  }

  /**
   * Legacy HTTP request for non-OpenAI endpoints.
   * @private
   */
  async _legacyRequest(path, options = {}) {
    const http = require('http');
    const https = require('https');
    
    return new Promise((resolve, reject) => {
      const baseUrlStr = this.getGatewayBaseUrl();
      let baseUrl;
      
      try {
        baseUrl = new URL(baseUrlStr);
      } catch (err) {
        reject(new APIError(`Invalid API URL: ${baseUrlStr}`));
        return;
      }
      
      const method = options.method || 'GET';
      const postData = options.body ? JSON.stringify(options.body) : null;
      const timeout = options.timeout || DEFAULT_TIMEOUT;
      const authToken = this.getFrontendApiKey();
      
      const requestOptions = {
        hostname: baseUrl.hostname,
        port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
        path: path,
        method: method,
        timeout: timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'LillyBuilt-CLI/2.2.0',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          ...(postData && { 'Content-Length': Buffer.byteLength(postData) }),
        },
      };
      
      const httpModule = baseUrlStr.startsWith('https:') ? https : http;
      
      const req = httpModule.request(requestOptions, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const parsed = data ? JSON.parse(data) : {};
              resolve(parsed);
            } else {
              reject(new APIError(`HTTP ${res.statusCode}: ${data}`, res.statusCode));
            }
          } catch (err) {
            reject(new APIError(`Failed to parse response: ${err.message}`));
          }
        });
      });
      
      req.on('error', (err) => {
        reject(new APIError(`Request failed: ${err.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new APIError('Request timed out'));
      });
      
      if (postData) {
        req.write(postData);
      }
      
      req.end();
    });
  }

  async _parseFetchResponseBody(response) {
    if (!response) {
      return null;
    }

    try {
      const contentType = response.headers?.get?.('content-type') || '';
      if (contentType.includes('application/json')) {
        return await response.json();
      }

      const text = await response.text();
      return text ? { message: text } : null;
    } catch {
      return null;
    }
  }
}

// Create singleton instance
const client = new OpenAIClient();

function uploadArtifact(filePath, sessionId, mode = 'chat') {
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const https = require('https');

  return new Promise((resolve, reject) => {
    const fileBuffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const boundary = `----LillyBuilt${Date.now().toString(16)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\n${sessionId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${mode}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fileBuffer, tail]);

    const baseUrlStr = client.baseURL.replace('/v1', '');
    const baseUrl = new URL(baseUrlStr);
    const httpModule = baseUrlStr.startsWith('https:') ? https : http;
    const authToken = client.getFrontendApiKey();

    const req = httpModule.request({
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      path: '/api/artifacts/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Accept': 'application/json',
        'User-Agent': 'LillyBuilt-CLI/2.2.0',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text ? JSON.parse(text) : {});
        } else {
          reject(new APIError(`HTTP ${res.statusCode}: ${text}`, res.statusCode));
        }
      });
    });

    req.on('error', (err) => reject(new APIError(`Request failed: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

function listArtifacts(sessionId) {
  return client.listArtifacts(sessionId);
}

function generateArtifact(options) {
  return client._legacyRequest('/api/artifacts/generate', { method: 'POST', body: options });
}

function downloadArtifact(artifactId, outputPath) {
  const fs = require('fs');
  const http = require('http');
  const https = require('https');

  return new Promise((resolve, reject) => {
    const baseUrlStr = client.baseURL.replace('/v1', '');
    const baseUrl = new URL(baseUrlStr);
    const httpModule = baseUrlStr.startsWith('https:') ? https : http;
    const authToken = client.getFrontendApiKey();

    const req = httpModule.request({
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      path: `/api/artifacts/${artifactId}/download`,
      method: 'GET',
      headers: {
        'User-Agent': 'LillyBuilt-CLI/2.2.0',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => reject(new APIError(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`, res.statusCode)));
        return;
      }

      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
      file.on('error', (err) => reject(new APIError(`Write failed: ${err.message}`)));
    });

    req.on('error', (err) => reject(new APIError(`Request failed: ${err.message}`)));
    req.end();
  });
}

function downloadImage(imageUrl, outputPath) {
  const fs = require('fs');
  const http = require('http');
  const https = require('https');

  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = new URL(imageUrl);
    } catch {
      reject(new APIError(`Invalid image URL: ${imageUrl}`));
      return;
    }

    const httpModule = targetUrl.protocol === 'https:' ? https : http;
    const req = httpModule.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'GET',
      headers: {
        'User-Agent': 'LillyBuilt-CLI/2.2.0',
        Referer: 'https://unsplash.com/',
      },
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => reject(new APIError(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`, res.statusCode)));
        return;
      }

      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
      file.on('error', (err) => reject(new APIError(`Write failed: ${err.message}`)));
    });

    req.on('error', (err) => reject(new APIError(`Request failed: ${err.message}`)));
    req.end();
  });
}

// Export functions that use the OpenAI client
module.exports = {
  APIError,
  request: (path, options) => client._legacyRequest(path, options),
  apiRequest: (path, options) => client.apiRequest(path, options),
  chat: (message, sessionId, onDelta, onDone, model, outputFormat, onReasoning, options) => client.chat(message, sessionId, onDelta, onDone, model, outputFormat, onReasoning, options),
  chatNonStreaming: (message, sessionId, model) => client.chatNonStreaming(message, sessionId, model),
  canvas: (message, sessionId, canvasType, existingContent, model) => 
    client.canvas(message, sessionId, canvasType, existingContent, model),
  notation: (notationText, sessionId, helperMode, context, model) => 
    client.notation(notationText, sessionId, helperMode, context, model),
  createSession: (metadata) => client.createSession(metadata),
  listSessions: () => client.listSessions(),
  getSession: (sessionId) => client.getSession(sessionId),
  deleteSession: (sessionId) => client.deleteSession(sessionId),
  healthCheck: () => client.healthCheck(),
  getModels: () => client.getModels(),
  getImageModels: () => client.getImageModels(),
  generateImage: (prompt, options) => client.generateImage(prompt, options),
  getAvailableTools: (options) => client.getAvailableTools(options),
  listSkills: (options) => client.listSkills(options),
  getSkill: (skillId, options) => client.getSkill(skillId, options),
  createSkill: (payload) => client.createSkill(payload),
  updateSkill: (skillId, payload) => client.updateSkill(skillId, payload),
  getToolDetails: (toolId, options) => client.getToolDetails(toolId, options),
  invokeTool: (toolId, params, options) => client.invokeTool(toolId, params, options),
  runRemoteCommand: (command, options) => client.runRemoteCommand(command, options),
  runRemoteCliAgent: (task, options) => client.runRemoteCliAgent(task, options),
  runK3sDeploy: (params, options) => client.runK3sDeploy(params, options),
  uploadArtifact,
  listArtifacts,
  generateArtifact,
  downloadArtifact,
  downloadImage,
  createProviderSession: (options) => client.createProviderSession(options),
  deleteProviderSession: (sessionId) => client.deleteProviderSession(sessionId),
  getProviderCapabilities: () => client.getProviderCapabilities(),
  parseSSE: (chunk) => [], // Deprecated: OpenAI SDK handles streaming internally
  resizeProviderSession: (sessionId, cols, rows) => client.resizeProviderSession(sessionId, cols, rows),
  sendProviderSessionInput: (sessionId, data) => client.sendProviderSessionInput(sessionId, data),
  sendProviderSessionSignal: (sessionId, signalName) => client.sendProviderSessionSignal(sessionId, signalName),
  streamProviderSession: (streamUrl, options) => client.streamProviderSession(streamUrl, options),
  OpenAIClient,
};





