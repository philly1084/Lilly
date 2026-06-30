'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../skills/skill-store', () => ({
  skillStore: {
    buildContext: jest.fn(),
  },
}));

const { skillStore } = require('../skills/skill-store');
const skillsRouter = require('./skills');

describe('/api/skills routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function buildApp() {
    const app = express();
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
});
