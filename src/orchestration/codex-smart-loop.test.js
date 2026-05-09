const { validatePlanStep } = require('./plan-validator');
const {
  evaluateToolReadiness,
  READINESS_DEGRADED,
  READINESS_READY,
} = require('./tool-readiness');
const {
  classifyFailureText,
  classifyToolEventFailure,
} = require('./recovery-policy');
const {
  buildModelContract,
  selectAutoModel,
} = require('../model-catalog');
const { SkillStore } = require('../skills/skill-store');
const { ConversationOrchestrator } = require('../conversation-orchestrator');
const { config } = require('../config');

describe('Codex-smart orchestration primitives', () => {
  test('tool readiness distinguishes executable tools from registry-only shells', () => {
    const ready = evaluateToolReadiness('web-fetch', { id: 'web-fetch', execute: async () => ({}) }, {
      skill: { enabled: true },
    });
    expect(ready.status).toBe(READINESS_READY);
    expect(ready.executableShape).toBe('execute');

    const degraded = evaluateToolReadiness('web-fetch', { id: 'web-fetch', backend: {} }, {
      skill: { enabled: true },
    });
    expect(degraded.status).toBe(READINESS_DEGRADED);
    expect(degraded.recoveryHints.join(' ')).toMatch(/no executable handler/i);
  });

  test('plan validation rejects unavailable or non-executable degraded tools', () => {
    const validation = validatePlanStep({
      tool: 'web-fetch',
      params: { url: 'https://example.com' },
    }, {
      candidateToolIds: ['web-fetch'],
      contracts: {
        'web-fetch': {
          inputSchema: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string' } },
          },
          readiness: {
            status: 'degraded',
            reason: 'Tool is registered but has no executable handler.',
            executableShape: 'none',
          },
        },
      },
    });

    expect(validation.ok).toBe(false);
    expect(validation.rejections.map((entry) => entry.code)).toContain('tool_degraded');
  });

  test('skill store scores trigger, tool affinity, surface, task, and capability hints', () => {
    const store = new SkillStore({ rootDir: '__unused__' });
    store.listSkills = jest.fn(() => [
      {
        id: 'remote-ops-workflow',
        name: 'Remote ops workflow',
        description: 'Kubernetes remote deploy and verification workflow',
        tools: ['remote-command', 'k3s-deploy'],
        triggerPatterns: ['remote deploy', 'k3s'],
        enabled: true,
        contextPolicy: { exposeBody: false },
        body: 'Run baseline, inspect, fix, verify.',
      },
      {
        id: 'chat-polish',
        name: 'Chat polish',
        description: 'Direct chat response',
        tools: [],
        triggerPatterns: ['chat'],
        enabled: true,
      },
    ]);

    const context = store.buildContext({
      text: 'remote deploy this to k3s',
      toolIds: ['remote-command'],
      surface: 'web-cli',
      taskType: 'deploy',
      capabilityNeeds: ['remote'],
    });

    expect(context.selectedSkills[0]).toEqual(expect.objectContaining({
      id: 'remote-ops-workflow',
    }));
    expect(context.block).toContain('remote-ops-workflow');
  });

  test('model contract and auto selection prefer compatible OpenAI-first models', () => {
    const mini = buildModelContract({ id: 'gpt-5.4-mini', owned_by: 'openai' }, { officialOpenAI: true });
    expect(mini.supports.chat).toBe(true);
    expect(mini.supports.responses).toBe(true);
    expect(mini.supports.tools).toBe(true);

    const selected = selectAutoModel([
      { id: 'text-embedding-3-large', owned_by: 'openai' },
      { id: 'llama-3.1-8b', owned_by: 'meta' },
      { id: 'gpt-5.5', owned_by: 'openai' },
    ], {
      needsTools: true,
      needsReasoning: true,
      apiMode: 'responses',
    }, {
      officialOpenAI: true,
    });

    expect(selected.id).toBe('gpt-5.5');
  });

  test('recovery policy classifies common failure classes', () => {
    expect(classifyFailureText('Missing required params: url')).toBe('bad_schema_or_missing_params');
    expect(classifyFailureText('Tool web-fetch is unavailable: no executable handler')).toBe('unavailable_tool');
    expect(classifyFailureText('Permission denied (publickey)')).toBe('auth_or_secret');

    const policy = classifyToolEventFailure({
      toolCall: { function: { name: 'web-fetch' } },
      result: { success: false, error: 'HTTP 503 timed out' },
    });
    expect(policy).toEqual(expect.objectContaining({
      failureKind: 'network_or_transient',
      retryable: true,
    }));
  });

  test('tool policy filters non-executable candidates and promotes recovery alternates', () => {
    const previousJudgmentFlag = config.runtime.judgmentV2Enabled;
    config.runtime.judgmentV2Enabled = true;
    try {
      const orchestrator = new ConversationOrchestrator({});
      const tools = new Map(['web-search', 'web-fetch', 'web-scrape'].map((toolId) => [toolId, {
        id: toolId,
        name: toolId,
        description: `${toolId} test tool`,
        execute: async () => ({ success: true }),
        inputSchema: {
          type: 'object',
          properties: {},
        },
      }]));
      const toolManager = {
        getTool: jest.fn((toolId) => tools.get(toolId) || null),
        getToolReadiness: jest.fn((toolId) => toolId === 'web-fetch'
          ? {
            toolId,
            status: 'degraded',
            reason: 'Tool is registered but has no executable handler.',
            executableShape: 'none',
          }
          : {
            toolId,
            status: 'ready',
            reason: 'Tool is registered and executable.',
            executableShape: 'execute',
          }),
      };

      const policy = orchestrator.buildToolPolicy({
        objective: 'Fetch https://example.com and verify the latest details.',
        executionProfile: 'default',
        toolManager,
        requestedToolIds: ['web-search', 'web-fetch', 'web-scrape'],
        toolEvents: [{
          toolCall: {
            function: {
              name: 'web-fetch',
              arguments: JSON.stringify({ url: 'https://example.com' }),
            },
          },
          result: {
            toolId: 'web-fetch',
            success: false,
            error: 'Tool web-fetch is unavailable: no executable handler',
          },
        }],
      });

      expect(policy.candidateToolIds).not.toContain('web-fetch');
      expect(policy.candidateToolIds).toEqual(expect.arrayContaining(['web-search', 'web-scrape']));
      expect(policy.readinessFiltered).toEqual(expect.arrayContaining([
        expect.objectContaining({ toolId: 'web-fetch', status: 'degraded' }),
      ]));
      expect(policy.decisionTrace.recoveryPolicies[0]).toEqual(expect.objectContaining({
        toolId: 'web-fetch',
        failureKind: 'unavailable_tool',
        nextAction: 'choose_alternate_ready_tool',
      }));
    } finally {
      config.runtime.judgmentV2Enabled = previousJudgmentFlag;
    }
  });
});
