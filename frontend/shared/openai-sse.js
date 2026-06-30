(function attachGatewayStreamHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.KimiBuiltGatewaySSE = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildGatewayStreamHelpers() {
  'use strict';

  const DEFAULT_GATEWAY_AUTH_TOKEN = 'any-key';
  const DEFAULT_CODEX_MODEL_IDS = [
    'auto',
    'gpt-5.4-mini',
    'gpt-5.4',
    'gpt-5.3-instant',
    'gpt-5.3',
    'gpt-5-codex',
    'codex-mini-latest',
  ];
  const DEFAULT_CODEX_MODEL_ID = DEFAULT_CODEX_MODEL_IDS[0];
  const TERMINAL_FINISH_REASONS = new Set(['stop', 'length', 'content_filter']);

  function stripNullCharacters(value = '') {
    return String(value || '').replace(/\u0000/g, '');
  }

  function extractStreamText(value = null) {
    if (typeof value === 'string') {
      return stripNullCharacters(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => extractStreamText(entry)).join('');
    }
    return extractAssistantText(value);
  }

  function extractDisplayText(value = null) {
    if (typeof value === 'string') {
      return stripNullCharacters(value).replace(/\s+/g, ' ').trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value
        .map((entry) => extractDisplayText(entry))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (!value || typeof value !== 'object') {
      return '';
    }

    const assistantText = extractAssistantText(value);
    if (assistantText) {
      return assistantText.replace(/\s+/g, ' ').trim();
    }

    for (const key of ['summary', 'detail', 'message', 'text', 'content', 'title', 'label', 'reason', 'description']) {
      const extracted = extractDisplayText(value[key]);
      if (extracted) {
        return extracted;
      }
    }

    try {
      const serialized = JSON.stringify(value);
      return serialized && serialized !== '{}' ? serialized : '';
    } catch (_error) {
      return '';
    }
  }

  function normalizeModelId(modelOrId = '') {
    if (modelOrId && typeof modelOrId === 'object') {
      return String(modelOrId.id || '').trim();
    }

    return String(modelOrId || '').trim();
  }

  function isCodexBackedModel(modelOrId = '') {
    const normalizedId = normalizeModelId(modelOrId).toLowerCase();
    if (!normalizedId) {
      return false;
    }

    return normalizedId.includes('codex') || normalizedId.includes('gpt-5');
  }

  function getModelCapabilities(model = {}) {
    return [
      ...parseModelCapabilityEntries(model?.capabilities),
      ...parseModelCapabilityEntries(model?.supports),
      ...parseModelCapabilityEntries(model?.metadata?.capabilities),
      ...parseModelCapabilityEntries(model?.metadata?.supports),
      ...parseModelCapabilityEntries(model?.contract?.capabilities),
      ...parseModelCapabilityEntries(model?.contract?.supports),
    ]
      .map((capability) => String(capability || '').trim().toLowerCase())
      .filter(Boolean);
  }

  function parseModelCapabilityEntries(value = null) {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => parseModelCapabilityEntries(entry));
    }

    if (typeof value === 'string') {
      return value.split(/[,\s;|]+/).map((entry) => entry.trim()).filter(Boolean);
    }

    if (value && typeof value === 'object') {
      return Object.entries(value)
        .filter(([, enabled]) => isModelCapabilityEnabled(enabled))
        .map(([capability]) => capability);
    }

    return [];
  }

  function isModelCapabilityEnabled(value) {
    if (value === true || value === 1) {
      return true;
    }
    if (typeof value === 'string') {
      return /^(true|yes|supported|enabled|available|1)$/i.test(value.trim());
    }
    if (value && typeof value === 'object') {
      return isModelCapabilityEnabled(value.enabled)
        || isModelCapabilityEnabled(value.supported)
        || isModelCapabilityEnabled(value.available);
    }
    return false;
  }

  function hasExplicitNonChatCapability(capabilities = []) {
    const nonChatCapabilities = new Set([
      'image',
      'image_generation',
      'image-generation',
      'images',
      'embedding',
      'embeddings',
      'text-embedding',
      'tts',
      'speech',
      'audio',
      'transcription',
      'transcribe',
      'moderation',
      'realtime',
    ]);

    return capabilities.some((capability) => nonChatCapabilities.has(capability));
  }

  function isChatModel(modelOrId = '') {
    const normalizedId = normalizeModelId(modelOrId).toLowerCase();
    if (!normalizedId) {
      return false;
    }
    if (normalizedId === DEFAULT_CODEX_MODEL_ID) {
      return true;
    }

    const capabilities = modelOrId && typeof modelOrId === 'object'
      ? getModelCapabilities(modelOrId)
      : [];
    if (capabilities.includes('chat')) {
      return true;
    }
    if (hasExplicitNonChatCapability(capabilities)) {
      return false;
    }

    return ![
      'embed',
      'embedding',
      'gpt-image',
      'image-gen',
      'image_generation',
      'image-generation',
      'image-edit',
      'image_edit',
      'image-model',
      'image_model',
      'image-router',
      'image_router',
      'image-generator',
      'image_generator',
      'text-to-image',
      'dall-e',
      'dalle',
      'imagen',
      'flux',
      'diffusion',
      'tts',
      'speech',
      'audio',
      'transcribe',
      'whisper',
      'realtime',
      'moderation',
    ].some((token) => normalizedId.includes(token));
  }

  function filterChatModels(models = []) {
    const seen = new Set();

    return (Array.isArray(models) ? models : []).filter((model) => {
      const id = normalizeModelId(model);
      if (!id || seen.has(id) || !isChatModel(model)) {
        return false;
      }

      seen.add(id);
      return true;
    });
  }

  function filterCodexBackedModels(models = []) {
    const seen = new Set();

    return filterChatModels(models).filter((model) => {
      const id = normalizeModelId(model);
      if (!id || seen.has(id) || !isCodexBackedModel(id)) {
        return false;
      }

      seen.add(id);
      return true;
    });
  }

  function selectPreferredCodexModel(models = [], preferredModel = '') {
    const codexModels = filterCodexBackedModels(models);
    const availableIds = new Set(codexModels.map((model) => normalizeModelId(model)));
    const preferredId = normalizeModelId(preferredModel);

    if (preferredId && availableIds.has(preferredId)) {
      return preferredId;
    }

    for (const candidate of DEFAULT_CODEX_MODEL_IDS) {
      if (availableIds.has(candidate)) {
        return candidate;
      }
    }

    if (codexModels.length > 0) {
      return normalizeModelId(codexModels[0]);
    }

    if (preferredId && isCodexBackedModel(preferredId)) {
      return preferredId;
    }

    return DEFAULT_CODEX_MODEL_ID;
  }

  function resolvePreferredChatModel(models = [], preferredModel = '', fallbackModel = DEFAULT_CODEX_MODEL_ID) {
    const availableModels = filterChatModels(models);
    const availableIds = new Set(
      availableModels
        .map((model) => normalizeModelId(model))
        .filter(Boolean),
    );
    const preferredId = normalizeModelId(preferredModel);
    const fallbackId = normalizeModelId(fallbackModel) || DEFAULT_CODEX_MODEL_ID;

    if (preferredId === DEFAULT_CODEX_MODEL_ID) {
      return DEFAULT_CODEX_MODEL_ID;
    }

    if (preferredId && isChatModel(preferredId) && (availableIds.size === 0 || availableIds.has(preferredId))) {
      return preferredId;
    }

    if (fallbackId === DEFAULT_CODEX_MODEL_ID) {
      return DEFAULT_CODEX_MODEL_ID;
    }

    if (fallbackId && availableIds.has(fallbackId)) {
      return fallbackId;
    }

    if (availableModels.length > 0) {
      return normalizeModelId(availableModels[0]);
    }

    return fallbackId;
  }

  function buildGatewayHeaders(headers = {}, options = {}) {
    const normalizedHeaders = {
      ...(headers && typeof headers === 'object' ? headers : {}),
    };
    const authToken = String(options.authToken || DEFAULT_GATEWAY_AUTH_TOKEN).trim() || DEFAULT_GATEWAY_AUTH_TOKEN;

    if (!Object.keys(normalizedHeaders).some((key) => key.toLowerCase() === 'authorization')) {
      normalizedHeaders.Authorization = `Bearer ${authToken}`;
    }

    return normalizedHeaders;
  }

  function buildGatewayRealtimeUrl(baseUrl = '', pathname = '/ws') {
    const normalizedPath = `/${String(pathname || '/ws').replace(/^\/+/, '')}`;

    try {
      const parsedBaseUrl = new URL(String(baseUrl || '').trim());
      parsedBaseUrl.protocol = parsedBaseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      parsedBaseUrl.pathname = normalizedPath;
      parsedBaseUrl.search = '';
      parsedBaseUrl.hash = '';
      return parsedBaseUrl.toString();
    } catch (_error) {
      return normalizedPath;
    }
  }

  function splitSSEFrames(buffer = '') {
    const normalizedBuffer = String(buffer || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const frames = normalizedBuffer.split('\n\n');

    return {
      frames: frames.slice(0, -1),
      remainder: frames.length > 0 ? frames[frames.length - 1] : '',
    };
  }

  function extractSSEData(frame = '') {
    const dataLines = String(frame || '')
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^\s/, ''));

    return dataLines.join('\n').trim();
  }

  function extractSSEComment(frame = '') {
    const commentLines = String(frame || '')
      .split('\n')
      .filter((line) => line.startsWith(':'))
      .map((line) => line.slice(1).trim())
      .filter(Boolean);

    return commentLines.join('\n').trim();
  }

  function isTerminalFinishReason(finishReason = '') {
    return TERMINAL_FINISH_REASONS.has(String(finishReason || '').trim().toLowerCase());
  }

  function isFunctionCallItem(item = {}) {
    const itemType = String(item?.type || '').trim();
    return itemType === 'function_call' || itemType === 'custom_tool_call';
  }

  function isReasoningLikeBlock(value = {}) {
    const blockType = String(value?.type || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
    return new Set([
      'analysis',
      'analysis_delta',
      'reasoning',
      'reasoning_delta',
      'reasoning_summary',
      'reasoning_summary_text',
      'reasoning_text',
      'redacted_thinking',
      'thinking',
      'thinking_delta',
      'thinking_summary',
      'thought',
      'thought_delta',
    ]).has(blockType);
  }

  function extractAssistantText(value) {
    if (typeof value === 'string') {
      const trimmed = stripNullCharacters(value).trim();
      if (!trimmed) {
        return '';
      }

      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(trimmed);
          const extracted = extractAssistantText(parsed);
          if (extracted) {
            return extracted;
          }
        } catch (_error) {
          // Fall back to the raw string when it is not valid JSON.
        }
      }

      return trimmed;
    }

    if (Array.isArray(value)) {
      return value
        .map((entry) => extractAssistantText(entry))
        .filter(Boolean)
        .join('');
    }

    if (!value || typeof value !== 'object') {
      return '';
    }

    if (isReasoningLikeBlock(value)) {
      return '';
    }

    const functionPayloadSources = [
      value.parameters,
      value.arguments,
      value.function?.arguments,
      value.function?.parameters,
    ];
    for (const source of functionPayloadSources) {
      const parsed = typeof source === 'string'
        ? (() => {
          try {
            return JSON.parse(stripNullCharacters(source));
          } catch (_error) {
            return null;
          }
        })()
        : source;
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }

      const functionText = [
        parsed.notes_page_update,
        parsed.assistant_reply,
        parsed.assistantReply,
        parsed.message,
        parsed.content,
        parsed.text,
        parsed.result,
        parsed.response,
        parsed.output_text,
        parsed.outputText,
      ].find((entry) => typeof entry === 'string' && entry.trim());

      if (functionText) {
        return stripNullCharacters(functionText).trim();
      }
    }

    const directKeys = ['output_text', 'text', 'refusal', 'content', 'message', 'response', 'output'];
    for (const key of directKeys) {
      const extracted = extractAssistantText(value[key]);
      if (extracted) {
        return extracted;
      }
    }

    if (value.role === 'assistant' && Array.isArray(value.content)) {
      const extracted = extractAssistantText(value.content);
      if (extracted) {
        return extracted;
      }
    }

    const nestedKeys = ['content', 'output', 'payload', 'data', 'item', 'items', 'value', 'result'];
    for (const key of nestedKeys) {
      const extracted = extractAssistantText(value[key]);
      if (extracted) {
        return extracted;
      }
    }

    return '';
  }

  function normalizeAssistantMetadata(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const nextMetadata = {};

    if (Array.isArray(value)) {
      const reasoningSummary = extractReasoningSummary(value);
      if (reasoningSummary) {
        nextMetadata.reasoningSummary = reasoningSummary;
        nextMetadata.reasoningAvailable = true;
      }

      return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
    }

    if (value.agentExecutor === true) {
      nextMetadata.agentExecutor = true;
    }

    if (typeof value.taskType === 'string' && value.taskType.trim()) {
      nextMetadata.taskType = value.taskType.trim();
    }

    const reasoningSummary = extractReasoningSummary(value);
    if (reasoningSummary) {
      nextMetadata.reasoningSummary = reasoningSummary;
      nextMetadata.reasoningAvailable = true;
    } else if (value.reasoningAvailable === true || value.reasoning_available === true) {
      nextMetadata.reasoningAvailable = true;
    }

    const displayContent = typeof value.displayContent === 'string' && value.displayContent.trim()
      ? value.displayContent.trim()
      : (typeof value.display_content === 'string' && value.display_content.trim()
        ? value.display_content.trim()
        : '');
    if (displayContent) {
      nextMetadata.displayContent = displayContent;
    }

    return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
  }

  function extractReasoningSummary(value) {
    if (typeof value === 'string') {
      return stripNullCharacters(value).trim();
    }

    if (Array.isArray(value)) {
      return value
        .map((entry) => extractReasoningSummary(entry))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (!value || typeof value !== 'object') {
      return '';
    }

    if (isReasoningLikeBlock(value)) {
      const segments = [
        value.summary,
        value.summary_text,
        value.reasoning_content,
        value.reasoning,
        value.text,
        value.content,
        value.output_text,
        value.value,
      ]
        .map((candidate) => extractReasoningSummary(candidate))
        .filter(Boolean);

      return [...new Set(segments)].join(' ').replace(/\s+/g, ' ').trim();
    }

    const leafTextCandidates = [
      value.text,
      value.output_text,
      value.summary_text,
      value.value,
    ];
    for (const candidate of leafTextCandidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return stripNullCharacters(candidate).trim();
      }
    }

    const directCandidates = [
      value.reasoningSummary,
      value.reasoning_summary,
      value.reasoningText,
      value.reasoning_text,
      value.reasoning_content,
      value.reasoningContent,
      value.reasoning,
      value.reasoning_delta,
      value.reasoningDelta,
      value.reasoning_details,
      value.reasoningDetails,
      value.thinkingSummary,
      value.thinking_summary,
      value.thinkingText,
      value.thinking_text,
      value.thinking_content,
      value.thinkingContent,
      value.thinking,
      value.thinking_delta,
      value.thinkingDelta,
      value.thoughtSummary,
      value.thought_summary,
      value.thoughtText,
      value.thought_text,
      value.thought_content,
      value.thoughtContent,
      value.thought,
      value.thought_delta,
      value.thoughtDelta,
      value.summary_text,
      value.summaryText,
    ];
    for (const candidate of directCandidates) {
      const normalized = extractReasoningSummary(candidate);
      if (normalized) {
        return normalized;
      }
    }

    const nestedCandidates = [
      value.choices?.[0]?.message?.reasoning,
      value.choices?.[0]?.message?.reasoning_text,
      value.choices?.[0]?.message?.reasoning_content,
      value.choices?.[0]?.message?.reasoning_details,
      value.choices?.[0]?.message?.thinking,
      value.choices?.[0]?.message?.thinking_text,
      value.choices?.[0]?.message?.thinking_content,
      value.choices?.[0]?.message?.thought,
      value.choices?.[0]?.message?.thought_text,
      value.choices?.[0]?.message?.thought_content,
      value.choices?.[0]?.delta?.reasoning,
      value.choices?.[0]?.delta?.reasoning_text,
      value.choices?.[0]?.delta?.reasoning_content,
      value.choices?.[0]?.delta?.reasoning_details,
      value.choices?.[0]?.delta?.thinking,
      value.choices?.[0]?.delta?.thinking_text,
      value.choices?.[0]?.delta?.thinking_content,
      value.choices?.[0]?.delta?.thought,
      value.choices?.[0]?.delta?.thought_text,
      value.choices?.[0]?.delta?.thought_content,
      value.message?.reasoning,
      value.message?.reasoning_text,
      value.message?.reasoning_content,
      value.message?.reasoning_details,
      value.message?.thinking,
      value.message?.thinking_text,
      value.message?.thinking_content,
      value.message?.thought,
      value.message?.thought_text,
      value.message?.thought_content,
      value.response?.choices?.[0]?.message?.reasoning,
      value.response?.choices?.[0]?.message?.reasoning_text,
      value.response?.choices?.[0]?.message?.reasoning_content,
      value.response?.choices?.[0]?.message?.reasoning_details,
      value.response?.choices?.[0]?.message?.thinking,
      value.response?.choices?.[0]?.message?.thinking_text,
      value.response?.choices?.[0]?.message?.thinking_content,
      value.response?.choices?.[0]?.message?.thought,
      value.response?.choices?.[0]?.message?.thought_text,
      value.response?.choices?.[0]?.message?.thought_content,
      value.response?.choices?.[0]?.delta?.reasoning,
      value.response?.choices?.[0]?.delta?.reasoning_text,
      value.response?.choices?.[0]?.delta?.reasoning_content,
      value.response?.choices?.[0]?.delta?.reasoning_details,
      value.response?.choices?.[0]?.delta?.thinking,
      value.response?.choices?.[0]?.delta?.thinking_text,
      value.response?.choices?.[0]?.delta?.thinking_content,
      value.response?.choices?.[0]?.delta?.thought,
      value.response?.choices?.[0]?.delta?.thought_text,
      value.response?.choices?.[0]?.delta?.thought_content,
      value.response?.message?.reasoning,
      value.response?.message?.reasoning_text,
      value.response?.message?.reasoning_content,
      value.response?.message?.reasoning_details,
      value.response?.message?.thinking,
      value.response?.message?.thinking_text,
      value.response?.message?.thinking_content,
      value.response?.message?.thought,
      value.response?.message?.thought_text,
      value.response?.message?.thought_content,
    ];
    for (const candidate of nestedCandidates) {
      const normalized = extractReasoningSummary(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return '';
  }

  function extractAssistantMetadata(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const sources = [
      value.assistantMetadata,
      value.assistant_metadata,
      value.output,
      value.response?.assistantMetadata,
      value.response?.assistant_metadata,
      value.response?.output,
      value.choices?.[0]?.message,
      value.response?.choices?.[0]?.message,
      value.response?.metadata,
      value.metadata,
    ];

    for (const source of sources) {
      const normalized = normalizeAssistantMetadata(source);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  function extractToolEvents(payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    if (Array.isArray(payload.toolEvents)) {
      return payload.toolEvents;
    }

    if (Array.isArray(payload.tool_events)) {
      return payload.tool_events;
    }

    const message = payload.choices?.[0]?.message || {};
    if (Array.isArray(message.toolEvents)) {
      return message.toolEvents;
    }

    if (Array.isArray(message.tool_events)) {
      return message.tool_events;
    }

    if (Array.isArray(payload.response?.metadata?.toolEvents)) {
      return payload.response.metadata.toolEvents;
    }

    if (Array.isArray(payload.response?.metadata?.tool_events)) {
      return payload.response.metadata.tool_events;
    }

    return [];
  }

  function extractArtifacts(payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const artifactSources = [
      payload.artifacts,
      payload.metadata?.artifacts,
      payload.assistantMetadata?.artifacts,
      payload.assistant_metadata?.artifacts,
      payload.choices?.[0]?.message?.artifacts,
      payload.choices?.[0]?.message?.metadata?.artifacts,
      payload.choices?.[0]?.message?.assistantMetadata?.artifacts,
      payload.choices?.[0]?.message?.assistant_metadata?.artifacts,
      payload.response?.artifacts,
      payload.response?.metadata?.artifacts,
      payload.response?.assistantMetadata?.artifacts,
      payload.response?.assistant_metadata?.artifacts,
    ];

    for (const artifacts of artifactSources) {
      if (Array.isArray(artifacts)) {
        return artifacts.map(normalizeArtifactMetadata).filter(Boolean);
      }
    }

    return [];
  }

  function normalizeArtifactMetadata(artifact) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      return null;
    }

    const normalized = { ...artifact };
    const fields = {
      id: artifact.id || artifact.artifactId || artifact.artifact_id,
      filename: artifact.filename || artifact.name,
      format: artifact.format || artifact.extension || artifact.type,
      mimeType: artifact.mimeType || artifact.mime_type,
      downloadUrl: artifact.downloadUrl || artifact.download_url,
      previewUrl: artifact.previewUrl || artifact.preview_url,
      sandboxUrl: artifact.sandboxUrl || artifact.sandbox_url,
      bundleDownloadUrl: artifact.bundleDownloadUrl
        || artifact.bundle_download_url
        || artifact.bundle_download,
    };

    for (const [key, value] of Object.entries(fields)) {
      const text = String(value || '').trim();
      if (text) {
        normalized[key] = text;
      }
    }

    const sizeValue = artifact.sizeBytes ?? artifact.size_bytes ?? artifact.size;
    if (Number.isFinite(Number(sizeValue))) {
      normalized.sizeBytes = Number(sizeValue);
    }

    return normalized.id || normalized.downloadUrl ? normalized : null;
  }

  function extractStreamMetadata(payload = {}) {
    const sessionId = payload.session_id
      || payload.sessionId
      || payload.response?.session_id
      || payload.response?.sessionId
      || null;
    const responseId = payload.response?.id || payload.id || null;

    return {
      sessionId,
      responseId,
      artifacts: extractArtifacts(payload),
      toolEvents: extractToolEvents(payload),
      assistantMetadata: extractAssistantMetadata(payload),
      model: payload.response?.model || payload.model || null,
    };
  }

  function normalizeToolCallsWithIndexes(toolCalls = []) {
    return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall, index) => {
      if (!toolCall || typeof toolCall !== 'object') {
        return toolCall;
      }

      const rawIndex = Number(toolCall.index);
      return {
        ...toolCall,
        index: Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : index,
      };
    });
  }

  function extractFinalAssistantText(payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return '';
    }

    if (payload.type === 'response.completed') {
      return extractAssistantText(payload.response?.output_text || payload.response?.output || payload.response);
    }

    if (payload.type === 'done') {
      return extractAssistantText(
        payload.message
        || payload.content
        || payload.output_text
        || payload.outputText
        || payload.output
        || payload.response
        || '',
      );
    }

    if (payload.object === 'chat.completion') {
      return extractAssistantText(payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.message ?? payload);
    }

    if (payload.object === 'response'
      || Object.prototype.hasOwnProperty.call(payload, 'output_text')
      || Array.isArray(payload.output)) {
      return extractAssistantText(payload.output_text || payload.output || payload);
    }

    return '';
  }

  function getMissingFinalText(streamedText = '', finalText = '') {
    const streamed = stripNullCharacters(streamedText || '');
    const final = stripNullCharacters(finalText || '');

    if (!final) {
      return '';
    }

    if (!streamed) {
      return final;
    }

    if (final === streamed || streamed.includes(final)) {
      return '';
    }

    if (final.startsWith(streamed)) {
      return final.slice(streamed.length);
    }

    return final;
  }

  function normalizeGatewayEventPayload(payload = {}, options = {}) {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const allowFinalText = options.allowFinalText === true;
    const metadata = extractStreamMetadata(payload);
    const events = [];

    if (payload.error) {
      events.push({
        type: 'error',
        error: payload.error,
        raw: payload,
        ...metadata,
      });
      return events;
    }

    if (payload.type === 'response.output_text.delta') {
      events.push({
        type: 'text_delta',
        content: extractStreamText(payload.delta ?? payload.output_text_delta ?? ''),
        raw: payload,
        ...metadata,
      });
      return events;
    }

    if (payload.type === 'response.refusal.delta') {
      events.push({
        type: 'text_delta',
        content: extractStreamText(payload.delta ?? payload.refusal_delta ?? ''),
        raw: payload,
        ...metadata,
      });
      return events;
    }

    if (payload.type === 'response.reasoning_summary_text.delta') {
      const reasoning = extractReasoningSummary(payload.delta ?? payload.reasoning_delta ?? '');
      const summary = extractReasoningSummary(payload.summary || payload.reasoningSummary || payload.reasoning_summary || reasoning);
      events.push({
        type: 'reasoning_delta',
        content: reasoning,
        summary,
        publicSummary: true,
        raw: payload,
        ...metadata,
      });
      return events;
    }

    if ((payload.type === 'response.output_item.added' || payload.type === 'response.output_item.done') && isFunctionCallItem(payload.item)) {
      events.push({
        type: 'tool_calls',
        toolCalls: normalizeToolCallsWithIndexes([payload.item]),
        stage: payload.type.endsWith('.done') ? 'done' : 'started',
        raw: payload,
        ...metadata,
      });
      return events;
    }

    if (payload.type === 'chat.completion.tool_calls.delta' && Array.isArray(payload.tool_calls) && payload.tool_calls.length > 0) {
      events.push({
        type: 'tool_calls',
        toolCalls: normalizeToolCallsWithIndexes(payload.tool_calls),
        stage: 'started',
        raw: payload,
        ...metadata,
      });
      return events;
    }

    if (payload.type === 'response.completed') {
      events.push({
        type: 'final',
        response: payload.response || null,
        raw: payload,
        ...metadata,
      });
      return events;
    }

    if (payload.object === 'chat.completion.chunk') {
      const choice = payload.choices?.[0] || {};
      const delta = choice.delta || {};

      if (delta.content) {
        events.push({
          type: 'text_delta',
          content: extractStreamText(delta.content),
          raw: payload,
          ...metadata,
        });
      }

      const reasoning = extractReasoningSummary(
        delta.reasoning
        || delta.reasoning_text
        || delta.reasoning_content
        || delta.reasoning_details
        || '',
      );
      if (reasoning) {
        events.push({
          type: 'reasoning_delta',
          content: stripNullCharacters(reasoning),
          summary: stripNullCharacters(reasoning),
          raw: payload,
          ...metadata,
        });
      }

      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        events.push({
          type: 'tool_calls',
          toolCalls: normalizeToolCallsWithIndexes(delta.tool_calls),
          stage: 'started',
          raw: payload,
          ...metadata,
        });
      }

      if (choice.finish_reason) {
        events.push({
          type: 'finish',
          finishReason: choice.finish_reason,
          raw: payload,
          ...metadata,
        });
      }

      return events;
    }

    if (payload.object === 'response.chunk') {
      if (payload.output_text_delta) {
        events.push({
          type: 'text_delta',
          content: extractStreamText(payload.output_text_delta),
          raw: payload,
          ...metadata,
        });
      }

      const reasoning = extractReasoningSummary(
        payload.reasoning_delta
        || payload.reasoning
        || payload.reasoning_text
        || payload.reasoning_content
        || payload.reasoning_details
        || payload.output
        || '',
      );
      if (reasoning) {
        events.push({
          type: 'reasoning_delta',
          content: stripNullCharacters(reasoning),
          summary: stripNullCharacters(reasoning),
          raw: payload,
          ...metadata,
        });
      }

      const functionCalls = (Array.isArray(payload.output) ? payload.output : []).filter(isFunctionCallItem);
      if (functionCalls.length > 0) {
        events.push({
          type: 'tool_calls',
          toolCalls: functionCalls,
          stage: 'started',
          raw: payload,
          ...metadata,
        });
      }

      return events;
    }

    if (payload.type === 'progress') {
      const progress = payload.progress && typeof payload.progress === 'object'
        ? payload.progress
        : {};
      events.push({
        type: 'progress',
        progress,
        phase: extractDisplayText(progress.phase || payload.phase || ''),
        detail: extractDisplayText(progress.detail || payload.detail || ''),
        raw: payload,
        ...metadata,
      });
      return events;
    }

    if (payload.type === 'delta') {
      events.push({
        type: 'text_delta',
        content: extractStreamText(payload.content || payload.delta || ''),
        raw: payload,
        ...metadata,
      });
      return events;
    }

    if (payload.type === 'done') {
      events.push({
        type: 'finish',
        finishReason: 'stop',
        raw: payload,
        ...metadata,
      });
      return events;
    }

    const looksLikeChatCompletion = payload.object === 'chat.completion' || Array.isArray(payload.choices);
    if (looksLikeChatCompletion) {
      if (allowFinalText) {
        const content = extractAssistantText(payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.message ?? payload);
        if (content) {
          events.push({
            type: 'text_delta',
            content,
            finalChunk: true,
            raw: payload,
            ...metadata,
          });
        }

        const reasoningSummary = extractAssistantMetadata(payload)?.reasoningSummary || '';
        if (reasoningSummary) {
          events.push({
            type: 'reasoning_delta',
            content: reasoningSummary,
            summary: reasoningSummary,
            finalChunk: true,
            raw: payload,
            ...metadata,
          });
        }
      }

      if (payload.choices?.[0]?.finish_reason) {
        events.push({
          type: 'finish',
          finishReason: payload.choices[0].finish_reason,
          raw: payload,
          ...metadata,
        });
      }

      events.push({
        type: 'final',
        response: payload,
        raw: payload,
        ...metadata,
      });
      return events;
    }

    const looksLikeResponseObject = payload.object === 'response'
      || Object.prototype.hasOwnProperty.call(payload, 'output_text')
      || Array.isArray(payload.output);
    if (looksLikeResponseObject) {
      if (allowFinalText) {
        const content = extractAssistantText(payload.output_text || payload.output || payload);
        if (content) {
          events.push({
            type: 'text_delta',
            content,
            finalChunk: true,
            raw: payload,
            ...metadata,
          });
        }

        const reasoningSummary = extractAssistantMetadata(payload)?.reasoningSummary || '';
        if (reasoningSummary) {
          events.push({
            type: 'reasoning_delta',
            content: reasoningSummary,
            summary: reasoningSummary,
            finalChunk: true,
            raw: payload,
            ...metadata,
          });
        }
      }

      events.push({
        type: 'final',
        response: payload,
        raw: payload,
        ...metadata,
      });
      return events;
    }

    return events;
  }

  async function* streamGatewayResponse(response, options = {}) {
    const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();

    if (contentType.includes('application/json')) {
      const payload = await response.json();
      const events = normalizeGatewayEventPayload(payload, { allowFinalText: true });
      for (const event of events) {
        yield event;
      }
      yield { type: 'done', response: payload };
      return;
    }

    const reader = response?.body?.getReader?.();
    if (!reader) {
      throw new Error('Streaming response body is unavailable');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false;
    let streamedText = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const { frames, remainder } = splitSSEFrames(buffer);
        buffer = remainder;

        for (const frame of frames) {
          const commentText = extractSSEComment(frame);
          if (commentText) {
            yield {
              type: commentText === 'stream-open' ? 'stream_open' : 'comment',
              comment: commentText,
            };
            continue;
          }

          const payloadText = extractSSEData(frame);
          if (!payloadText) {
            continue;
          }

          if (payloadText === '[DONE]') {
            sawDone = true;
            yield { type: 'done' };
            return;
          }

          let payload;
          try {
            payload = JSON.parse(payloadText);
          } catch (_error) {
            continue;
          }

          const events = normalizeGatewayEventPayload(payload, { allowFinalText: false });
          const missingFinalText = getMissingFinalText(streamedText, extractFinalAssistantText(payload));
          if (missingFinalText) {
            streamedText += missingFinalText;
            yield {
              type: 'text_delta',
              content: missingFinalText,
              finalChunk: true,
              raw: payload,
              ...extractStreamMetadata(payload),
            };
          }
          for (const event of events) {
            if (event.type === 'text_delta' && event.content) {
              streamedText += event.content;
            }
            yield event;
          }
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const commentText = extractSSEComment(buffer);
        if (commentText) {
          yield {
            type: commentText === 'stream-open' ? 'stream_open' : 'comment',
            comment: commentText,
          };
          return;
        }

        const payloadText = extractSSEData(buffer);
        if (payloadText === '[DONE]') {
          sawDone = true;
          yield { type: 'done' };
          return;
        }

        if (payloadText) {
          try {
            const payload = JSON.parse(payloadText);
            const events = normalizeGatewayEventPayload(payload, { allowFinalText: false });
            const missingFinalText = getMissingFinalText(streamedText, extractFinalAssistantText(payload));
            if (missingFinalText) {
              streamedText += missingFinalText;
              yield {
                type: 'text_delta',
                content: missingFinalText,
                finalChunk: true,
                raw: payload,
                ...extractStreamMetadata(payload),
              };
            }
            for (const event of events) {
              if (event.type === 'text_delta' && event.content) {
                streamedText += event.content;
              }
              yield event;
            }
          } catch (_error) {
            // Ignore malformed trailing payloads.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!sawDone && options.emitImplicitDone !== false) {
      yield { type: 'done', implicit: true };
    }
  }

  return {
    DEFAULT_GATEWAY_AUTH_TOKEN,
    DEFAULT_CODEX_MODEL_ID,
    DEFAULT_CODEX_MODEL_IDS,
    buildGatewayRealtimeUrl,
    TERMINAL_FINISH_REASONS,
    buildGatewayHeaders,
    extractAssistantMetadata,
    extractAssistantText,
    extractSSEComment,
    extractSSEData,
    extractStreamMetadata,
    extractToolEvents,
    filterChatModels,
    filterCodexBackedModels,
    isChatModel,
    isCodexBackedModel,
    isFunctionCallItem,
    isTerminalFinishReason,
    normalizeGatewayEventPayload,
    normalizeModelId,
    resolvePreferredChatModel,
    selectPreferredCodexModel,
    splitSSEFrames,
    streamGatewayResponse,
    stripNullCharacters,
  };
});
