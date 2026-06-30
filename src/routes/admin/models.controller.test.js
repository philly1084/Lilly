jest.mock('../../openai-client', () => ({
  listModels: jest.fn(),
}));

jest.mock('./settings.controller', () => ({
  settings: {
    models: {
      catalog: {},
    },
  },
  saveSettings: jest.fn(),
}));

jest.mock('./logs.controller', () => ({
  logs: [],
}));

const { listModels } = require('../../openai-client');
const logsController = require('./logs.controller');
const modelsController = require('./models.controller');

describe('admin models controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    logsController.logs = [];
  });

  test('includes logged models that are missing from the live provider catalog', () => {
    logsController.logs = [{
      model: 'custom-model',
      promptTokens: 50,
      completionTokens: 25,
      tokens: 75,
      latency: 120,
      status: 'success',
    }];

    const usage = modelsController.buildUsageStats([]);

    expect(usage).toEqual([
      expect.objectContaining({
        modelId: 'custom-model',
        modelName: 'Custom Model',
        provider: 'unknown',
        requests: 1,
        tokens: {
          input: 50,
          output: 25,
          total: 75,
        },
      }),
    ]);
  });

  test('falls back to runtime logs when the live model lookup fails', async () => {
    listModels.mockRejectedValue(new Error('provider unavailable'));
    logsController.logs = [{
      model: 'gpt-offline',
      promptTokens: 10,
      completionTokens: 5,
      tokens: 15,
      latency: 50,
      status: 'success',
    }];

    const req = {};
    const res = {
      json: jest.fn(),
      status: jest.fn(function setStatus() {
        return this;
      }),
    };

    await modelsController.getUsageStats(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: [
        expect.objectContaining({
          modelId: 'gpt-offline',
          requests: 1,
          tokens: {
            input: 10,
            output: 5,
            total: 15,
          },
        }),
      ],
      meta: expect.objectContaining({
        source: 'runtime-logs',
      }),
    }));
  });

  test('uses shared model contracts for live model capability metadata', async () => {
    listModels.mockResolvedValue([
      { id: 'gpt-5.5-tools', owned_by: 'openai' },
      { id: 'grok-4.3', owned_by: 'gateway' },
      { id: 'custom-image-router', owned_by: 'gateway', capabilities: ['image_generation'] },
    ]);

    const models = await modelsController.getLiveModels();

    expect(models.map((model) => model.id)).toEqual(['gpt-5.5-tools', 'grok-4.3']);
    expect(models.find((model) => model.id === 'gpt-5.5-tools')).toEqual(expect.objectContaining({
      capabilities: expect.arrayContaining(['chat', 'responses', 'streaming', 'tools', 'structured_outputs']),
      provider: 'openai',
      contextWindow: 128000,
    }));
    expect(models.find((model) => model.id === 'grok-4.3')).toEqual(expect.objectContaining({
      capabilities: expect.arrayContaining(['tools', 'reasoning', 'structured_outputs']),
      provider: 'xai',
      contextWindow: 1000000,
    }));
  });

  test('does not double count explicit zero completion tokens from total log tokens', () => {
    logsController.logs = [{
      model: 'tool-only-model',
      promptTokens: 11,
      completionTokens: 0,
      tokens: 11,
      latency: 30,
      status: 'success',
    }];

    const usage = modelsController.buildUsageStats([]);

    expect(usage).toEqual([
      expect.objectContaining({
        modelId: 'tool-only-model',
        tokens: {
          input: 11,
          output: 0,
          total: 11,
        },
      }),
    ]);
  });

  test('derives the missing side from total log tokens without inflating totals', () => {
    logsController.logs = [{
      model: 'gpt-partial-log',
      promptTokens: 125,
      tokens: 165,
      latency: 80,
      status: 'success',
    }];

    const usage = modelsController.buildUsageStats([]);

    expect(usage).toEqual([
      expect.objectContaining({
        modelId: 'gpt-partial-log',
        tokens: {
          input: 125,
          output: 40,
          total: 165,
        },
      }),
    ]);
  });

  test('adds throughput, cost, and EWMA latency to usage stats', () => {
    logsController.logs = [
      {
        model: 'priced-model',
        promptTokens: 2000,
        completionTokens: 1000,
        tokens: 3000,
        latency: 3000,
        status: 'success',
      },
      {
        model: 'priced-model',
        promptTokens: 1000,
        completionTokens: 500,
        tokens: 1500,
        latency: 1000,
        status: 'success',
      },
    ];

    const usage = modelsController.buildUsageStats([{
      id: 'priced-model',
      name: 'Priced Model',
      provider: 'gateway',
      pricing: {
        inputPerMillion: 2,
        outputPerMillion: 6,
      },
    }]);

    expect(usage[0]).toEqual(expect.objectContaining({
      modelId: 'priced-model',
      tokensPerSecond: 375,
      throughput: {
        outputTokensPerSecond: 375,
        totalTokensPerSecond: 1125,
      },
      ewmaLatency: 1700,
      estimatedCost: 0.015,
      cost: expect.objectContaining({
        input: 0.006,
        output: 0.009,
        total: 0.015,
        estimated: true,
      }),
    }));
  });
});
