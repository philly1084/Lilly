'use strict';

const { ToolBase } = require('../../ToolBase');

const ACTIONS = [
  'inspect-project',
  'inspect-scene',
  'apply-commands',
  'edit-blueprint',
  'run-playtest',
  'build',
  'publish',
  'rollback',
];

class GameStudioTool extends ToolBase {
  constructor() {
    super({
      id: 'game-studio',
      name: 'Lilly Game Studio',
      category: 'design',
      version: '1.0.0',
      description: 'Inspect and mutate durable Lilly Game Studio projects through revision-safe LillyCommand/v1 batches; validate Blueprints, playtest, build immutable browser players, publish, and roll back.',
      backend: {
        handler: async (params = {}, context = {}) => {
          const gameStudioService = context.gameStudioService;
          if (!gameStudioService?.isEnabled?.()) {
            const error = new Error('Lilly Game Studio is disabled or unavailable');
            error.code = 'GAME_STUDIO_UNAVAILABLE';
            throw error;
          }
          return gameStudioService.executeToolAction(params.action, params, context);
        },
        sideEffects: ['read', 'write', 'execute', 'network'],
        timeout: 120000,
      },
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ACTIONS },
          projectId: { type: 'string' },
          sceneId: { type: 'string' },
          buildId: { type: 'string' },
          baseRevision: { type: 'integer', minimum: 1 },
          revision: { type: 'integer', minimum: 1 },
          projectRevision: { type: 'integer', minimum: 1 },
          commands: { type: 'array', items: { type: 'object' }, maxItems: 100 },
          graph: { type: 'object' },
          prompt: { type: 'string' },
          publicHost: { type: 'string' },
          fixedSteps: { type: 'integer', minimum: 1, maximum: 3600 },
          sessionId: { type: 'string' },
        },
        additionalProperties: false,
      },
    });
  }
}

module.exports = {
  ACTIONS,
  GameStudioTool,
};
