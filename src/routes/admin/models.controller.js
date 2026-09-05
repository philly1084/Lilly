/**
 * Models Controller
 * Exposes live model inventory from the configured OpenAI-compatible endpoint.
 */

const { listModels } = require('../../openai-client');
const { buildModelContract, isPublicChatModel } = require('../../model-catalog');
const settingsController = require('./settings.controller');
const logsController = require('./logs.controller');

const EXCLUDED_MODEL_TOKENS = [
  'embed',
  'embedding',
  'image',
  'tts',
  'transcribe',
  'audio',
  'realtime',
  'moderation',
  'omni-moderation',
  'whisper',
];
const EWMA_LATENCY_ALPHA = 0.35;
const TOKENS_PER_MILLION = 1000000;

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function roundMetric(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

class ModelsController {
  async getAll(req, res) {
    try {
      const models = await this.getLiveModels();
      res.json({
        success: true,
        data: models,
        meta: {
          source: 'live-provider',
          count: models.length,
        },
      });
    } catch (error) {
      console.error('Error getting models:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params;
      const model = (await this.getLiveModels()).find((entry) => entry.id === id);

      if (!model) {
        return res.status(404).json({ success: false, error: 'Model not found' });
      }

      res.json({ success: true, data: model });
    } catch (error) {
      console.error('Error getting model:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async update(req, res) {
    try {
      const { id } = req.params;
      const { config, isActive, description } = req.body;

      const model = (await this.getLiveModels()).find((entry) => entry.id === id);
      if (!model) {
        return res.status(404).json({ success: false, error: 'Model not found' });
      }

      const settings = this.ensureModelSettings();
      const catalog = settings.catalog || {};
      const existing = catalog[id] || {};

      catalog[id] = {
        ...existing,
        ...(config ? { config: { ...(existing.config || {}), ...config } } : {}),
        ...(typeof isActive === 'boolean' ? { isActive } : {}),
        ...(typeof description === 'string' ? { description } : {}),
        updatedAt: new Date().toISOString(),
      };

      settings.catalog = catalog;
      await settingsController.saveSettings();

      const updated = (await this.getLiveModels()).find((entry) => entry.id === id);
      res.json({ success: true, data: updated });
    } catch (error) {
      console.error('Error updating model:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async activate(req, res) {
    try {
      const { id } = req.params;
      const model = (await this.getLiveModels()).find((entry) => entry.id === id);

      if (!model) {
        return res.status(404).json({ success: false, error: 'Model not found' });
      }

      const settings = this.ensureModelSettings();
      settings.defaultModel = id;
      settings.catalog = {
        ...(settings.catalog || {}),
        [id]: {
          ...(settings.catalog?.[id] || {}),
          isActive: true,
          updatedAt: new Date().toISOString(),
        },
      };

      await settingsController.saveSettings();

      const updated = (await this.getLiveModels()).find((entry) => entry.id === id);
      res.json({ success: true, data: updated });
    } catch (error) {
      console.error('Error activating model:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async getUsageStats(req, res) {
    try {
      let models = [];
      let source = 'runtime-logs';
      try {
        models = await this.getLiveModels();
        source = 'runtime-logs+live-provider';
      } catch (error) {
        console.warn('Falling back to runtime logs for model usage stats:', error.message);
      }
      const usage = this.buildUsageStats(models);
      const summary = this.buildUsageSummary(usage);
      res.json({
        success: true,
        data: usage,
        meta: {
          source,
          count: usage.length,
          summary,
          providerTotals: summary.providerTotals,
        },
      });
    } catch (error) {
      console.error('Error getting usage stats:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  async getLiveModels() {
    const providerModels = await listModels();
    const settings = this.ensureModelSettings();
    const catalog = settings.catalog || {};

    return providerModels
      .filter((model) => this.isUsableChatModel(model))
      .map((model) => this.normalizeLiveModel(model, settings, catalog[model.id] || {}))
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        if (a.isFallback !== b.isFallback) return a.isFallback ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  isUsableChatModel(model = {}) {
    const id = String(model.id || '').toLowerCase();
    if (!id) return false;
    return isPublicChatModel(model) && !EXCLUDED_MODEL_TOKENS.some((token) => id.includes(token));
  }

  normalizeLiveModel(model = {}, settings = {}, override = {}) {
    const id = String(model.id || '').trim();
    const contract = buildModelContract({ ...model, id });
    const provider = contract.provider || model.owned_by || 'unknown';
    const mergedConfig = {
      temperature: settings.temperature ?? 0.7,
      maxTokens: settings.maxTokens ?? 4096,
      topP: settings.topP ?? 1,
      frequencyPenalty: settings.frequencyPenalty ?? 0,
      presencePenalty: settings.presencePenalty ?? 0,
      ...(override.config || {}),
    };

    return {
      id,
      name: this.humanizeModelName(id),
      provider,
      description: override.description || `Live model exposed by ${provider}`,
      config: mergedConfig,
      isDefault: id === settings.defaultModel,
      isFallback: id === settings.fallbackModel,
      isActive: typeof override.isActive === 'boolean'
        ? override.isActive
        : id === settings.defaultModel || id === settings.fallbackModel,
      capabilities: contract.capabilities,
      pricing: override.pricing || null,
      contextWindow: override.contextWindow || contract.contextWindow || null,
      createdAt: model.created ? new Date(model.created * 1000).toISOString() : null,
      updatedAt: override.updatedAt || null,
      raw: {
        object: model.object || 'model',
        owned_by: provider,
      },
    };
  }

  inferCapabilities(modelId = '') {
    const capabilities = ['chat', 'responses', 'streaming'];

    if (/(4o|vision|omni|gemini|claude-3|claude-4|gpt-[56])/.test(modelId)) {
      capabilities.push('vision', 'image_input');
    }
    if (/(tool|function|4o|o3|o4|gpt-[56]|claude|gemini)/.test(modelId)) {
      capabilities.push('tools');
    }
    if (/^(o1|o3|o4)|reason|gpt-[56]/.test(modelId)) {
      capabilities.push('reasoning');
    }
    if (/(json|4o|o3|o4|gpt-[56])/.test(modelId)) {
      capabilities.push('json', 'structured_outputs');
    }

    return [...new Set(capabilities)];
  }

  humanizeModelName(id = '') {
    return String(id)
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  deriveLogTokenUsage(log = {}) {
    const promptTokens = toFiniteNumber(log.promptTokens);
    const completionTokens = toFiniteNumber(log.completionTokens);
    const explicitTotalTokens = toFiniteNumber(log.tokens);
    const hasPromptTokens = promptTokens !== null;
    const hasCompletionTokens = completionTokens !== null;
    const hasTotalTokens = explicitTotalTokens !== null;
    const totalTokens = hasTotalTokens
      ? explicitTotalTokens
      : (hasPromptTokens ? promptTokens : 0) + (hasCompletionTokens ? completionTokens : 0);

    let inputTokens = hasPromptTokens ? promptTokens : null;
    let outputTokens = hasCompletionTokens ? completionTokens : null;

    if (inputTokens === null && outputTokens !== null && hasTotalTokens) {
      inputTokens = Math.max(0, totalTokens - outputTokens);
    }
    if (outputTokens === null && inputTokens !== null && hasTotalTokens) {
      outputTokens = Math.max(0, totalTokens - inputTokens);
    }

    if (inputTokens === null) {
      inputTokens = 0;
    }
    if (outputTokens === null) {
      outputTokens = (!hasPromptTokens && !hasCompletionTokens && hasTotalTokens)
        ? totalTokens
        : 0;
    }

    return {
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }

  readPricingRate(pricing = null, keys = []) {
    if (!pricing || typeof pricing !== 'object') {
      return 0;
    }

    for (const key of keys) {
      const value = key.split('.').reduce((current, segment) => (
        current && typeof current === 'object' ? current[segment] : undefined
      ), pricing);
      const parsed = toFiniteNumber(value);
      if (parsed !== null) {
        return parsed;
      }
    }

    return 0;
  }

  estimateUsageCost(model = null, usage = {}) {
    const pricing = model?.pricing || null;
    const inputRate = this.readPricingRate(pricing, [
      'inputPerMillion',
      'input_per_million',
      'input_per_1m',
      'input.perMillion',
      'input.per_1m',
      'promptPerMillion',
      'prompt.perMillion',
      'prompt',
      'input',
    ]);
    const outputRate = this.readPricingRate(pricing, [
      'outputPerMillion',
      'output_per_million',
      'output_per_1m',
      'output.perMillion',
      'output.per_1m',
      'completionPerMillion',
      'completion.perMillion',
      'completion',
      'output',
    ]);
    const input = (Number(usage.inputTokens || 0) / TOKENS_PER_MILLION) * inputRate;
    const output = (Number(usage.outputTokens || 0) / TOKENS_PER_MILLION) * outputRate;

    return {
      input: roundMoney(input),
      output: roundMoney(output),
      total: roundMoney(input + output),
      estimated: Boolean(inputRate || outputRate),
      source: pricing ? 'model-pricing' : null,
    };
  }

  buildUsageStats(models = []) {
    const usageByModel = new Map();
    const catalogById = new Map((models || []).map((model) => [model.id, model]));

    for (const log of [...(logsController.logs || [])].reverse()) {
      const modelId = String(log.model || '').trim();
      if (!modelId) continue;

      const current = usageByModel.get(modelId) || {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalLatency: 0,
        ewmaLatency: null,
        successCount: 0,
      };
      const tokenUsage = this.deriveLogTokenUsage(log);
      const latency = Number(log.latency || log.duration || 0);

      current.requests += 1;
      current.totalLatency += latency;
      if (latency > 0) {
        current.ewmaLatency = current.ewmaLatency === null
          ? latency
          : (EWMA_LATENCY_ALPHA * latency) + ((1 - EWMA_LATENCY_ALPHA) * current.ewmaLatency);
      }
      current.inputTokens += tokenUsage.inputTokens;
      current.outputTokens += tokenUsage.outputTokens;
      current.totalTokens += tokenUsage.totalTokens;
      current.successCount += log.status === 'error' ? 0 : 1;
      usageByModel.set(modelId, current);
    }

    const orderedModelIds = [
      ...new Set([
        ...(models || []).map((model) => model.id),
        ...usageByModel.keys(),
      ]),
    ];

    return orderedModelIds.map((modelId) => {
      const model = catalogById.get(modelId) || null;
      const usage = usageByModel.get(modelId) || {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalLatency: 0,
        ewmaLatency: null,
        successCount: 0,
      };
      const cost = this.estimateUsageCost(model, usage);
      const elapsedSeconds = Math.max(0, Number(usage.totalLatency || 0) / 1000);
      const outputTokensPerSecond = elapsedSeconds > 0
        ? roundMetric(Number(usage.outputTokens || 0) / elapsedSeconds)
        : 0;
      const totalTokensPerSecond = elapsedSeconds > 0
        ? roundMetric(Number(usage.totalTokens || 0) / elapsedSeconds)
        : 0;

      return {
        modelId,
        modelName: model?.name || this.humanizeModelName(modelId),
        provider: model?.provider || model?.raw?.owned_by || 'unknown',
        requests: usage.requests,
        tokens: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          total: usage.totalTokens,
        },
        cost: {
          input: cost.input,
          output: cost.output,
          total: cost.total,
          estimated: cost.estimated,
          source: cost.source,
        },
        estimatedCost: cost.total,
        tokensPerSecond: outputTokensPerSecond,
        throughput: {
          outputTokensPerSecond,
          totalTokensPerSecond,
        },
        avgResponseTime: usage.requests > 0 ? Math.round(usage.totalLatency / usage.requests) : 0,
        ewmaLatency: usage.ewmaLatency === null ? 0 : Math.round(usage.ewmaLatency),
        successRate: usage.requests > 0 ? Math.round((usage.successCount / usage.requests) * 100) : 0,
        isDefault: Boolean(model?.isDefault),
      };
    }).sort((a, b) => (
      Number(b.tokens?.total || 0) - Number(a.tokens?.total || 0)
      || Number(b.requests || 0) - Number(a.requests || 0)
      || String(a.modelName || '').localeCompare(String(b.modelName || ''))
    ));
  }

  buildUsageSummary(usage = []) {
    const summary = {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      providerTotals: [],
    };
    const providerMap = new Map();

    for (const entry of usage) {
      const input = Number(entry.tokens?.input || 0);
      const output = Number(entry.tokens?.output || 0);
      const total = Number(entry.tokens?.total || (input + output));
      const requests = Number(entry.requests || 0);
      const provider = String(entry.provider || 'unknown');

      if (requests <= 0 && total <= 0) {
        continue;
      }

      summary.totalRequests += requests;
      summary.totalInputTokens += input;
      summary.totalOutputTokens += output;
      summary.totalTokens += total;
      summary.estimatedCost = roundMoney(summary.estimatedCost + Number(entry.cost?.total || entry.estimatedCost || 0));

      const current = providerMap.get(provider) || {
        provider,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
        modelCount: 0,
      };

      current.requests += requests;
      current.inputTokens += input;
      current.outputTokens += output;
      current.totalTokens += total;
      current.estimatedCost = roundMoney(current.estimatedCost + Number(entry.cost?.total || entry.estimatedCost || 0));
      current.modelCount += 1;
      providerMap.set(provider, current);
    }

    summary.providerTotals = Array.from(providerMap.values())
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests || a.provider.localeCompare(b.provider));

    return summary;
  }

  ensureModelSettings() {
    if (!settingsController.settings.models) {
      settingsController.settings.models = {};
    }
    if (!settingsController.settings.models.catalog) {
      settingsController.settings.models.catalog = {};
    }
    return settingsController.settings.models;
  }
}

module.exports = new ModelsController();
