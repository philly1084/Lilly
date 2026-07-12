'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../skills/skill-store', () => ({
  skillStore: {
    buildContext: jest.fn(),
  },
}));

jest.mock('../openai-client', () => ({
  createResponse: jest.fn(),
}));

jest.mock('../artifacts/artifact-service', () => ({
  extractResponseText: jest.fn(),
}));

jest.mock('../agent-sdk/tools', () => ({
  getToolManager: jest.fn(),
}));

const { skillStore } = require('../skills/skill-store');
const { createResponse } = require('../openai-client');
const { extractResponseText } = require('../artifacts/artifact-service');
const { getToolManager } = require('../agent-sdk/tools');
const skillsRouter = require('./skills');

describe('/api/skills routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getToolManager.mockReturnValue({
      initialize: jest.fn(async () => undefined),
      registry: {
        getFrontendTools: jest.fn(() => [
          {
            id: 'remote-command',
            name: 'Remote command',
            category: 'remote',
            description: 'Run a remote inspection command.',
            parameters: [{ name: 'command', required: true, description: 'Command to run' }],
          },
        ]),
      },
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/skills', skillsRouter);
    return app;
  }

  test('context response includes selected skill match metadata', async () => {
    skillStore.buildContext.mockReturnValue({
      block: '<registered_skills>\n<skill>\nid=remote-proof\n</skill>\n</registered_skills>',
      selectedSkills: [
        {
          id: 'remote-proof',
          name: 'Remote Proof',
          tools: ['remote-command'],
          callerContract: [
            'Read and follow the matched skill instructions before acting.',
            'Use matched tools only for concrete effects after the skill workflow is selected.',
            'Report the selected skill id and verification evidence in the handoff.',
          ],
          score: 9,
          reasons: ['tool affinity', 'surface web-chat'],
        },
      ],
    });

    const response = await request(buildApp())
      .get('/api/skills/context')
      .query({
        q: 'inspect the live web chat route',
        tools: 'remote-command',
        skills: 'remote-proof',
        surface: 'web-chat',
        taskType: 'remote-ops',
        capabilities: 'verification,logs',
        limit: '3',
      });

    expect(response.status).toBe(200);
    expect(skillStore.buildContext).toHaveBeenCalledWith({
      text: 'inspect the live web chat route',
      toolIds: ['remote-command'],
      selectedSkillIds: ['remote-proof'],
      limit: '3',
      surface: 'web-chat',
      taskType: 'remote-ops',
      capabilityNeeds: ['verification', 'logs'],
    });
    expect(response.body.data.context).toContain('remote-proof');
    expect(response.body.data.selectedSkills).toEqual([
      {
        id: 'remote-proof',
        name: 'Remote Proof',
        tools: ['remote-command'],
        callerContract: [
          'Read and follow the matched skill instructions before acting.',
          'Use matched tools only for concrete effects after the skill workflow is selected.',
          'Report the selected skill id and verification evidence in the handoff.',
        ],
        score: 9,
        reasons: ['tool affinity', 'surface web-chat'],
      },
    ]);
  });

  test('context accepts snake_case handoff query aliases', async () => {
    skillStore.buildContext.mockReturnValue({
      block: '<registered_skills>\n<skill>\nid=document-proof\n</skill>\n</registered_skills>',
      selectedSkills: [
        {
          id: 'document-proof',
          name: 'Document Proof',
          tools: ['document-workflow'],
          callerContract: [
            'Read and follow the matched skill instructions before acting.',
            'Use matched tools only for concrete effects after the skill workflow is selected.',
            'Report the selected skill id and verification evidence in the handoff.',
          ],
          score: 7,
          reasons: ['tool affinity', 'task artifact-review'],
          matchedTools: ['document-workflow'],
        },
      ],
    });

    const response = await request(buildApp())
      .get('/api/skills/context')
      .query({
        q: 'review the generated report artifact',
        tool_ids: 'document-workflow',
        skill_ids: 'document-proof',
        client_surface: 'web-cli',
        task_type: 'artifact-review',
        capability_needs: 'documents,verification',
        limit: '2',
      });

    expect(response.status).toBe(200);
    expect(skillStore.buildContext).toHaveBeenCalledWith({
      text: 'review the generated report artifact',
      toolIds: ['document-workflow'],
      selectedSkillIds: ['document-proof'],
      limit: '2',
      surface: 'web-cli',
      taskType: 'artifact-review',
      capabilityNeeds: ['documents', 'verification'],
    });
    expect(response.body.data.selectedSkills[0]).toEqual(expect.objectContaining({
      id: 'document-proof',
      matchedTools: ['document-workflow'],
      reasons: ['tool affinity', 'task artifact-review'],
    }));
  });

  test('draft accepts snake_case model fields for skill handoff metadata', async () => {
    createResponse.mockResolvedValue({ id: 'response-1' });
    extractResponseText.mockReturnValue(JSON.stringify({
      summary: 'Draft ready.',
      ready_for_approval: true,
      questions: [{
        id: 'scope',
        question: 'Which host should this inspect?',
        input_type: 'choice',
        options: ['production', 'staging'],
      }],
      draft: {
        id: 'remote-health-check',
        name: 'Remote Health Check',
        description: 'Check a remote service before changes.',
        body: 'Run a baseline, inspect logs, and report evidence.',
        tool_ids: ['remote-command', 'missing-tool'],
        trigger_patterns: ['remote health', 'service status'],
        context_policy: {
          max_chars: 2400,
          expose_body: false,
        },
      },
      rationale: 'Matches a remote command workflow.',
    }));

    const response = await request(buildApp())
      .post('/api/skills/draft')
      .send({ ask: 'Create a remote health check skill.' });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      summary: 'Draft ready.',
      readyForApproval: true,
      rationale: 'Matches a remote command workflow.',
    }));
    expect(response.body.data.questions[0]).toEqual(expect.objectContaining({
      inputType: 'choice',
      question: 'Which host should this inspect?',
    }));
    expect(response.body.data.draft).toEqual(expect.objectContaining({
      id: 'remote-health-check',
      tools: ['remote-command'],
      triggerPatterns: ['remote health', 'service status'],
      contextPolicy: {
        maxChars: 2400,
        exposeBody: false,
      },
    }));
  });

  test('draft keeps context size numeric when model metadata is invalid', async () => {
    createResponse.mockResolvedValue({ id: 'response-2' });
    extractResponseText.mockReturnValue(JSON.stringify({
      readyForApproval: true,
      draft: {
        name: 'Report Helper',
        contextPolicy: { maxChars: 'use the default' },
      },
    }));

    const response = await request(buildApp())
      .post('/api/skills/draft')
      .send({ ask: 'Create a report helper skill.' });

    expect(response.status).toBe(200);
    expect(response.body.data.draft.contextPolicy.maxChars).toBe(1800);
  });
});
