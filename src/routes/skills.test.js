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
        score: 9,
        reasons: ['tool affinity', 'surface web-chat'],
      },
    ]);
  });
});
